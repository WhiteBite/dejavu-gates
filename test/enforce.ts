/**
 * Characterization tests for the harness-agnostic enforcement engine
 * (src/enforce.ts + siblings), exercised standalone — no OpenCode plugin
 * harness. Run: bun test/enforce.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editHeartbeatPath, touchHeartbeat } from "../src/fs"
import {
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
} from "../src/enforce"
import {
  bashSegmentSignatures,
  callSignature,
  canBlock,
  canRemind,
  detectFailure,
  hasGenericResidualIdentity,
  isIntendedNonzero,
  isNoiseError,
  isRepoLocal,
  nonTransparentProducers,
  normalizeCommand,
  normalizeFilePath,
  patternKey,
  REPEAT_PROCEED,
  sanitizeForStore,
  signRepeatedCall,
  suggestCorrection,
} from "../src/patterns"
import { claudeAdapter } from "../src/adapters/claude"
import { GateStore, GLOBAL_PROJECTS, PROMOTE_COUNT_PROBE, Stores, type Gate } from "../src/store"
import { repairGate } from "../src/validate"
import type { NormalizedEvent } from "../src/types"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

const tmp = await mkdtemp(join(tmpdir(), "dejavu-enforce-test-"))
process.env.DEJAVU_HOME = join(tmp, "dejavu-home")

interface World {
  stores: Stores
  ctx: EnforceContext
  projectDir: string
  projectStoreDir: string
  globalDir: string
}

function makeCtx(stores: Stores, projectDir: string): EnforceContext {
  return {
    stores,
    ephemeral: createEphemeralState(),
    log: () => {},
    onHookError: (where: string, error: unknown): void => {
      throw new Error(`engine hook error at ${where}: ${String(error)}`)
    },
    platform: process.platform,
    projectDir,
    iteratedVersionSupported: true,
  }
}

async function makeWorld(name: string): Promise<World> {
  const projectDir = join(tmp, `${name}-project`)
  const globalDir = join(tmp, `${name}-global`)
  const projectStoreDir = join(projectDir, ".opencode", "dejavu")
  await mkdir(projectStoreDir, { recursive: true })
  await mkdir(globalDir, { recursive: true })
  const stores = new Stores(new GateStore(globalDir), new GateStore(projectStoreDir))
  return { stores, ctx: makeCtx(stores, projectDir), projectDir, projectStoreDir, globalDir }
}

/** a fresh "process": new Stores + new ephemeral state over the same dirs on disk */
function respawn(world: World): EnforceContext {
  return makeCtx(new Stores(new GateStore(world.globalDir), new GateStore(world.projectStoreDir)), world.projectDir)
}

function readProjectGates(world: World): Promise<Gate[]> {
  return new GateStore(world.projectStoreDir).load()
}

function ev(overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, "tool" | "sessionId">): NormalizedEvent {
  return {
    harness: "opencode",
    phase: "pre",
    args: {},
    callId: null,
    cwd: null,
    output: null,
    exitCode: null,
    channel: "exit",
    raw: null,
    ...overrides,
  }
}

