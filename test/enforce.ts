/**
 * Characterization tests for the harness-agnostic enforcement engine
 * (src/enforce.ts + siblings), exercised standalone — no OpenCode plugin
 * harness. Run: bun test/enforce.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
} from "../src/enforce"
import { callSignature, patternKey } from "../src/patterns"
import { GateStore, GLOBAL_PROJECTS, Stores, type Gate } from "../src/store"
import type { NormalizedEvent } from "../src/types"

let failures = 0
function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`ok   - ${name}`)
  } else {
    failures += 1
    console.error(`FAIL - ${name}`)
  }
}

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
l.ctx.ephemeral.repeatSeries.set("l-live", { key: "x", length: 3, logged: 0, blocked: 0 })
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

await rm(tmp, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