/** mechanical promotion: 3 failures across 2 distinct sessions, constant evidence (stuck) */
async function failUntilPromoted(stores: Stores, projectDir: string, command: string, sessions: [string, string]): Promise<string> {
  const signature = callSignature("bash", { command })
  if (signature === null) throw new Error(`no signature for command: ${command}`)
  const key = patternKey(signature)
  const plan: [string, number][] = [
    [sessions[0], 2],
    [sessions[1], 1],
  ]
  for (const [sessionID, times] of plan) {
    for (let i = 0; i < times; i++) {
      await stores.recordFailure({ key, signature, tool: "bash", sessionID, projectDir, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
    }
  }
  return key
}

// --- a. ungated call passes the before-hook ---
const a = await makeWorld("a")
const aOut = await enforceBefore(ev({ tool: "bash", sessionId: "a1", args: { command: "some-tool --do-thing" } }), a.ctx)
check("an ungated bash call is allowed", aOut.verdict.action === "allow" && aOut.verdict.reason === null)
check("an ungated call produces no enforcement signal", aOut.signalKind === null)

// --- b/c/d. blocking gate: reminder, then block, then override (one world, one gate) ---
const b = await makeWorld("b")
const bCmd = "some-tool --do-thing"
const bKey = await failUntilPromoted(b.stores, b.projectDir, bCmd, ["b-seed-1", "b-seed-2"])
const bGate0 = (await readProjectGates(b)).find((g) => g.key === bKey)
check("three failures across two sessions promote a non-diagnostic bash command to blocking", bGate0?.status === "blocking")

const bRemind = await enforceBefore(ev({ tool: "bash", sessionId: "b-live", args: { command: bCmd } }), b.ctx)
check("a blocking-gated call is denied on first encounter in a session", bRemind.verdict.action === "deny")
check("the first-encounter denial is a [dejavu] reminder", bRemind.signalKind === "reminder" && (bRemind.verdict.reason ?? "").startsWith("[dejavu] REMINDER"))
const bGate1 = (await readProjectGates(b)).find((g) => g.key === bKey)
check("the reminder persists on the gate for that session", bGate1?.remindedSessions?.["b-live"] !== undefined)

const bRetry = await enforceAfter(ev({ tool: "bash", sessionId: "b-live", args: { command: bCmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), b.ctx)
check("a failed retry after the reminder is recorded", bRetry.recorded === true)
const bGate2 = (await readProjectGates(b)).find((g) => g.key === bKey)
check("the failed retry lands in the gate's failed-sessions chain", bGate2?.failedSessions?.["b-live"] !== undefined)
const bBlock = await enforceBefore(ev({ tool: "bash", sessionId: "b-live", args: { command: bCmd } }), b.ctx)
check("a same-session retry after a failed reminder is hard-blocked", bBlock.verdict.action === "deny" && bBlock.signalKind === "block")
check("the hard block carries the BLOCKED message", (bBlock.verdict.reason ?? "").startsWith("[dejavu] BLOCKED"))

const bProceed = await enforceBefore(ev({ tool: "bash", sessionId: "b-live", args: { command: `${bCmd} # dejavu:proceed` } }), b.ctx)
check("dejavu:proceed bypasses an enforced gate", bProceed.verdict.action === "allow")
const bGate3 = (await readProjectGates(b)).find((g) => g.key === bKey)
check("the bypass is counted on the gate with its session", bGate3?.overrideCount === 1 && (bGate3?.overrideSessions ?? []).includes("b-live"))

// --- e. reminding tier: never interrupts, note rides the failing output once per session ---
const e = await makeWorld("e")
const eCmd = "grep needle src/haystack.ts"
const eKey = await failUntilPromoted(e.stores, e.projectDir, eCmd, ["e-seed-1", "e-seed-2"])
const eGate0 = (await readProjectGates(e)).find((g) => g.key === eKey)
check("three failures across two sessions promote a diagnostic command to reminding", eGate0?.status === "reminding")

const eBefore = await enforceBefore(ev({ tool: "bash", sessionId: "e-live", args: { command: eCmd } }), e.ctx)
check("a reminding gate never interrupts the call", eBefore.verdict.action === "allow" && eBefore.signalKind === null)
const eFail1 = await enforceAfter(ev({ tool: "bash", sessionId: "e-live", args: { command: eCmd }, phase: "post", output: "grep: src/haystack.ts: stream error", exitCode: 2, channel: "exit" }), e.ctx)
check("the first same-session failure on a reminding gate rides a [dejavu] NOTE", eFail1.recorded === true && (eFail1.annotation ?? "").includes("[dejavu] NOTE"))
const eFail2 = await enforceAfter(ev({ tool: "bash", sessionId: "e-live", args: { command: eCmd }, phase: "post", output: "grep: src/haystack.ts: stream error", exitCode: 2, channel: "exit" }), e.ctx)
check("the note rides once per session — the second same-session failure gets none", eFail2.recorded === true && eFail2.annotation === null)
const eGate1 = (await readProjectGates(e)).find((g) => g.key === eKey)
check("an ignored note accrues recurredAfterReminder", eGate1?.recurredAfterReminder === 1)
check("diagnostic recurrences are exempt from the recurredAfterGate metric", eGate1?.recurredAfterGate === 0)

// --- f. after-hook records a bash failure with an error line ---
const f = await makeWorld("f")
const fCmd = "weird-deploy-tool --explode"
const fOut = await enforceAfter(ev({ tool: "bash", sessionId: "f1", args: { command: fCmd }, phase: "post", output: "starting deploy\nError: kaboom happened", exitCode: 1, channel: "exit" }), f.ctx)
check("a non-diagnostic bash failure with an error line is recorded", fOut.recorded === true && fOut.annotation === null)
const fGate = (await readProjectGates(f)).find((g) => g.key === patternKey(callSignature("bash", { command: fCmd }) ?? ""))
check("the recorded failure lands as a gate in the project store", fGate !== undefined && fGate.count === 1 && fGate.status === "watching")
check("the gate keeps the failure-shaped line as evidence", fGate?.snippet === "Error: kaboom happened")
const fEvents = (await readFile(join(f.projectStoreDir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type?: string; harness?: string })
check("a detected event carries the harness that observed the failure", fEvents.some((e) => e.type === "detected" && e.harness === "opencode"))

// --- g. text-only failure detection (no exit code — the Claude Code case) ---
const g = await makeWorld("g")
const gCmd = "text-scan-tool --run"
const gOut = await enforceAfter(
  ev({ tool: "bash", sessionId: "g1", args: { command: gCmd }, phase: "post", output: "src/main.ts(10,3): error TS2304: Cannot find name 'foo'.", exitCode: null, channel: "text" }),
  g.ctx,
)
check("a failure-shaped output is recorded without an exit code", gOut.recorded === true)
const gGate = (await readProjectGates(g)).find((gate) => gate.key === patternKey(callSignature("bash", { command: gCmd }) ?? ""))
check("the text-detected failure lands as a gate with the error line", gGate?.count === 1 && gGate.snippet.includes("error TS2304"))

// --- g2. exit-channel evidence keeps full teeth: an exit-code failure promotes to blocking ---
const g2 = await makeWorld("g2")
const g2Cmd = "exit-channel-tool --prod"
for (const [session, times] of [["g2-seed-1", 2], ["g2-seed-2", 1]] as [string, number][]) {
  for (let i = 0; i < times; i++) {
    await enforceAfter(ev({ tool: "bash", sessionId: session, args: { command: g2Cmd }, phase: "post", output: "Error: kaboom", exitCode: 1, channel: "exit" }), g2.ctx)
  }
}
const g2Gate = (await readProjectGates(g2)).find((g) => g.key === patternKey(callSignature("bash", { command: g2Cmd }) ?? ""))
check("exit-code failures promote a non-diagnostic bash command to blocking", g2Gate?.status === "blocking")
check("an exit-channel promotion carries no textOnly flag", g2Gate?.textOnly === undefined)

// --- h. diagnostic exit 1 is the intended outcome, not a failure ---
const h = await makeWorld("h")
const hOut = await enforceAfter(ev({ tool: "bash", sessionId: "h1", args: { command: "grep needle src/haystack.ts" }, phase: "post", output: "", exitCode: 1, channel: "exit" }), h.ctx)
check("a diagnostic command's exit 1 is not recorded as a failure", hOut.recorded === false && hOut.annotation === null)
check("an intended-nonzero run leaves no gate behind", (await readProjectGates(h)).length === 0)

// --- i. success on an enforced gate heals and clears the session chain ---
const i = await makeWorld("i")
const iCmd = "heal-me-tool --run"
const iKey = await failUntilPromoted(i.stores, i.projectDir, iCmd, ["i-seed-1", "i-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "i-live", args: { command: iCmd } }), i.ctx)
const iGate0 = (await readProjectGates(i)).find((g) => g.key === iKey)
check("setup: the session is on the gate's remind chain", iGate0?.remindedSessions?.["i-live"] !== undefined)
const iOut = await enforceAfter(ev({ tool: "bash", sessionId: "i-live", args: { command: iCmd }, phase: "post", output: "all good", exitCode: 0, channel: "exit" }), i.ctx)
check("a success is not a recorded failure", iOut.recorded === false && iOut.annotation === null)
const iGate1 = (await readProjectGates(i)).find((g) => g.key === iKey)
check("a success on an enforced gate grows the heal streak", iGate1?.succeededAfterGate === 1)
check("a success clears the succeeding session from the remind chain", iGate1?.remindedSessions === undefined)

// --- j. cross-channel dedup: one call double-firing counts once ---
const j = await makeWorld("j")
const jCmd = "dedup-target-tool --run"
const jAfter = await enforceAfter(ev({ tool: "bash", sessionId: "j1", args: { command: jCmd }, phase: "post", output: "Error: kaboom", exitCode: 1, channel: "exit", callId: "j-call-after" }), j.ctx)
check("the after-hook channel records the failing call", jAfter.recorded === true)
await recordEventFailure(ev({ tool: "bash", sessionId: "j1", args: { command: jCmd }, phase: "post", output: "Error: kaboom", channel: "event", callId: "j-call-event" }), j.ctx)
const jGate = (await readProjectGates(j)).find((g) => g.key === patternKey(callSignature("bash", { command: jCmd }) ?? ""))
check("the same call arriving on the event channel within the dedup window records nothing", jGate?.count === 1)

// --- k. event channel: dedup by part, self-signal filter, noise filter ---
const k = await makeWorld("k")
const kArgs = { filePath: join(k.projectDir, "missing.py") }
await recordEventFailure(ev({ tool: "read", sessionId: "k1", args: kArgs, phase: "post", output: "ENOENT: no such file or directory", channel: "event", callId: "k-part-1" }), k.ctx)
const kGates1 = await readProjectGates(k)
check("a tool-level file failure from the event channel is recorded as a watching gate", kGates1.length === 1 && kGates1[0]?.count === 1 && kGates1[0]?.tool === "read" && kGates1[0]?.status === "watching")
await recordEventFailure(ev({ tool: "read", sessionId: "k1", args: kArgs, phase: "post", output: "ENOENT: no such file or directory", channel: "event", callId: "k-part-1" }), k.ctx)
check("the same message part is never counted twice", (await readProjectGates(k))[0]?.count === 1)
await recordEventFailure(ev({ tool: "read", sessionId: "k1", args: kArgs, phase: "post", output: "Error: boom\n[dejavu] REMINDER — echoed gate signal", channel: "event", callId: "k-part-2" }), k.ctx)
check("an echoed dejavu gate signal is not counted as a failure", (await readProjectGates(k))[0]?.count === 1)
await recordEventFailure(ev({ tool: "read", sessionId: "k1", args: kArgs, phase: "post", output: "Tool execution aborted", channel: "event", callId: "k-part-3" }), k.ctx)
check("an aborted execution is noise, not a failure", (await readProjectGates(k))[0]?.count === 1)
check("ignored event-channel payloads create no extra gates", (await readProjectGates(k)).length === 1)

// --- l. cleanupSession frees persisted session state and ephemeral maps ---
const l = await makeWorld("l")
const lCmd = "cleanup-tool --run"
const lKey = await failUntilPromoted(l.stores, l.projectDir, lCmd, ["l-seed-1", "l-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "l-live", args: { command: lCmd } }), l.ctx)
await enforceAfter(ev({ tool: "bash", sessionId: "l-live", args: { command: lCmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), l.ctx)
const lGate0 = (await readProjectGates(l)).find((g) => g.key === lKey)
check("setup: the session carries remind and failure state on the gate", lGate0?.remindedSessions?.["l-live"] !== undefined && lGate0?.failedSessions?.["l-live"] !== undefined)
l.ctx.ephemeral.repeatSeries.set("l-live", { key: "x", length: 3, logged: 0, blocked: 0, lastBlockAt: 0 })
l.ctx.ephemeral.repeatWindowLogged.set("l-live", 1)
await cleanupSession("l-live", l.ctx)
const lGate1 = (await readProjectGates(l)).find((g) => g.key === lKey)
check("cleanupSession drops the session from the persisted gate chains", lGate1?.remindedSessions === undefined && lGate1?.failedSessions === undefined)
check("cleanupSession drops the session from the ephemeral repeat maps", !l.ctx.ephemeral.repeatSeries.has("l-live") && !l.ctx.ephemeral.repeatWindowLogged.has("l-live"))

// --- m. proactive guard: foreground dev-server start ---
const m = await makeWorld("m")
const mGuard = await enforceBefore(ev({ tool: "bash", sessionId: "m1", args: { command: "npm run dev" } }), m.ctx)
check("a foreground dev-server start is denied without any gate", mGuard.verdict.action === "deny" && mGuard.signalKind === "guard")
check("the guard denial names the LONG-RUNNING class", (mGuard.verdict.reason ?? "").includes("[dejavu] LONG-RUNNING"))
const mProceed = await enforceBefore(ev({ tool: "bash", sessionId: "m1", args: { command: "npm run dev # dejavu:proceed" } }), m.ctx)
check("dejavu:proceed lets a deliberate foreground run through", mProceed.verdict.action === "allow")

// --- gw. guard bypass honors the marker inside a cmd /c wrapper ---
const gw = await makeWorld("gw")
const gwProceed = await enforceBefore(ev({ tool: "bash", sessionId: "gw1", args: { command: 'cmd /c "vite # dejavu:proceed"' } }), gw.ctx)
check("a dejavu:proceed inside a cmd /c wrapper is not guard-blocked", gwProceed.verdict.action === "allow" && gwProceed.signalKind === null)
const gwPlain = await enforceBefore(ev({ tool: "bash", sessionId: "gw2", args: { command: 'cmd /c "vite"' } }), gw.ctx)
check("a cmd /c wrapper without the marker is still guard-blocked", gwPlain.signalKind === "guard")

// --- n. ephemeral degradation: the chain lives on the gate, not in process memory ---
const n = await makeWorld("n")
const nCmd = "chain-state-tool --run"
await failUntilPromoted(n.stores, n.projectDir, nCmd, ["n-seed-1", "n-seed-2"])
const nRemind = await enforceBefore(ev({ tool: "bash", sessionId: "n-live", args: { command: nCmd } }), respawn(n))
check("one process gets the reminder", nRemind.signalKind === "reminder")
const nFail = await enforceAfter(ev({ tool: "bash", sessionId: "n-live", args: { command: nCmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), respawn(n))
check("a second process with fresh ephemeral state records the failed retry", nFail.recorded === true)
const nBlock = await enforceBefore(ev({ tool: "bash", sessionId: "n-live", args: { command: nCmd } }), respawn(n))
check("a third process hard-blocks the repeat — the chain survives fresh ephemeral state", nBlock.verdict.action === "deny" && nBlock.signalKind === "block")

// --- ig. iteration grace: only a LANDED edit/write lifts the hard block ---
const ig = await makeWorld("ig")
const igCmd = "iter-grace-tool --run"
await failUntilPromoted(ig.stores, ig.projectDir, igCmd, ["ig-seed-1", "ig-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "ig-live", args: { command: igCmd } }), ig.ctx)
await enforceAfter(ev({ tool: "bash", sessionId: "ig-live", args: { command: igCmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), ig.ctx)
const igGate0 = (await readProjectGates(ig)).find((g) => g.key === patternKey(callSignature("bash", { command: igCmd }) ?? ""))
check("setup: the failed retry armed the block chain", igGate0?.failedSessions?.["ig-live"] !== undefined)
await enforceAfter(ev({ tool: "edit", sessionId: "ig-live", args: { filePath: join(ig.projectDir, "src", "x.ts") }, phase: "post", output: "Error: edit rejected", exitCode: null, channel: "text", errored: true }), ig.ctx)
const igBlock = await enforceBefore(ev({ tool: "bash", sessionId: "ig-live", args: { command: igCmd } }), ig.ctx)
check("a FAILED edit (errored signal) does not lift the hard block", igBlock.verdict.action === "deny" && igBlock.signalKind === "block")

const ig2 = await makeWorld("ig2")
const ig2Cmd = "iter-grace-ok-tool --run"
await failUntilPromoted(ig2.stores, ig2.projectDir, ig2Cmd, ["ig2-seed-1", "ig2-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "ig2-live", args: { command: ig2Cmd } }), ig2.ctx)
await enforceAfter(ev({ tool: "bash", sessionId: "ig2-live", args: { command: ig2Cmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), ig2.ctx)
await enforceAfter(ev({ tool: "edit", sessionId: "ig2-live", args: { filePath: join(ig2.projectDir, "src", "x.ts") }, phase: "post", output: "ok", exitCode: null, channel: "text" }), ig2.ctx)
const ig2Retry = await enforceBefore(ev({ tool: "bash", sessionId: "ig2-live", args: { command: ig2Cmd } }), ig2.ctx)
check("a landed edit still grants the iteration retry (grace preserved)", ig2Retry.verdict.action === "allow")

const ig3 = await makeWorld("ig3")
const ig3Cmd = "iter-grace-exit-tool --run"
await failUntilPromoted(ig3.stores, ig3.projectDir, ig3Cmd, ["ig3-seed-1", "ig3-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "ig3-live", args: { command: ig3Cmd } }), ig3.ctx)
await enforceAfter(ev({ tool: "bash", sessionId: "ig3-live", args: { command: ig3Cmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), ig3.ctx)
await enforceAfter(ev({ tool: "edit", sessionId: "ig3-live", args: { filePath: join(ig3.projectDir, "src", "x.ts") }, phase: "post", output: "Error: edit rejected", exitCode: 1, channel: "exit" }), ig3.ctx)
const ig3Block = await enforceBefore(ev({ tool: "bash", sessionId: "ig3-live", args: { command: ig3Cmd } }), ig3.ctx)
check("a failing-exit edit does not lift the hard block either", ig3Block.verdict.action === "deny" && ig3Block.signalKind === "block")

// --- hbl. legacy bare-number failedSessions coerce at load, so the heartbeat grace applies ---
const hbl = await makeWorld("hbl")
const hblCmd = "legacy-failed-tool --run"
await failUntilPromoted(hbl.stores, hbl.projectDir, hblCmd, ["hbl-seed-1", "hbl-seed-2"])
await enforceBefore(ev({ tool: "bash", sessionId: "hbl-live", args: { command: hblCmd } }), hbl.ctx)
await enforceAfter(ev({ tool: "bash", sessionId: "hbl-live", args: { command: hblCmd }, phase: "post", output: "Error: boom", exitCode: 1, channel: "exit" }), hbl.ctx)
const hblGatePath = join(hbl.projectStoreDir, "gates.json")
const hblKey = patternKey(callSignature("bash", { command: hblCmd }) ?? "")
const hblFile = JSON.parse(await readFile(hblGatePath, "utf8")) as { gates: Array<{ key: string; failedSessions?: Record<string, unknown> }> }
const hblGate = hblFile.gates.find((g) => g.key === hblKey)
if (hblGate === undefined) throw new Error("hbl: gate not found after promotion")
hblGate.failedSessions = { "hbl-live": Date.now() - 5000 }
await writeFile(hblGatePath, JSON.stringify(hblFile), "utf8")
await touchHeartbeat(editHeartbeatPath(hbl.projectStoreDir))
const hblRetry = await enforceBefore(ev({ tool: "bash", sessionId: "hbl-live", args: { command: hblCmd } }), respawn(hbl))
check("a legacy numeric failedSessions entry gets the heartbeat grace after coercion", hblRetry.verdict.action === "allow")

// --- iv. iteratedVersion is host-opt-in: an unsupported host never stamps the process-local counter ---
const iv = await makeWorld("iv")
const ivSig = callSignature("bash", { command: "iter-version-tool --run" }) ?? ""
const ivKey = patternKey(ivSig)
await iv.stores.recordFailure({ key: ivKey, signature: ivSig, tool: "bash", sessionID: "iv-1", projectDir: iv.projectDir, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
const ivAbsent = (await readProjectGates(iv)).find((g) => g.key === ivKey)
check("recordFailure without a workspaceVersion leaves iteratedVersion unstamped", ivAbsent?.iteratedVersion === undefined)
await iv.stores.recordFailure({ key: ivKey, signature: ivSig, tool: "bash", sessionID: "iv-1", projectDir: iv.projectDir, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS, workspaceVersion: 5 })
const ivSet = (await readProjectGates(iv)).find((g) => g.key === ivKey)
check("recordFailure with a real workspaceVersion stamps iteratedVersion", ivSet?.iteratedVersion === 5)

// --- ws2. file signatures are repo-relative: one file, one key ---
const ws2 = await makeWorld("ws2")
const ws2Abs = join(ws2.projectDir, "src", "missing.ts")
await enforceAfter(
  ev({ tool: "read", sessionId: "ws2-1", args: { filePath: ws2Abs }, phase: "post", output: "ENOENT: no such file or directory", exitCode: 1, channel: "exit" }),
  ws2.ctx,
)
check("enforceAfter signs an in-repo read repo-relatively", (await readProjectGates(ws2)).some((g) => g.signature === "read:src/missing.ts"))

const ws2Evt = await makeWorld("ws2-evt")
await recordEventFailure(
  ev({ tool: "read", sessionId: "ws2-2", args: { filePath: join(ws2Evt.projectDir, "src", "missing.ts") }, phase: "post", output: "ENOENT: no such file or directory", channel: "event", callId: "ws2-part" }),
  ws2Evt.ctx,
)
check("recordEventFailure signs an in-repo read repo-relatively", (await readProjectGates(ws2Evt)).some((g) => g.signature === "read:src/missing.ts"))

const ws2Dirs = await makeWorld("ws2-dirs")
const ws2SrcPath = join(ws2Dirs.projectDir, "src", "missing.ts")
const ws2LibPath = join(ws2Dirs.projectDir, "lib", "missing.ts")
await recordEventFailure(
  ev({ tool: "read", sessionId: "ws2-3", args: { filePath: ws2SrcPath }, phase: "post", output: "ENOENT", channel: "event", callId: "ws2-src" }),
  ws2Dirs.ctx,
)
check("the event channel records an in-repo read under its repo-relative key", (await readProjectGates(ws2Dirs)).some((g) => g.key === patternKey("read:src/missing.ts")))
check(
  "same basename in different dirs yields distinct signatures",
  callSignature("read", { filePath: ws2SrcPath }, ws2Dirs.projectDir) === "read:src/missing.ts" &&
    callSignature("read", { filePath: ws2LibPath }, ws2Dirs.projectDir) === "read:lib/missing.ts",
)

check("windows separators normalize to one repo-relative signature", normalizeFilePath("src\\missing.ts", ws2.projectDir) === "src/missing.ts")
check(
  "relative and absolute spellings of one file converge",
  normalizeFilePath("src/missing.ts", ws2.projectDir) === normalizeFilePath(ws2Abs, ws2.projectDir) &&
    normalizeFilePath(ws2Abs, ws2.projectDir) === "src/missing.ts",
)
check("absolute path outside the repo falls back to basename", normalizeFilePath(join(tmp, "elsewhere", "leak.ts"), ws2.projectDir) === "leak.ts")
check("missing projectDir falls back to basename", normalizeFilePath("src/missing.ts") === "missing.ts")
check("no absolute path reaches a signature", callSignature("read", { filePath: ws2Abs }, ws2.projectDir) === "read:src/missing.ts")

check("isRepoLocal is bash-only", isRepoLocal("read:src/git/x.ts") === false && isRepoLocal("bash:git status") === true)

// --- wl. package-runner canonicalization: one script, one key across runners ---
check(
  "explicit run forms converge across npm/pnpm/yarn/bun",
  normalizeCommand("npm run build") === "run build" &&
    normalizeCommand("pnpm run build") === "run build" &&
    normalizeCommand("yarn run build") === "run build" &&
    normalizeCommand("bun run build") === "run build",
)
check(
  "binary-exec runners converge on npx",
  normalizeCommand("npx tsc --noEmit") === "npx tsc --noemit" &&
    normalizeCommand("pnpm dlx tsc --noEmit") === "npx tsc --noemit" &&
    normalizeCommand("pnpm exec tsc --noEmit") === "npx tsc --noemit" &&
    normalizeCommand("yarn dlx tsc --noEmit") === "npx tsc --noemit" &&
    normalizeCommand("bunx tsc --noEmit") === "npx tsc --noemit",
)
check("a bare builtin stays distinct from its explicit run form", normalizeCommand("pnpm install") !== normalizeCommand("pnpm run install"))
check("bare `pnpm test` is not canonicalized (ambiguous builtin)", normalizeCommand("pnpm test") === "pnpm test")
check("`run build` stays distinct from `npm test`", normalizeCommand("npm run build") !== normalizeCommand("npm test"))
check("canonical run typecheck stays remind-only, never blocking", canRemind("bash", "bash:run typecheck") && !canBlock("bash", "bash:run typecheck"))
check("canonical run build keeps blocking teeth", canBlock("bash", "bash:run build"))
check("canonical run test still reminds (script arg is identity)", canRemind("bash", "bash:run test"))
check("canonical run <str> stays a family (no identity)", !canBlock("bash", "bash:run <str>") && !canRemind("bash", "bash:run <str>"))
check("mixed chain with a diagnostic tail stays block-eligible", canBlock("bash", "bash:run build && ls"))
check("canonical package scripts stay repo-local", isRepoLocal("bash:run build") && isRepoLocal("bash:npx tsc --noemit"))

// --- ws1. generic (unknown) tool signatures: deterministic, remind-only ---
const gcA = callSignature("mcp__srv__tool", { z: 2, a: 1 })
const gcB = callSignature("mcp__srv__tool", { a: 1, z: 2 })
check("an unknown tool produces a non-null signature", gcA !== null && gcA !== "")
check("key order does not change the generic signature", gcA === gcB)
check("an all-numeric generic shape has no residual identity", hasGenericResidualIdentity(gcA ?? "") === false)
check("an over-generic generic shape never reminds", !canRemind("mcp__srv__tool", gcA ?? ""))

const gcParam = callSignature("mcp__srv__tool", { u: "https://x.example/a", id: "550e8400-e29b-41d4-a716-446655440000", n: 42 })
check("urls, uuids and numbers are parameterized in generic values", (gcParam ?? "").includes("<url>") && (gcParam ?? "").includes("<uuid>") && (gcParam ?? "").includes("<n>"))
check("a fully parameterized generic shape has no residual identity", !hasGenericResidualIdentity(gcParam ?? ""))

const shapeDel = callSignature("mcp__srv__tool", { action: "delete", id: 7 })
const shapeDelReordered = callSignature("mcp__srv__tool", { id: 9, action: "delete" })
const shapeCreate = callSignature("mcp__srv__tool", { action: "create", id: 7 })
check("distinct literal values yield distinct generic keys", shapeDel !== shapeCreate)
check("identical shapes converge regardless of key order and id value", shapeDel === shapeDelReordered)
check("a surviving literal grants generic residual identity", hasGenericResidualIdentity(shapeDel ?? ""))
check("generic tools can remind but never block", canRemind("mcp__srv__tool", shapeDel ?? "") && !canBlock("mcp__srv__tool", shapeDel ?? ""))

// promotion: PROMOTE_COUNT_PROBE failures across 2 sessions -> reminding, never blocking
const gen = await makeWorld("gen")
const genSig = callSignature("mcp__srv__tool", { action: "delete", id: 7 })
if (genSig === null) throw new Error("generic signature unexpectedly null")
const genKey = patternKey(genSig)
const genPlan: [string, number][] = [["gen-seed-1", PROMOTE_COUNT_PROBE - 2], ["gen-seed-2", 2]]
for (const [sessionID, times] of genPlan) {
  for (let i = 0; i < times; i++) {
    await gen.stores.recordFailure({ key: genKey, signature: genSig, tool: "mcp__srv__tool", sessionID, projectDir: gen.projectDir, snippet: "Error: mcp tool exploded", globalProjects: GLOBAL_PROJECTS })
  }
}
const genGate = (await readProjectGates(gen)).find((g) => g.key === genKey)
check("a generic tool promotes to reminding at the probe bar across 2 sessions", genGate?.status === "reminding")
check("a generic tool never promotes to blocking", genGate?.status !== "blocking")

// over-generic shape (all values parameterized away) stays watching past the bar
const og = await makeWorld("og")
const ogSig = callSignature("spawn_agent", { n: 1, m: 2 })
if (ogSig === null) throw new Error("generic signature unexpectedly null")
const ogKey = patternKey(ogSig)
for (const [sessionID, times] of [["og-seed-1", PROMOTE_COUNT_PROBE - 2], ["og-seed-2", 2]] as [string, number][]) {
  for (let i = 0; i < times; i++) {
    await og.stores.recordFailure({ key: ogKey, signature: ogSig, tool: "spawn_agent", sessionID, projectDir: og.projectDir, snippet: "Error: spawn failed", globalProjects: GLOBAL_PROJECTS })
  }
}
const ogGate = (await readProjectGates(og)).find((g) => g.key === ogKey)
check("an over-generic generic shape stays watching past the probe bar", ogGate?.status === "watching")

// recordable through enforceAfter (exit and text channels) and recordEventFailure
const ga = await makeWorld("ga")
const gaExit = await enforceAfter(ev({ tool: "mcp__srv__tool", sessionId: "ga1", args: { action: "delete", id: 7 }, phase: "post", output: "starting\nError: mcp tool exploded", exitCode: 1, channel: "exit" }), ga.ctx)
check("enforceAfter records a generic failure via the exit channel", gaExit.recorded === true && (await readProjectGates(ga)).some((g) => g.tool === "mcp__srv__tool" && g.count === 1))

const gb = await makeWorld("gb")
const gbText = await enforceAfter(ev({ tool: "mcp__srv__tool", sessionId: "gb1", args: { action: "delete", id: 7 }, phase: "post", output: "Error: mcp tool exploded", exitCode: null, channel: "text" }), gb.ctx)
check("enforceAfter records a generic failure via the text channel (no exit code)", gbText.recorded === true && (await readProjectGates(gb)).some((g) => g.tool === "mcp__srv__tool" && g.count === 1))

const gc = await makeWorld("gc")
await recordEventFailure(ev({ tool: "mcp__srv__tool", sessionId: "gc1", harness: "claude", args: { action: "delete", id: 7 }, phase: "post", output: "Error: mcp tool exploded", channel: "event", callId: "gc-part" }), gc.ctx)
check("recordEventFailure records a generic tool failure", (await readProjectGates(gc)).some((g) => g.tool === "mcp__srv__tool" && g.count === 1))
const gcEvents = (await readFile(join(gc.projectStoreDir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type?: string; harness?: string })
check("the event-channel detected event carries the observing harness", gcEvents.some((e) => e.type === "detected" && e.harness === "claude"))

const circular: unknown[] = []
circular.push(circular)
const circularSig = callSignature("mcp__srv__tool", { action: "delete", item: circular })
check("a circular array argument collapses instead of overflowing the stack", circularSig !== null && circularSig.includes("item=<list>"))

const wideList = Array.from({ length: 5000 }, (_, i) => `value-${i}`)
const wideListSig = callSignature("mcp__srv__tool", { action: "delete", items: wideList })
check("a wide array argument collapses to <list> and bounds the signature", wideListSig !== null && wideListSig.includes("items=<list>") && wideListSig.length < 500)

const wideObject: Record<string, unknown> = {}
for (let i = 0; i < 200; i++) wideObject[`key${i}`] = `value-${i}`
const wideObjectSig = callSignature("mcp__srv__tool", { action: "delete", payload: wideObject })
check("a wide object argument collapses to <obj> and bounds the signature", wideObjectSig !== null && wideObjectSig.includes("payload=<obj>") && wideObjectSig.length < 500)

const gd = await makeWorld("gd")
const gdOut = await enforceAfter(ev({ tool: "mcp__srv__tool", sessionId: "gd1", args: { action: "delete", id: 7 }, phase: "post", output: "Error: previous run failed", exitCode: 0, channel: "exit" }), gd.ctx)
check("a successful generic call with failure-shaped output is not recorded", gdOut.recorded === false && (await readProjectGates(gd)).length === 0)

// a secret carried in an argument KEY must not reach the signature
const keySecretSig = callSignature("mcp__t__x", { ["authorization_bearer_" + "sk-ant-abc123"]: 1 })
check("an arg-key secret is scrubbed from the generic signature", keySecretSig !== null && !keySecretSig.includes("sk-ant-abc123"))

// an argless generic tool has no call identity — the error text signs it (mirrors the event channel)
const ge = await makeWorld("ge")
const geOut = await enforceAfter(ev({ tool: "mcp__srv__reboot", sessionId: "ge1", phase: "post", output: "Error: reboot failed", exitCode: null, channel: "text" }), ge.ctx)
const geGate = (await readProjectGates(ge)).find((g) => g.tool === "mcp__srv__reboot")
check("an argless generic failure is recorded under a tool-error signature", geOut.recorded === true && geGate !== undefined && geGate.signature.startsWith("mcp__srv__reboot:tool-error:"))
check("the tool-error fallback gate stays watch-only (no residual identity)", geGate?.status === "watching")

// a successful generic result is CONTENT, not failure evidence — the adapter must not feed it
const ge2 = await makeWorld("ge2")
const claudeGenericOk = claudeAdapter.mapInbound("post", { hook_event_name: "PostToolUse", tool_name: "mcp__srv__reboot", tool_input: { action: "status" }, session_id: "ge2-1", tool_response: "TypeError: cannot read properties of undefined" })
if (claudeGenericOk === null) throw new Error("claude generic post unexpectedly null")
const ge2Out = await enforceAfter(claudeGenericOk, ge2.ctx)
check("a successful generic result with failure-shaped content is not recorded", ge2Out.recorded === false && (await readProjectGates(ge2)).length === 0)
check("the adapter drops successful generic content (output null)", claudeGenericOk.output === null)
const claudeGenericErr = claudeAdapter.mapInbound("post", { hook_event_name: "PostToolUseFailure", tool_name: "mcp__srv__reboot", tool_input: { action: "status" }, session_id: "ge2-1", error: "Error: reboot failed" })
if (claudeGenericErr === null) throw new Error("claude generic failure post unexpectedly null")
const ge2ErrOut = await enforceAfter(claudeGenericErr, ge2.ctx)
check("an error-signalled generic result is still recorded", ge2ErrOut.recorded === true)

// file probes keep their dedicated signatures and stay non-enforcing
check("file probes are not generic (dedicated signature shape)", callSignature("read", { filePath: "src/x.ts" }, gc.projectDir) === "read:src/x.ts" && !canRemind("read", "read:src/x.ts") && !canBlock("read", "read:src/x.ts"))

// --- pe. probe tools: the host's structural errored signal records the failure ---
const pe = await makeWorld("pe")
const peOut = await enforceAfter(
  ev({ tool: "read", sessionId: "pe1", args: { filePath: join(pe.projectDir, "src", "missing.ts") }, phase: "post", output: "File does not exist: src/missing.ts", exitCode: null, channel: "text", errored: true }),
  pe.ctx,
)
check("an errored probe with no exit code records a failure", peOut.recorded === true)
const peGate = (await readProjectGates(pe)).find((g) => g.signature === "read:src/missing.ts")
check("the probe failure lands under its file signature with the tool's own error text", peGate !== undefined && peGate.count === 1 && peGate.snippet === "File does not exist: src/missing.ts")

const pe2 = await makeWorld("pe2")
const pe2Out = await enforceAfter(
  ev({ tool: "read", sessionId: "pe2", args: { filePath: join(pe2.projectDir, "src", "missing.ts") }, phase: "post", output: "File does not exist: src/missing.ts", exitCode: null, channel: "text", errored: false }),
  pe2.ctx,
)
check("a probe with a falsy errored signal records nothing", pe2Out.recorded === false && (await readProjectGates(pe2)).length === 0)

// --- rs. repeat-channel log keys are sanitized before persistence ---
const rs = await makeWorld("rs")
const rsCommand = "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456' https://api.example.com/v1/data"
rs.ctx.ephemeral.repeatSeries.set("rs-block", { key: signRepeatedCall("bash", { command: rsCommand }), length: 2, logged: 0, blocked: 0, lastBlockAt: 0 })
const rsBlock = await enforceBefore(ev({ tool: "bash", sessionId: "rs-block", args: { command: rsCommand } }), rs.ctx)
check("a live tail series at the threshold is repeat-blocked", rsBlock.signalKind === "repeat")
const rsBlockReason = rsBlock.verdict.reason ?? ""
check(
  "a bash repeat-block message carries bash-family advice, not other tools' reader params or a provider brand",
  !rsBlockReason.includes("since_message_id") && !rsBlockReason.includes("DashScope") && rsBlockReason.includes("the provider hard-rejects") && rsBlockReason.includes("change the command or its args"),
)
rs.ctx.ephemeral.repeatSeries.set("rs-override", { key: signRepeatedCall("bash", { command: rsCommand }), length: 2, logged: 0, blocked: 0, lastBlockAt: 0 })
const rsOverride = await enforceBefore(ev({ tool: "bash", sessionId: "rs-override", args: { command: rsCommand, [REPEAT_PROCEED]: true } }), rs.ctx)
check("the repeat override falls through to gate processing", rsOverride.verdict.action === "allow")
const rsProjectLog = await readFile(join(rs.projectStoreDir, "log.jsonl"), "utf8")
const rsGlobalLog = await readFile(join(rs.globalDir, "log.jsonl"), "utf8").catch(() => "")
const rsLogText = `${rsProjectLog}\n${rsGlobalLog}`
check("repeat-channel log events exist for both paths", rsLogText.includes('"repeat-blocked"') && rsLogText.includes('"repeat-override"'))
check("repeat-channel log keys never carry the secret", !rsLogText.includes("eyJhbGci"))
const rsEvents = rsProjectLog.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type?: string; session?: string })
check("a bypassed repeat series logs a repeat-override event", rsEvents.some((e) => e.type === "repeat-override" && e.session === "rs-override"))
check("the repeat bypass never logs a gate-level override event", rsEvents.every((e) => e.type !== "override"))
check("repeat-override stays project-local (not mirrored to the global log)", !rsGlobalLog.includes('"repeat-override"'))

rs.ctx.ephemeral.repeatSeries.set("rs-comment", { key: signRepeatedCall("bash", { command: rsCommand }), length: 2, logged: 0, blocked: 0, lastBlockAt: 0 })
const rsComment = await enforceBefore(ev({ tool: "bash", sessionId: "rs-comment", args: { command: `${rsCommand} # dejavu:proceed` } }), rs.ctx)
check("the comment-form bypass is allowed, not repeat-blocked", rsComment.verdict.action === "allow")
await rs.stores.flushDeferredAll()
const rsCommentLog = await readFile(join(rs.projectStoreDir, "log.jsonl"), "utf8")
const rsCommentEvents = rsCommentLog.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type?: string; session?: string; key?: string })
check("the comment-form bypass is recognized as an override of its live series", rsCommentEvents.some((e) => e.type === "repeat-override" && e.session === "rs-comment"))
check("the comment-form override logs the plain-command series key without the secret", rsCommentEvents.some((e) => e.type === "repeat-override" && e.session === "rs-comment" && e.key === sanitizeForStore(`bash:{"command":"${rsCommand}"}`).slice(0, 80)) && !rsCommentLog.includes("eyJhbGci"))

// --- om. a bare marker is data, not a bypass — it must not collapse signatures ---
check("a bare marker as data does not collapse onto the unmarked signature", callSignature("bash", { command: "grep dejavu:proceed file.txt" }) !== callSignature("bash", { command: "grep file.txt" }))

// --- au. audit follow-ups: normalization identity, immunity, noise tiers ---
check(
  "URLs converge to one <url> family token across hosts and schemes",
  normalizeCommand("git clone https://github.com/a/b") === "git clone <url>" && normalizeCommand("git clone http://gitlab.com/c/d.git") === "git clone <url>",
)
check("wget URLs converge too", normalizeCommand("wget https://a.io/x.tar") === "wget <url>")
check("interpreter one-liners fingerprint per script", callSignature("bash", { command: 'bash -c "deploy --prod --force"' }) !== callSignature("bash", { command: 'bash -c "echo a"' }))
check("eval with a fully parameterized payload never blocks", canBlock("bash", "bash:eval <str>") === false && canRemind("bash", "bash:eval <str>") === false)
check(
  "versioned interpreters keep per-script identity",
  callSignature("bash", { command: 'python3.11 -c "print(1)"' }) !== callSignature("bash", { command: 'python3.12 -c "print(2)"' }),
)
check(
  "a chain's second one-liner fingerprints too",
  callSignature("bash", { command: 'python -c "print(1)" && node -e "console.log(2)"' }) !== callSignature("bash", { command: 'python -c "print(1)" && node -e "console.log(99999)"' }),
)
check("node --eval canonicalizes onto -e", normalizeCommand("node --eval X") === normalizeCommand("node -e X"))
check(
  "$(…) substitutions keep exit-1 immunity while subshells still split",
  isIntendedNonzero("grep -r TODO $(find src -name '*.ts')") === true && isIntendedNonzero("tsc $(cat files.txt)") === true && isIntendedNonzero("(deploy --prod && grep ok log.txt)") === false,
)
check(
  "cmd /c wrappers delegate exit-1 immunity and count expanded producers",
  isIntendedNonzero('cmd /c "grep foo bar.txt"') === true && isIntendedNonzero('pwsh -Command "Select-String foo bar.txt"') === true && nonTransparentProducers('cmd /c "grep foo bar.txt && deploy.sh"') === 2,
)
check("bun and deno test are diagnostics", isIntendedNonzero("bun test") === true && isIntendedNonzero("deno test") === true)
check("a success-shaped line is never failure evidence", detectFailure("All tests passed - panic: none").matched === false)
check(
  "client-side HTTP and MCP errors stay teachable, server-side stay noise",
  isNoiseError("non-2xx status code: 404 Not Found") === false && isNoiseError("MCP error -32602: Invalid params") === false && isNoiseError("non-2xx status code: 502 Bad Gateway") === true && isNoiseError("MCP error: connection closed") === true,
)
check("trailing comments converge with the bare command", normalizeCommand("npm test # verify everything") === normalizeCommand("npm test") && normalizeCommand("npm test") === "run test")
check("a quoted # is data, not a comment", normalizeCommand('grep "#include" file.ts') === "grep  <str>  file.ts".replace(/\s+/g, " "))
check("backtick-escaped quotes keep the chain split", bashSegmentSignatures('echo "a `" b" && deploy.sh').length === 2)
check("uuid arguments parameterize instead of fragmenting", normalizeCommand("mytool 550e8400-e29b-41d4-a716-446655440000") === "mytool <uuid>")

// policy repair inherits the generic tiers: blocking generic -> reminding, identity-less -> watching
const repairSeed = (signature: string): Gate =>
  ({ key: "repair-generic", signature, tool: "mcp__srv__tool", status: "blocking", count: 5, sessions: ["a", "b"], projects: [], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), snippet: "Error: boom", remindedCount: 0, blockedCount: 0, recurredAfterReminder: 0, recurredAfterGate: 0, overrideCount: 0 }) as Gate
const repairHasIdentity = repairSeed("mcp__srv__tool:action=delete")
repairGate(repairHasIdentity)
check("repairGate demotes an out-of-policy blocking generic gate to reminding", repairHasIdentity.status === "reminding")
const repairNoIdentity = repairSeed("mcp__srv__tool:a=<n>")
repairGate(repairNoIdentity)
check("repairGate demotes an identity-less generic gate to watching", repairNoIdentity.status === "watching")

// AUTO template corrections survive both dash generations: a hyphen-dash legacy record re-derives like the em-dash one
const autoDashSig = "bash:deploy <str>"
const autoDashSeed = (correction: string): Gate => ({ ...repairSeed(autoDashSig), correction })
const autoHyphen = autoDashSeed('Last error: "Error: boom" - address that specific error before retrying this exact call.')
check(
  "repairGate re-derives a hyphen-dashed AUTO template correction and stamps machine origin",
  repairGate(autoHyphen) === true &&
    autoHyphen.correction === suggestCorrection(autoDashSig, "Error: boom") &&
    autoHyphen.correctionOrigin === "machine",
)
const autoEmDash = autoDashSeed('Last error: "Error: boom" — address that specific error before retrying this exact call.')
check("the em-dash AUTO template still re-derives after the flex", repairGate(autoEmDash) === true && autoEmDash.correction === suggestCorrection(autoDashSig, "Error: boom"))

// legacy bare-number failedSessions entries coerce to {t, v:0} at the repair boundary
const legacyFailedAt = Date.now() - 1000
const legacyFailed = repairSeed("bash:legacy-failed-unit --run")
legacyFailed.failedSessions = { kept: legacyFailedAt, dropped: -5 }
check("repairGate coerces a legacy numeric failedSessions entry to {t, v:0}", repairGate(legacyFailed) === true && typeof legacyFailed.failedSessions?.kept === "object" && legacyFailed.failedSessions.kept.t === legacyFailedAt && legacyFailed.failedSessions.kept.v === 0)
check("repairGate drops a non-positive numeric failedSessions entry", legacyFailed.failedSessions?.dropped === undefined)

await rm(tmp, { recursive: true, force: true })

report()
