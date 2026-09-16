/**
 * Behavioral smoke test for the dejavu state machine.
 * Run: bun test/smoke.ts
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Dejavu } from "../index"
import {
  bashSegmentSignatures,
  callSignature,
  canBlock,
  canRemind,
  canonicalArgs,
  detectFailure,
  detectRepeatSeries,
  failureSnippet,
  fuzzySimilar,
  hasResidualIdentity,
  isIntendedNonzero,
  isNoiseError,
  looksLikeFailure,
  looksLikeSuccess,
  nonTransparentProducers,
  shouldWarnLongRunning,
  shouldWarnSuppressedSpawn,
  shouldWarnInheritedSpawn,
  shouldWarnOrphanJob,
  shouldWarnWaitLoop,
  normalizeCommand,
  parameterizeError,
  patternKey,
  scrubSecrets,
  splitChain,
  stripControl,
  suggestCorrection,
  REPEAT_MARKER,
  REPEAT_PROCEED,
} from "../src/patterns"
import { DEMOTE_OVERRIDES, GLOBAL_PROJECTS, GateStore, MAX_SESSIONS, NOISE_TTL_DAYS, PLUGIN_VERSION, Stores, TTL_DAYS, mergeGate, type Gate } from "../src/store"
import { repairGate } from "../src/validate"

type Ctx = Parameters<typeof Dejavu>[0]
type Hooks = Awaited<ReturnType<typeof Dejavu>>
type BeforeHook = NonNullable<Hooks["tool.execute.before"]>
type AfterHook = NonNullable<Hooks["tool.execute.after"]>
type EventHook = NonNullable<Hooks["event"]>
type TransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>
type BeforeInput = Parameters<BeforeHook>[0]
type BeforeOutput = Parameters<BeforeHook>[1]
type AfterInput = Parameters<AfterHook>[0]
type AfterOutput = Parameters<AfterHook>[1]
type EventInput = Parameters<EventHook>[0]

interface GateRow {
  key: string
  signature: string
  tool: string
  status: string
  count: number
  sessions: string[]
  snippet: string
  firstSeen: string
  lastSeen: string
  correction?: string
  remindedSessions?: Record<string, number>
  failedSessions?: Record<string, number | { t: number; v: number }>
  overrideCount?: number
  overrideSessions?: string[]
  feedbackDemoted?: boolean
  succeededAfterGate?: number
  reoffenseSessions?: string[]
  movedOn?: number
  iteratedVersion?: number
  remindedCount?: number
  recurredAfterGate?: number
  recurredAfterReminder?: number
  promotionCount?: number
}

let failures = 0
function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`ok   - ${name}`)
  } else {
    failures += 1
    console.error(`FAIL - ${name}`)
  }
}

const tmp = await mkdtemp(join(tmpdir(), "dejavu-test-"))
process.env.DEJAVU_HOME = join(tmp, "global")

const ctx = {
  directory: join(tmp, "project"),
  client: { app: { log: async () => ({}) } },
} as unknown as Ctx

// --- Pre-seed: gates learned under the OLD policy, one with a leaked secret ---
// Dates are relative to NOW: hardcoded dates rot — once lastSeen fell outside
// the 7-day noise TTL the seeded gates expired during init and the migration
// checks failed on a date, not on behavior.
await mkdir(join(tmp, "project", ".opencode", "dejavu"), { recursive: true })
const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXyz0123456789"
const seedFirstSeen = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
const seedLastSeen = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
await writeFile(
  join(tmp, "project", ".opencode", "dejavu", "gates.json"),
  JSON.stringify(
    {
      version: 1,
      gates: [
        {
          key: "aaaa00000001",
          signature: "read:legacy_probe.py",
          tool: "read",
          status: "blocking",
          count: 5,
          sessions: ["old1", "old2"],
          projects: ["oldproj"],
          firstSeen: seedFirstSeen,
          lastSeen: seedLastSeen,
          snippet: "12: except (TypeError, ValueError):",
          remindedCount: 3,
          blockedCount: 1,
          recurredAfterReminder: 1,
          recurredAfterGate: 1,
        },
        {
          key: "aaaa00000002",
          signature: `bash:echo ${SECRET}`,
          tool: "bash",
          status: "watching",
          count: 1,
          sessions: ["old1"],
          projects: ["oldproj"],
          firstSeen: seedFirstSeen,
          lastSeen: seedLastSeen,
          snippet: SECRET,
          remindedCount: 0,
          blockedCount: 0,
          recurredAfterReminder: 0,
          recurredAfterGate: 0,
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
)

const hooks = await Dejavu(ctx)
const before = hooks["tool.execute.before"] as BeforeHook
const after = hooks["tool.execute.after"] as AfterHook

const gatesPath = join(tmp, "project", ".opencode", "dejavu", "gates.json")
const readGates = async (): Promise<GateRow[]> =>
  (JSON.parse(await readFile(gatesPath, "utf8")) as { gates: GateRow[] }).gates

// --- 0. migration: probe gates demoted, secrets scrubbed from old data ---
const migrated = await readGates()
const legacy = migrated.find((g) => g.key === "aaaa00000001")
const leaky = migrated.find((g) => g.key === "aaaa00000002")
check("migration demotes read-gates to watching", legacy?.status === "watching")
check("migration scrubs secrets from old gates", leaky !== undefined && !leaky.signature.includes("sk-proj-") && !leaky.snippet.includes("sk-proj-") && leaky.snippet.includes("<redacted>"))

const emitToolError = async (
  partId: string,
  tool: string,
  sessionID: string,
  error: string,
  input?: Record<string, unknown>,
): Promise<void> => {
  await (hooks.event as EventHook)({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: partId, type: "tool", tool, sessionID, state: { status: "error", error, input } },
      },
    },
  } as unknown as EventInput)
}

function fail(command: string, session: string, callID: string): Promise<void> {
  return after(
    { tool: "bash", sessionID: session, callID, args: { command } } as unknown as AfterInput,
    { title: CMD, output: "npm ERR! boom\nExit code: 1", metadata: {} } as unknown as AfterOutput,
  )
}

const CMD = "npm run definitely-broken-xyz"

async function attempt(command: string, session: string, callID: string): Promise<Error | null> {
  try {
    await before(
      { tool: "bash", sessionID: session, callID } as unknown as BeforeInput,
      { args: { command } } as unknown as BeforeOutput,
    )
    return null
  } catch (error) {
    return error as Error
  }
}

// --- 1. three failures across two sessions promote the pattern to a gate ---
await fail(CMD, "s1", "c1")
await fail(CMD, "s1", "c2")
await fail(CMD, "s2", "c3")
let gates = await readGates()
const gate1 = gates.find((g) => g.signature === `bash:${CMD}`)
check("gate promoted after 3 failures in 2 sessions", gate1?.status === "blocking" && gate1.count === 3 && gate1.sessions.length === 2)

// --- 2. first attempt in a fresh session is aborted with a REMINDER ---
const first = await attempt(CMD, "s3", "c4")
check("first attempt throws REMINDER", first !== null && first.message.includes("[dejavu] REMINDER"))

// --- 3. one retry after the reminder is allowed through ---
await new Promise((resolve) => setTimeout(resolve, 600)) // out of the concurrent-dispatch race window
const retry = await attempt(CMD, "s3", "c5")
check("retry after reminder is allowed", retry === null)

// --- 4. the retry fails again -> next attempt is hard-blocked ---
await fail(CMD, "s3", "c5")
const blocked = await attempt(CMD, "s3", "c6")
check("repeat failure after reminder throws BLOCKED", blocked !== null && blocked.message.includes("[dejavu] BLOCKED"))

// --- 5. explicit override bypasses the gate ---
const override = await attempt(`${CMD} # dejavu:proceed`, "s3", "c7")
check("dejavu:proceed bypasses the gate", override === null)

// --- 5b. override marker inside quoted strings must NOT bypass ---
const smuggle = await attempt(`echo "dejavu:proceed" && ${CMD}`, "s-smuggle", "c-smuggle1")
check("override marker inside quotes does not bypass", smuggle !== null && smuggle.message.includes("[dejavu] REMINDER"))

// --- 5c. concurrent first encounters are all reminded; a true retry comes later ---
const raceFirst = await attempt(CMD, "s-race", "r1")
const raceSibling = await attempt(CMD, "s-race", "r2")
check(
  "call dispatched in the reminder burst is reminded too (race guard)",
  raceFirst !== null && raceSibling !== null && raceSibling.message.includes("[dejavu] REMINDER"),
)
await new Promise((resolve) => setTimeout(resolve, 600))
const raceRetry = await attempt(CMD, "s-race", "r3")
check("retry after the race window is allowed", raceRetry === null)

// --- 6. unrelated commands are untouched ---
const unrelated = await attempt("git status", "s3", "c8")
check("unrelated command passes", unrelated === null)

// --- 7. metadata.exit detection: failure with no error text in output ---
const CMD2 = 'bun -e "process.exit(7)"'
for (const [session, callID] of [["s4", "d1"], ["s4", "d2"], ["s5", "d3"]] as const) {
  await after(
    { tool: "bash", sessionID: session, callID, args: { command: CMD2 } } as unknown as AfterInput,
    { title: CMD2, output: "(no output)", metadata: { output: "(no output)", exit: 1, truncated: false } } as unknown as AfterOutput,
  )
}
gates = await readGates()
const gate2 = gates.find((g) => g.signature.startsWith("bash:bun -e <code:"))
check("metadata.exit promotes gate with empty output text", gate2?.status === "blocking")
check("interpreter payload is fingerprinted, not flattened to <str>", gate2 !== undefined && !gates.some((g) => g.signature === "bash:bun -e <str>"))

// --- 7b. interpreter one-liners: the code IS the identity ---
const PY_A = 'python -c "print(\'alpha\')"'
const PY_B = 'python -c "print(\'beta\')"'
check("same one-liner normalizes to one key", callSignature("bash", { command: PY_A }) === callSignature("bash", { command: PY_A }))
check("different one-liner code gets different keys", callSignature("bash", { command: PY_A }) !== callSignature("bash", { command: PY_B }))
// sha1 fingerprint of this payload is 14021754 — ALL digits (~2.3% of payloads);
// the number-parameterization rule must not eat it or every such one-liner collapses
const PY_DIGIT_FP = 'python -c "print(16)"'
check("all-digit code fingerprint survives number parameterization", (callSignature("bash", { command: PY_DIGIT_FP }) ?? "").includes("<code:14021754>"))
check(
  "legacy bare-<str> interpreter shapes cannot block",
  !canBlock("bash", "bash:python -c <str>") && !canBlock("bash", "bash:node -e <str>") && !canBlock("bash", "bash:& <str> -c @ <str> @"),
)
check("fingerprinted one-liners can still block", canBlock("bash", callSignature("bash", { command: PY_A }) ?? ""))

// --- 8. chain bypass: a gated command hidden behind && still gets reminded ---
const chained = await attempt(`echo ok && ${CMD}`, "s9", "c9")
check("chain bypass is caught via segment match", chained !== null && chained.message.includes("[dejavu] REMINDER"))

// --- 9. normalization unit checks ---
check(
  "agent comments stripped from signatures",
  callSignature("bash", { command: "# probe the api\ngit status" }) === callSignature("bash", { command: "git status" }),
)
check(
  "CRLF commands normalize identically to LF",
  callSignature("bash", { command: "echo a\r\necho b" }) === callSignature("bash", { command: "echo a\necho b" }),
)
check("chain split handles CRLF", JSON.stringify(splitChain("echo a\r\necho b")) === JSON.stringify(["echo a", "echo b"]))
check(
  "chain split separates &&, ||, |, ;",
  JSON.stringify(splitChain("a && b || c | d;e")) === JSON.stringify(["a", "b", "c", "d", "e"]),
)
check("chain split respects subshell parens", splitChain("(cd /tmp && ls)").length === 1)
check("chain split is quote-aware", splitChain('echo "a;b"').length === 1)
check(
  "glob/grep signatures tracked",
  callSignature("glob", { pattern: "**/*.ts" }) === "glob:**/*.ts" && callSignature("grep", { pattern: "TODO" }) === "grep:todo",
)
check(
  "error parameterization dedupes variable parts",
  parameterizeError("Cannot find module 'lodash' at C:\\x\\y.ts") === parameterizeError("Cannot find module 'axios' at C:\\x\\z.ts"),
)

// --- 10. event channel: parameterized error text collapses across uuids ---
await emitToolError("p1", "todo", "s20", "ENOENT: no such file 7c1811ed-e98f-4c9c-a9f9-58c757ff494f.json")
await emitToolError("p2", "todo", "s21", "ENOENT: no such file 0751007c-1234-5678-9abc-def012345678.json")
gates = await readGates()
const todoGates = gates.filter((g) => g.tool === "todo")
check(
  "parameterized errors collapse into one pattern",
  todoGates.length === 1 && todoGates[0]?.count === 2 && todoGates[0]?.sessions.length === 2,
)

// --- 11. file-probe tools never promote to blocking (policy) ---
for (const [sess, call] of [["r1", "q1"], ["r2", "q2"], ["r3", "q3"], ["r4", "q4"]] as const) {
  await emitToolError(`rp-${sess}`, "read", sess, "File not found", { filePath: "src/missing_probe_target.py" })
}
gates = await readGates()
check("read failure stays watching at 4 occurrences", gates.find((g) => g.signature === "read:missing_probe_target.py")?.status === "watching")
await emitToolError("rp-r5", "read", "r5", "File not found", { filePath: "src/missing_probe_target.py" })
gates = await readGates()
check("read failure NEVER promotes (policy: probes cannot block)", gates.find((g) => g.signature === "read:missing_probe_target.py")?.status === "watching")

// --- 11b. diagnostics promote to REMIND-ONLY: signal without punishment ---
const TSC = "npx tsc --noEmit"
await after(
  { tool: "bash", sessionID: "s50", callID: "t1", args: { command: TSC } } as unknown as AfterInput,
  { title: TSC, output: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable", metadata: {} } as unknown as AfterOutput,
)
await after(
  { tool: "bash", sessionID: "s50", callID: "t2", args: { command: TSC } } as unknown as AfterInput,
  { title: TSC, output: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable", metadata: {} } as unknown as AfterOutput,
)
await after(
  { tool: "bash", sessionID: "s51", callID: "t3", args: { command: TSC } } as unknown as AfterInput,
  { title: TSC, output: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable", metadata: {} } as unknown as AfterOutput,
)
gates = await readGates()
check("diagnostic promotes to remind-only (never blocking)", gates.find((g) => g.signature === `bash:${TSC.toLowerCase()}`)?.status === "reminding")

// remind-only gate: never aborts — the reminder rides on the failing output
const tscAttempt = await attempt(TSC, "s52", "t4")
check("remind-only gate does not abort the call", tscAttempt === null)
const tscNote = { title: TSC, output: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable", metadata: {} }
await after(
  { tool: "bash", sessionID: "s52", callID: "t4", args: { command: TSC } } as unknown as AfterInput,
  tscNote as unknown as AfterOutput,
)
gates = await readGates()
check("reminding after-hook appends the NOTE to the failing output", tscNote.output.includes("[dejavu] NOTE") && tscNote.output.startsWith("src/x.ts(1,1): error TS2322"))
check("annotation marks the session on the gate", gates.find((g) => g.signature === `bash:${TSC.toLowerCase()}`)?.remindedSessions?.["s52"] !== undefined)
const tscNote2 = { title: TSC, output: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable", metadata: {} }
await after(
  { tool: "bash", sessionID: "s52", callID: "t5", args: { command: TSC } } as unknown as AfterInput,
  tscNote2 as unknown as AfterOutput,
)
gates = await readGates()
check("second failing call adds no second annotation", !tscNote2.output.includes("[dejavu] NOTE"))
check("second failing call increments recurredAfterReminder", gates.find((g) => g.signature === `bash:${TSC.toLowerCase()}`)?.recurredAfterReminder === 1)
const tscRetry = await attempt(TSC, "s52", "t6")
check("remind-only gate never blocks after repeated failure", tscRetry === null)
const tscOk = { title: TSC, output: "ok", metadata: { exit: 0 } }
await after(
  { tool: "bash", sessionID: "s52", callID: "t7", args: { command: TSC } } as unknown as AfterInput,
  tscOk as unknown as AfterOutput,
)
check("success on a reminding gate appends no annotation", tscOk.output === "ok")

// --- 12. read output is file CONTENT: text signatures must not apply ---
await after(
  { tool: "read", sessionID: "s10", callID: "e1", args: { filePath: "src/other.py" } } as unknown as AfterInput,
  { title: "src/other.py", output: "def f():\n    raise TypeError('boom')", metadata: {} } as unknown as AfterOutput,
)
gates = await readGates()
check("file content containing 'TypeError' is NOT a failure", !gates.some((g) => g.signature === "read:other.py"))

// --- 13. intended non-zero exits: grep exit 1 is normal, exit 2 is a failure ---
await after(
  { tool: "bash", sessionID: "s11", callID: "g1", args: { command: "grep -n foo bar.txt" } } as unknown as AfterInput,
  { title: "grep", output: "(no output)", metadata: { exit: 1 } } as unknown as AfterOutput,
)
gates = await readGates()
check("grep exit 1 (no match) is not recorded", !gates.some((g) => g.signature === "bash:grep -n foo bar.txt"))
await after(
  { tool: "bash", sessionID: "s11", callID: "g2", args: { command: "grep -n foo bar.txt" } } as unknown as AfterInput,
  { title: "grep", output: "grep: bar.txt: No such file or directory", metadata: { exit: 2 } } as unknown as AfterOutput,
)
gates = await readGates()
check("grep exit 2 (real error) IS recorded", gates.some((g) => g.signature === "bash:grep -n foo bar.txt"))

// --- 14. fuzzy near-duplicate matching (Levenshtein) reminds on variants ---
const CMD3 = "npm run broken-thing"
await fail(CMD3, "s30", "f1")
await fail(CMD3, "s30", "f2")
await fail(CMD3, "s31", "f3")
const variant = await attempt(`${CMD3} --extra`, "s32", "f4")
check("near-duplicate variant is reminded via fuzzy match", variant !== null && variant.message.includes("[dejavu] REMINDER"))

// --- 15. secrets are scrubbed on ingest (event channel) ---
await emitToolError("sec1", "todo", "s40", `boom ${SECRET} boom`)
gates = await readGates()
const secGate = gates.find((g) => g.tool === "todo" && g.snippet.includes("<redacted>"))
check("ingested snippets are secret-scrubbed", secGate !== undefined && !gates.some((g) => g.snippet.includes("sk-proj-")))

// --- 15b. aborted/cancelled executions are noise, not failures ---
await emitToolError("noise1", "background_output", "s60", "Tool execution aborted")
await emitToolError("noise2", "background_output", "s61", "The tool execution was aborted by the user")
gates = await readGates()
check("aborted tool executions are not recorded", !gates.some((g) => g.tool === "background_output"))

// --- 16. reminder wording teaches the trailing-comment bypass ---
check("reminder explains trailing-comment bypass", first !== null && first.message.includes("# dejavu:proceed"))

// --- 17. log events carry forensic fields (channel, version) ---
const logRaw = await readFile(join(tmp, "project", ".opencode", "dejavu", "log.jsonl"), "utf8")
const logLines = logRaw
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { type: string; channel?: string; version?: string })
check("init event stamps plugin version", logLines.some((l) => l.type === "init" && typeof l.version === "string"))
check(
  "detected events carry detection channel",
  logLines.some((l) => l.type === "detected" && l.channel === "exit") && logLines.some((l) => l.type === "detected" && l.channel === "text"),
)

// --- 18. init works in a fresh project dir (no pre-created .opencode) ---
const freshDir = join(tmp, "fresh-project")
await Dejavu({ directory: freshDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const freshLog = await readFile(join(freshDir, ".opencode", "dejavu", "log.jsonl"), "utf8").catch(() => "")
check("init writes log in fresh project dir", freshLog.includes('"type":"init"'))

// --- 19. scrubSecrets covers Google keys, full PEM blocks, KEY=VALUE secrets ---
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADKCAQEAtest\n-----END PRIVATE KEY-----"
check(
  "google api keys scrubbed",
  scrubSecrets("export GOOGLE_API_KEY=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345678").includes("<redacted>"),
)
check("pem body scrubbed, not just header", !scrubSecrets(PEM).includes("MIIEvQIBADKCAQEAtest"))
check("env-style KEY=VALUE scrubbed", scrubSecrets("curl -H x --token SECRET_KEY_BASE=abcdefghij1234567890abcd").includes("<redacted>"))

// --- 20. fuzzy floor: verb-level-different commands must NOT merge ---
check("git push vs git pull not fuzzy-similar", !fuzzySimilar("bash:git push <str>", "bash:git pull <str>"))
check("real near-duplicates still fuzzy-similar", fuzzySimilar("bash:gradlew :app:compiletestjava", "bash:gradlew :web:compiletestjava"))
check(
  "different code fingerprints never fuzzy-merge (3-char hash distance passes the ratio rule)",
  !fuzzySimilar("bash:python -c <code:14021754>", "bash:python -c <code:14021abc>"),
)
check(
  "same fingerprint with surrounding variation still fuzzy-matches",
  fuzzySimilar("bash:python -c <code:14021754>", "bash:python -c <code:14021754> --verbose"),
)

// --- 21. scope escalation, production-shaped: two project windows, one global store ---
// Each Dejavu instance only sees its own project store — cross-project
// visibility comes exclusively from the global index.
const projA = join(tmp, "projA")
const projB = join(tmp, "projB")
const ctxA = { directory: projA, client: { app: { log: async () => ({}) } } } as unknown as Ctx
const ctxB = { directory: projB, client: { app: { log: async () => ({}) } } } as unknown as Ctx
const hooksA = await Dejavu(ctxA)
const hooksB = await Dejavu(ctxB)
const afterA = hooksA["tool.execute.after"] as AfterHook
const afterB = hooksB["tool.execute.after"] as AfterHook
const readJson = async (p: string): Promise<GateRow[]> =>
  (JSON.parse(await readFile(p, "utf8")) as { gates: GateRow[] }).gates
const failIn = (hook: AfterHook) => (session: string, callID: string, command: string): Promise<void> =>
  hook(
    { tool: "bash", sessionID: session, callID, args: { command } } as unknown as AfterInput,
    { title: command, output: "npm ERR! boom\nExit code: 1", metadata: {} } as unknown as AfterOutput,
  )
const failA = failIn(afterA)
const failB = failIn(afterB)
const ESC_CMD = "deploy-tool --broken-flag"
const escSig = `bash:${ESC_CMD}`
const gatesAPath = join(projA, ".opencode", "dejavu", "gates.json")
const gatesBPath = join(projB, ".opencode", "dejavu", "gates.json")
const globalGatesPath = join(tmp, "global", "gates.json")

await failA("ea1", "x1", ESC_CMD)
await failA("ea1", "x2", ESC_CMD)
await failA("ea2", "x3", ESC_CMD)
check("pattern promotes in its own project store first", (await readJson(gatesAPath)).some((g) => g.signature === escSig && g.status === "blocking"))

await failB("eb1", "x4", ESC_CMD)
check("second project escalates the pattern to the global store", (await readJson(globalGatesPath)).some((g) => g.signature === escSig))
check("escalated gate is spliced out of the second project store", !(await readJson(gatesBPath)).some((g) => g.signature === escSig))

await Dejavu(ctxA) // next init in project A merges the leftover local copy into global
const aGatesAfter = await readJson(gatesAPath)
const globalGate = (await readJson(globalGatesPath)).find((g) => g.signature === escSig)
check(
  "project copy dedupes into the global gate on next init",
  !aGatesAfter.some((g) => g.signature === escSig) && globalGate !== undefined && globalGate.count >= 4 && globalGate.sessions.length >= 3,
)

// --- 22. self-healing: corrupt gates.json is quarantined, plugin keeps working ---
const sickDir = join(tmp, "sick-project")
const sickDejavu = join(sickDir, ".opencode", "dejavu")
await mkdir(sickDejavu, { recursive: true })
await writeFile(join(sickDejavu, "gates.json"), "{ this is not json", "utf8")
await Dejavu({ directory: sickDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const quarantineFiles = (await readdir(sickDejavu)).filter((f) => f.startsWith("gates.json.corrupt-"))
check("corrupt gates.json is quarantined with bytes kept", quarantineFiles.length === 1)
check("quarantined bytes are preserved", (await readFile(join(sickDejavu, quarantineFiles[0] ?? ""), "utf8")).includes("this is not json"))
check("plugin starts with a fresh store after quarantine", (await readJson(join(sickDejavu, "gates.json"))).length === 0)

// --- 23. self-healing: reconcile merges duplicate keys and swaps inverted dates ---
const healDir = join(tmp, "heal-project")
const healDejavu = join(healDir, ".opencode", "dejavu")
await mkdir(healDejavu, { recursive: true })
const healBase = {
  key: "beef00000001",
  signature: "bash:heal me",
  tool: "bash",
  status: "watching",
  count: 1,
  sessions: ["h1"],
  projects: [healDir],
  firstSeen: "2026-08-20T00:00:00.000Z",
  lastSeen: "2026-08-10T00:00:00.000Z",
  snippet: "exit code 1",
  remindedCount: 0,
  blockedCount: 0,
  recurredAfterReminder: 0,
  recurredAfterGate: 0,
}
await writeFile(
  join(healDejavu, "gates.json"),
  JSON.stringify({ version: 1, gates: [{ ...healBase }, { ...healBase, count: 2, sessions: ["h2"] }] }),
  "utf8",
)
await Dejavu({ directory: healDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const healed = await readJson(join(healDejavu, "gates.json"))
const healedGate = healed[0]
check(
  "duplicate keys merge and inverted dates swap on reconcile",
  healed.length === 1 &&
    healedGate !== undefined &&
    healedGate.count === 3 &&
    healedGate.sessions.length === 2 &&
    healedGate.firstSeen <= healedGate.lastSeen,
)

// --- 24. self-healing: corrupt log lines excised, bytes preserved ---
const logDir = join(tmp, "log-project")
const logDejavu = join(logDir, ".opencode", "dejavu")
await mkdir(logDejavu, { recursive: true })
await writeFile(
  join(logDejavu, "log.jsonl"),
  `{"ts":"2026-08-23T00:00:00.000Z","type":"init","key":"dejavu","version":"2.1.0"}\n{broken line\n`,
  "utf8",
)
await Dejavu({ directory: logDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const healedLog = (await readFile(join(logDejavu, "log.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "")
check(
  "live log has zero unparseable lines after reconcile",
  healedLog.every((l) => {
    try {
      JSON.parse(l)
      return true
    } catch {
      return false
    }
  }),
)
check("excised bytes preserved in log.jsonl.corrupt", (await readFile(join(logDejavu, "log.jsonl.corrupt"), "utf8").catch(() => "")).includes("{broken line"))

// --- 25. self-healing: index orphans SURVIVE reconcile (their gate may live
// in another project's store, invisible to this process — pruning destroyed
// cross-project escalation evidence); missing entries rebuilt; proven gates
// escalated. Rot is handled by the TTL sweep, not by scope-blind pruning. ---
const idxGlobalDir = join(tmp, "idx-global")
const idxProjectDir = join(tmp, "idx-project")
await mkdir(idxGlobalDir, { recursive: true })
await mkdir(join(idxProjectDir, ".opencode", "dejavu"), { recursive: true })
const idxGate = (key: string, signature: string): Record<string, unknown> => ({
  key,
  signature,
  tool: "bash",
  status: "watching",
  count: 1,
  sessions: ["i1"],
  projects: [idxProjectDir],
  firstSeen: "2026-08-23T00:00:00.000Z",
  lastSeen: "2026-08-23T00:00:00.000Z",
  snippet: "exit code 1",
  remindedCount: 0,
  blockedCount: 0,
  recurredAfterReminder: 0,
  recurredAfterGate: 0,
})
// global store: gate dddd without an index entry + orphan index key ffff
await writeFile(join(idxGlobalDir, "gates.json"), JSON.stringify({ version: 1, gates: [idxGate("dddd00000001", "bash:index me")] }), "utf8")
// escalation evidence must rest on LIVE dirs (ghost dirs don't count) — use two real ones
const idxProjA = join(tmp, "idx-escalate-a")
const idxProjB = join(tmp, "idx-escalate-b")
await mkdir(idxProjA, { recursive: true })
await mkdir(idxProjB, { recursive: true })
await writeFile(
  join(idxGlobalDir, "index.json"),
  JSON.stringify({
    version: 1,
    keys: {
      ffff00000001: { projects: ["nowhere"], lastSeen: "2026-08-20T00:00:00.000Z" },
      eeee00000001: { projects: [idxProjA, idxProjB], lastSeen: "2026-08-23T00:00:00.000Z" },
      // ghost-only evidence: both dirs gone → must NOT escalate
      abcd00000001: { projects: [join(tmp, "ghost-1"), join(tmp, "ghost-2")], lastSeen: "2026-08-23T00:00:00.000Z" },
    },
  }),
  "utf8",
)
// project store: gate eeee proven in 2 LIVE project dirs (per index) but never escalated;
// gate abcd "proven" in 2 ghost dirs only
await writeFile(
  join(idxProjectDir, ".opencode", "dejavu", "gates.json"),
  JSON.stringify({ version: 1, gates: [idxGate("eeee00000001", "bash:escalate via index"), idxGate("abcd00000001", "bash:ghost proven")] }),
  "utf8",
)
const idxStores = new Stores(new GateStore(idxGlobalDir), new GateStore(join(idxProjectDir, ".opencode", "dejavu")))
await idxStores.reconcileAll()
const idxAfter = await new GateStore(idxGlobalDir).loadIndexForMutation()
const idxGlobalGates = await new GateStore(idxGlobalDir).loadForMutation()
const idxProjectGates = await new GateStore(join(idxProjectDir, ".opencode", "dejavu")).loadForMutation()
check("orphan index key survives reconcile (may live in another project)", idxAfter.keys["ffff00000001"] !== undefined)
check("missing index entry rebuilt from the global gate", idxAfter.keys["dddd00000001"] !== undefined)
check(
  "gate proven in 2+ LIVE projects escalates to global on reconcile",
  idxGlobalGates.some((g) => g.key === "eeee00000001") && !idxProjectGates.some((g) => g.key === "eeee00000001"),
)
check(
  "gate proven only in ghost dirs does NOT escalate",
  !idxGlobalGates.some((g) => g.key === "abcd00000001") && idxProjectGates.some((g) => g.key === "abcd00000001"),
)

// --- 26. multi-window: session state lives on the gate, not in a process ---
const winDir = join(tmp, "win-project")
const hooksW1 = await Dejavu({ directory: winDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const hooksW2 = await Dejavu({ directory: winDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const w1Before = hooksW1["tool.execute.before"] as BeforeHook
const w2Before = hooksW2["tool.execute.before"] as BeforeHook
const w1After = hooksW1["tool.execute.after"] as AfterHook
const w2After = hooksW2["tool.execute.after"] as AfterHook
const WIN_CMD = "deploy --to prod"
const winFail = async (hook: AfterHook, session: string, callID: string): Promise<void> => {
  await hook(
    { tool: "bash", sessionID: session, callID, args: { command: WIN_CMD } } as unknown as AfterInput,
    { title: WIN_CMD, output: "npm ERR! boom\nExit code: 1", metadata: {} } as unknown as AfterOutput,
  )
}
await winFail(w1After, "wa", "p1")
await winFail(w1After, "wa", "p2")
await winFail(w1After, "wb", "p3")
check(
  "gate promoted for multi-window test",
  (await readJson(join(winDir, ".opencode", "dejavu", "gates.json"))).some((g) => g.signature === `bash:${WIN_CMD}` && g.status === "blocking"),
)
const attemptOn = (hook: BeforeHook) => async (session: string, callID: string): Promise<Error | null> => {
  try {
    await hook({ tool: "bash", sessionID: session, callID } as unknown as BeforeInput, { args: { command: WIN_CMD } } as unknown as BeforeOutput)
    return null
  } catch (error) {
    return error as Error
  }
}
const remindW1 = await attemptOn(w1Before)("shared-ses", "p4")
check("window 1 reminds on first encounter", remindW1 !== null && remindW1.message.includes("[dejavu] REMINDER"))
await new Promise((resolve) => setTimeout(resolve, 1100)) // session moves to window 2: past the TTL and the race window
const seenByW2 = await attemptOn(w2Before)("shared-ses", "p5")
check("window 2 sees window 1's reminder (state is on the gate, not in the process)", seenByW2 === null)
await winFail(w2After, "shared-ses", "p6")
const blockedW1 = await attemptOn(w1Before)("shared-ses", "p7")
check("block escalates across processes", blockedW1 !== null && blockedW1.message.includes("[dejavu] BLOCKED"))

// --- 27. fuzzy pre-filters: length band + over-long cap ---
check(
  "length-band pre-filter rejects impossible fuzzy matches",
  !fuzzySimilar("bash:git push <str>", "bash:completely different and much longer command shape here"),
)
check(
  "over-long signatures never fuzzy-match (exact only)",
  !fuzzySimilar(`bash:${"x".repeat(320)}`, `bash:${"x".repeat(320)} tail`),
)

// --- seeded-store helpers for the state-machine tests below ---
const seedGate = (over: Record<string, unknown>): Record<string, unknown> => ({
  key: "000000000000",
  signature: "bash:placeholder",
  tool: "bash",
  status: "blocking",
  count: 3,
  sessions: ["s1", "s2"],
  projects: [],
  firstSeen: "2026-08-20T00:00:00.000Z",
  lastSeen: "2026-08-23T00:00:00.000Z",
  snippet: "exit code 1",
  remindedCount: 0,
  blockedCount: 0,
  recurredAfterReminder: 0,
  recurredAfterGate: 0,
  ...over,
})
const seedGates = async (dir: string, gates: Record<string, unknown>[]): Promise<void> => {
  const dejavuDir = join(dir, ".opencode", "dejavu")
  await mkdir(dejavuDir, { recursive: true })
  await writeFile(join(dejavuDir, "gates.json"), JSON.stringify({ version: 1, gates }), "utf8")
}
const failOn = (hooks: Awaited<ReturnType<typeof Dejavu>>) => async (command: string, session: string, callID: string): Promise<void> => {
  await (hooks["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: session, callID, args: { command } } as unknown as AfterInput,
    { title: command, output: "npm ERR! boom\nExit code: 1", metadata: {} } as unknown as AfterOutput,
  )
}
const attemptWith = (hooks: Awaited<ReturnType<typeof Dejavu>>) => async (command: string, session: string, callID: string): Promise<Error | null> => {
  try {
    await (hooks["tool.execute.before"] as BeforeHook)({ tool: "bash", sessionID: session, callID } as unknown as BeforeInput, { args: { command } } as unknown as BeforeOutput)
    return null
  } catch (error) {
    return error as Error
  }
}

// --- 28. mergeGate preserves session enforcement state (escalation must not reset it) ---
const mergeA = seedGate({ key: "aaaa11111111", remindedSessions: { s1: 100, s2: 200 }, failedSessions: { s1: 150 }, overrideCount: 2 }) as unknown as Gate
const mergeB = seedGate({ key: "aaaa11111111", remindedSessions: { s2: 300, s3: 250 }, failedSessions: { s3: 260 }, overrideCount: 3, feedbackDemoted: true }) as unknown as Gate
mergeGate(mergeA, mergeB)
check(
  "mergeGate preserves session enforcement state",
  mergeA.remindedSessions?.s1 === 100 &&
    mergeA.remindedSessions?.s2 === 300 &&
    mergeA.remindedSessions?.s3 === 250 &&
    mergeA.failedSessions?.s1 === 150 &&
    mergeA.failedSessions?.s3 === 260,
)
check("mergeGate sums override counts and keeps the demotion mark", mergeA.overrideCount === 5 && mergeA.feedbackDemoted === true)

// --- 29. fuzzy consolidation lands on the reminded gate and keeps its evidence ---
const fuzzyDir = join(tmp, "fuzzy-project")
const sigA = callSignature("bash", { command: "deploy --to alpha" }) ?? ""
const sigB = callSignature("bash", { command: "deploy --to beta" }) ?? ""
await seedGates(fuzzyDir, [
  seedGate({ key: patternKey(sigA), signature: sigA, snippet: "EVIDENCE-A" }),
  seedGate({ key: patternKey(sigB), signature: sigB, snippet: "EVIDENCE-B", remindedSessions: { "fuzzy-ses": Date.now() } }),
])
const hooksF = await Dejavu({ directory: fuzzyDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksF)("deploy --to gamma", "fuzzy-ses", "fz1")
const fuzzyGates = await readJson(join(fuzzyDir, ".opencode", "dejavu", "gates.json"))
const gateFA = fuzzyGates.find((g) => g.key === patternKey(sigA))
const gateFB = fuzzyGates.find((g) => g.key === patternKey(sigB))
check("failure lands on the reminded gate (before/after hooks stay in sync)", gateFA?.count === 3 && gateFB?.count === 4)
check("fuzzy consolidation does not overwrite evidence", gateFB?.snippet === "EVIDENCE-B")
check("failure after reminder escalates to failedSessions", gateFB?.failedSessions?.["fuzzy-ses"] !== undefined)

// --- 30. failedSessions expire; legacy arrays coerce ---
const ttlDir = join(tmp, "ttl-project")
const ttlSig = callSignature("bash", { command: "stale block cmd" }) ?? ""
await seedGates(ttlDir, [
  seedGate({
    key: patternKey(ttlSig),
    signature: ttlSig,
    failedSessions: { "stale-ses": Date.now() - 2 * 24 * 60 * 60 * 1000, "fresh-ses": Date.now() },
  }),
])
const hooksT = await Dejavu({ directory: ttlDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const staleRes = await attemptWith(hooksT)("stale block cmd", "stale-ses", "t1")
check("stale failedSession expired — no permanent block", staleRes !== null && staleRes.message.includes("[dejavu] REMINDER"))
const freshRes = await attemptWith(hooksT)("stale block cmd", "fresh-ses", "t2")
check("fresh failedSession still blocks", freshRes !== null && freshRes.message.includes("[dejavu] BLOCKED"))

const legacyDir = join(tmp, "legacy-project")
const legacySig = callSignature("bash", { command: "legacy block cmd" }) ?? ""
await seedGates(legacyDir, [seedGate({ key: patternKey(legacySig), signature: legacySig, failedSessions: ["legacy-ses"] })])
const hooksL = await Dejavu({ directory: legacyDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const legacyRes = await attemptWith(hooksL)("legacy block cmd", "legacy-ses", "l1")
check("legacy failedSessions array coerces and still blocks", legacyRes !== null && legacyRes.message.includes("[dejavu] BLOCKED"))

// --- 31. corrections are truncated (context-pollution bound) ---
const corrDir = join(tmp, "corr-project")
const corrSig = callSignature("bash", { command: "corrected cmd" }) ?? ""
await seedGates(corrDir, [seedGate({ key: patternKey(corrSig), signature: corrSig, correction: "x".repeat(300) })])
const hooksC = await Dejavu({ directory: corrDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksC)("corrected cmd", "c1", "c2")
const corrGates = await readJson(join(corrDir, ".opencode", "dejavu", "gates.json"))
check("correction truncated to the evidence bound", (corrGates.find((g) => g.key === patternKey(corrSig))?.correction ?? "").length <= 200)

// --- 32. noise TTL: weak one-off patterns rot fast, proven ones persist ---
const noiseDir = join(tmp, "noise-project")
const weakSig = callSignature("bash", { command: "weak one-off cmd" }) ?? ""
const strongSig = callSignature("bash", { command: "strong proven cmd" }) ?? ""
const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
await seedGates(noiseDir, [
  seedGate({ key: patternKey(weakSig), signature: weakSig, count: 1, sessions: ["n1"], status: "watching", firstSeen: eightDaysAgo, lastSeen: eightDaysAgo }),
  seedGate({ key: patternKey(strongSig), signature: strongSig, count: 3, firstSeen: eightDaysAgo, lastSeen: eightDaysAgo }),
])
await Dejavu({ directory: noiseDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const noiseGates = await readJson(join(noiseDir, ".opencode", "dejavu", "gates.json"))
check("weak one-off gate rots on the noise TTL", !noiseGates.some((g) => g.key === patternKey(weakSig)))
check("proven gate survives the noise TTL", noiseGates.some((g) => g.key === patternKey(strongSig)))

// --- 33. correction lifecycle: corrected gate with zero recurrences retires healed ---
const healRetireDir = join(tmp, "heal-retire-project")
const healSig = callSignature("bash", { command: "healed cmd" }) ?? ""
const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString()
await seedGates(healRetireDir, [
  seedGate({ key: patternKey(healSig), signature: healSig, count: 5, correction: "use the other flag", lastSeen: sixtyOneDaysAgo, firstSeen: sixtyOneDaysAgo }),
])
await Dejavu({ directory: healRetireDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const healLog = await readFile(join(healRetireDir, ".opencode", "dejavu", "log.jsonl"), "utf8")
check("corrected gate with zero recurrences retires healed", healLog.includes('"type":"retired-healed"'))
// Deferred salient events bypass logAll, so the project store mirrors them to the
// global forensics itself (round-8 routing) — before this, the global log never
// saw a sweep/migrate retired-healed/demoted.
const healGlobalLog = await readFile(join(tmp, "global", "log.jsonl"), "utf8")
check("retired-healed (deferred, salient) is mirrored to the global log", healGlobalLog.includes(`"type":"retired-healed","key":"${patternKey(healSig)}"`))

// --- 34. flag-aware fuzzy: disjoint flags never merge, short subset additions still do ---
check("disjoint flags never fuzzy-merge", !fuzzySimilar("bash:python train.py --lr <n>", "bash:python train.py --epochs <n>"))
check("disjoint short flags rejected even within length band", !fuzzySimilar("bash:python train.py --lr", "bash:python train.py -v"))
check("subset flag addition still merges", fuzzySimilar("bash:python train.py", "bash:python train.py -v"))

// --- 35. repo-local verbs never escalate to the global store ---
const repoDirA = join(tmp, "repo-local-a")
const repoDirB = join(tmp, "repo-local-b")
const hooksRA = await Dejavu({ directory: repoDirA, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const hooksRB = await Dejavu({ directory: repoDirB, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const REPO_CMD = "npm install --legacy-peer-deps"
await failOn(hooksRA)(REPO_CMD, "ra1", "ra1")
await failOn(hooksRA)(REPO_CMD, "ra1", "ra2")
await failOn(hooksRA)(REPO_CMD, "ra2", "ra3")
const repoGatesA = await readJson(join(repoDirA, ".opencode", "dejavu", "gates.json"))
check("repo-local gate promotes in its own project", repoGatesA.some((g) => g.signature === `bash:${REPO_CMD}` && g.status === "blocking"))
await failOn(hooksRB)(REPO_CMD, "rb1", "rb1")
const repoGlobalGates = await readJson(join(tmp, "global", "gates.json")).catch(() => [] as GateRow[])
check("repo-local failure in a second project does NOT escalate globally", !repoGlobalGates.some((g) => g.signature === `bash:${REPO_CMD}`))
const repoGatesA2 = await readJson(join(repoDirA, ".opencode", "dejavu", "gates.json"))
check("repo-local gate stays in its project store", repoGatesA2.some((g) => g.signature === `bash:${REPO_CMD}`))

// --- 36. fuzzy-consolidated failure indexes the GATE's key, not the raw key ---
// (raw-key indexing orphaned entries and starved cross-project escalation)
const fuzzIdxDir = join(tmp, "fuzz-idx-project")
const hooksFI = await Dejavu({ directory: fuzzIdxDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const baseSig = callSignature("bash", { command: "python train.py" }) ?? ""
const baseKey = patternKey(baseSig)
const variantKey = patternKey(callSignature("bash", { command: "python train.py -v" }) ?? "")
await failOn(hooksFI)("python train.py", "fi1", "fi1")
await failOn(hooksFI)("python train.py -v", "fi1", "fi2")
const fuzzGates = await readJson(join(fuzzIdxDir, ".opencode", "dejavu", "gates.json"))
check("fuzzy variant consolidated into the base gate", fuzzGates.find((g) => g.key === baseKey)?.count === 2 && !fuzzGates.some((g) => g.key === variantKey))
const fuzzIdx = JSON.parse(await readFile(join(tmp, "global", "index.json"), "utf8")) as { keys: Record<string, unknown> }
check("index tracks the gate key (escalation stays alive)", fuzzIdx.keys[baseKey] !== undefined)
check("raw variant key is not orphaned in the index", fuzzIdx.keys[variantKey] === undefined)

// --- 37. healed gate: successes after a gate retire it so it stops reminding ---
const healBDir = join(tmp, "heal-project")
const hooksH = await Dejavu({ directory: healBDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const HEAL_CMD = "deploy --to heal"
const succeed = async (session: string, callID: string): Promise<void> => {
  await (hooksH["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: session, callID, args: { command: HEAL_CMD } } as unknown as AfterInput,
    { title: HEAL_CMD, output: "ok", metadata: { exit: 0 } } as unknown as AfterOutput,
  )
}
await failOn(hooksH)(HEAL_CMD, "h1", "h1")
await failOn(hooksH)(HEAL_CMD, "h1", "h2")
await failOn(hooksH)(HEAL_CMD, "h2", "h3")
const healKey = patternKey(callSignature("bash", { command: HEAL_CMD }) ?? "")
const healPromoted = (await readJson(join(healBDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === healKey)
check("gate promoted before heal", healPromoted?.status === "blocking")
check("promoted gate ships an auto-correction", typeof healPromoted?.correction === "string" && healPromoted.correction.length > 0)
const healBRemind = await attemptWith(hooksH)(HEAL_CMD, "h3", "h4")
check("active gate reminds", healBRemind !== null && healBRemind.message.includes("[dejavu] REMINDER"))
await succeed("h3", "h5")
await succeed("h3", "h6")
await succeed("h3", "h7")
const healBGates = await readJson(join(healBDir, ".opencode", "dejavu", "gates.json"))
check("gate heals to watching after 3 successes", healBGates.find((g) => g.key === healKey)?.status === "watching")
const healBAfter = await attemptWith(hooksH)(HEAL_CMD, "h3", "h8")
check("healed gate no longer reminds", healBAfter === null)
const healBLog = await readFile(join(healBDir, ".opencode", "dejavu", "log.jsonl"), "utf8")
check("heal event logged", healBLog.includes('"type":"healed"'))

// --- 38. PowerShell one-liners: call operator + quoted exe path + here-string ---
const PS_A = '& "C:\\venv\\python.exe" -c @"print(\'alpha\')"@'
const PS_B = '& "C:\\venv\\python.exe" -c @"print(\'beta\')"@'
const sigPSA = callSignature("bash", { command: PS_A }) ?? ""
const sigPSB = callSignature("bash", { command: PS_B }) ?? ""
check("powershell here-string payload is fingerprinted, @ markers gone", sigPSA.includes("<code:") && !sigPSA.includes("@"))
check("different here-string code gets different keys", sigPSA !== sigPSB)
check("fingerprinted powershell one-liner can block", canBlock("bash", sigPSA))

// --- 39. cmd /c unwrap: the payload IS the call ---
check(
  "cmd /c unwraps to the inner command (one identity, wrapper invisible)",
  callSignature("bash", { command: 'cmd /c "gradlew.bat :onyx-app:test"' }) === callSignature("bash", { command: "gradlew.bat :onyx-app:test" }),
)
check(
  "unwrapped cmd /c gradle test reaches the diagnostic tier",
  canRemind("bash", callSignature("bash", { command: 'cmd /c "gradlew.bat test"' }) ?? ""),
)
check("legacy cmd <path> <str> shape never enforces", !canBlock("bash", "bash:cmd <path> <str>") && !canRemind("bash", "bash:cmd <path> <str>"))

// --- 40. residual identity guard: over-generic shapes never enforce ---
check("wrapper verb with all-parameterized args cannot block", !canBlock("bash", "bash:node <str> <n> >& <n>"))
check("chain with unknown head keeps the identity of later segments", canRemind("bash", "bash:<str> ; mypy stitch_backend <n> >& <n>"))
check("plumbing-only segment carries no identity", !hasResidualIdentity("bash:select-object -last <n>"))
check("concrete commands keep their teeth", canBlock("bash", "bash:deploy-tool --prod <n>") && canBlock("bash", "bash:node scripts/run.mjs <n> >& <n>"))
check(
  "guard generalizes the legacy bare-one-liner rule",
  !hasResidualIdentity("bash:& <str> -c @ <str> @") && hasResidualIdentity("bash:python -c <code:14021754>"),
)

// --- 41. terminal control chars never reach disk ---
const ANSI_CMD = "ansi colored failure cmd"
await after(
  { tool: "bash", sessionID: "s70", callID: "a1", args: { command: ANSI_CMD } } as unknown as AfterInput,
  { title: ANSI_CMD, output: "\u001b[31;1mFATAL: boom\u001b[0m", metadata: {} } as unknown as AfterOutput,
)
gates = await readGates()
const ansiGate = gates.find((g) => g.signature === `bash:${ANSI_CMD}`)
check("ANSI escapes stripped from persisted snippet", ansiGate !== undefined && !ansiGate.snippet.includes("\u001b") && ansiGate.snippet.includes("FATAL: boom"))

// --- 42. mypy is diagnostic: remind-only, never blocking ---
const MYPY = "mypy stitch_backend"
await fail(MYPY, "s80", "m1")
await fail(MYPY, "s80", "m2")
await fail(MYPY, "s81", "m3")
gates = await readGates()
check("mypy promotes to remind-only (diagnostic)", gates.find((g) => g.signature === `bash:${MYPY}`)?.status === "reminding")

// --- 43. noise: empty search results and dismissed questions are not failures ---
await emitToolError("noise3", "grep_app_searchGitHub", "s90", "No results found for your query.\n\nIMPORTANT: literal code patterns only")
await emitToolError("noise4", "question", "s91", "The user dismissed this question")
gates = await readGates()
check("empty search result is noise, not a failure", !gates.some((g) => g.tool === "grep_app_searchGitHub"))
check("dismissed question is noise, not a failure", !gates.some((g) => g.tool === "question"))

// --- 44. feedback demotion by recurrence: an untaught gate surrenders ---
// Votes are post-REMINDER failures: each session is reminded first, then
// reoffends — failures the gate actually had a chance to prevent.
const fbDir = join(tmp, "feedback-project")
const FB_CMD = "deploy --to feedback"
const fbKey = patternKey(callSignature("bash", { command: FB_CMD }) ?? "")
await seedGates(fbDir, [seedGate({ key: fbKey, signature: `bash:${FB_CMD}` })])
const hooksFB = await Dejavu({ directory: fbDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (const s of ["fb1", "fb2", "fb3"]) {
  await attemptWith(hooksFB)(FB_CMD, s, `${s}-remind`)
  await failOn(hooksFB)(FB_CMD, s, `${s}-fail`)
}
let fbGates = await readJson(join(fbDir, ".opencode", "dejavu", "gates.json"))
const fbGate = fbGates.find((g) => g.key === fbKey)
check("enforced gate demoted after repeated post-reminder failures", fbGate?.status === "watching" && fbGate?.feedbackDemoted === true)
await failOn(hooksFB)(FB_CMD, "fb4", "fb4")
await failOn(hooksFB)(FB_CMD, "fb5", "fb5")
await failOn(hooksFB)(FB_CMD, "fb6", "fb6")
fbGates = await readJson(join(fbDir, ".opencode", "dejavu", "gates.json"))
check("feedback-demoted gate never re-promotes mechanically", fbGates.find((g) => g.key === fbKey)?.status === "watching")
check("demotion is logged", (await readFile(join(fbDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"type":"demoted"'))

// --- 45. feedback demotion by overrides: a bypassed gate surrenders ---
const ovDir = join(tmp, "override-project")
const OV_CMD = "deploy --to override"
const ovKey = patternKey(callSignature("bash", { command: OV_CMD }) ?? "")
await seedGates(ovDir, [seedGate({ key: ovKey, signature: `bash:${OV_CMD}` })])
const hooksOV = await Dejavu({ directory: ovDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (let i = 0; i < DEMOTE_OVERRIDES; i++) {
  await attemptWith(hooksOV)(`${OV_CMD} # dejavu:proceed`, `ov${i}`, `ov${i}`)
}
const ovGates = await readJson(join(ovDir, ".opencode", "dejavu", "gates.json"))
const ovGate = ovGates.find((g) => g.key === ovKey)
check("overrides are counted on the gate", ovGate?.overrideCount === DEMOTE_OVERRIDES)
check("gate demoted after repeated explicit bypasses", ovGate?.status === "watching" && ovGate?.feedbackDemoted === true)
check("demoted gate no longer interrupts", (await attemptWith(hooksOV)(OV_CMD, "ov9", "ov9")) === null)

// --- 45b. below-threshold overrides do NOT demote; baseline gives re-enforced gates a grace window ---
const graceDir = join(tmp, "grace-project")
const GRACE_CMD = "deploy --to grace"
const graceKey = patternKey(callSignature("bash", { command: GRACE_CMD }) ?? "")
await seedGates(graceDir, [seedGate({ key: graceKey, signature: `bash:${GRACE_CMD}` })])
const hooksGR = await Dejavu({ directory: graceDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (let i = 0; i < DEMOTE_OVERRIDES - 1; i++) {
  await attemptWith(hooksGR)(`${GRACE_CMD} # dejavu:proceed`, `gr${i}`, `gr${i}`)
}
let graceGates = await readJson(join(graceDir, ".opencode", "dejavu", "gates.json"))
check("overrides below threshold keep the gate enforced", graceGates.find((g) => g.key === graceKey)?.status === "blocking")
// Human re-enforces a previously demoted gate: the stale counters must not re-demotion instantly
await seedGates(graceDir, [
  seedGate({
    key: graceKey,
    signature: `bash:${GRACE_CMD}`,
    status: "blocking",
    recurredAfterGate: 3,
    overrideCount: 0,
    feedbackBaseline: { recurred: 3, overrides: 0 },
  }),
])
const hooksGR2 = await Dejavu({ directory: graceDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksGR2)(GRACE_CMD, "grx1", "grx1")
graceGates = await readJson(join(graceDir, ".opencode", "dejavu", "gates.json"))
check("re-enforced gate gets a fresh grace window (baseline offsets stale counters)", graceGates.find((g) => g.key === graceKey)?.status === "blocking")
// Exhaust the fresh window with post-reminder reoffenses across sessions
for (const s of ["grx2", "grx3"]) {
  await attemptWith(hooksGR2)(GRACE_CMD, s, `${s}-remind`)
  await failOn(hooksGR2)(GRACE_CMD, s, `${s}-fail`)
}
graceGates = await readJson(join(graceDir, ".opencode", "dejavu", "gates.json"))
check("re-enforced gate demotes again once the fresh window is exhausted", graceGates.find((g) => g.key === graceKey)?.status === "watching")

// --- 46. migrate catch-up: gates already past the threshold demote on init ---
const catchDir = join(tmp, "catchup-project")
const catchSig = callSignature("bash", { command: "catch up cmd" }) ?? ""
await seedGates(catchDir, [seedGate({ key: patternKey(catchSig), signature: catchSig, recurredAfterGate: 3, reoffenseSessions: ["c1", "c2"] })])
await Dejavu({ directory: catchDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const catchGates = await readJson(join(catchDir, ".opencode", "dejavu", "gates.json"))
const catchGate = catchGates.find((g) => g.key === patternKey(catchSig))
check("migrate demotes gates already past the recurrence threshold", catchGate?.status === "watching" && catchGate?.feedbackDemoted === true)

// --- 47. cmd wrapper variants and composition ---
check(
  "cmd /k and cmd.exe /s /c unwrap identically",
  callSignature("bash", { command: "cmd /k build.bat" }) === callSignature("bash", { command: "build.bat" }) &&
    callSignature("bash", { command: 'cmd.exe /s /c "build.bat"' }) === callSignature("bash", { command: "build.bat" }),
)
const cmdPy = callSignature("bash", { command: 'cmd /c python -c "print(\'x\')"' }) ?? ""
check("cmd /c around an interpreter one-liner unwraps AND fingerprints", cmdPy.startsWith("bash:python -c <code:") && canBlock("bash", cmdPy))
check("cmd unwrap is idempotent", normalizeCommand(normalizeCommand("cmd /c gradlew test")) === normalizeCommand("cmd /c gradlew test"))
check("cmd without /c is not unwrapped", (callSignature("bash", { command: "cmd something" }) ?? "").startsWith("bash:cmd something"))
check(
  "chain segments unwrap cmd /c individually (bypass protection keeps working)",
  bashSegmentSignatures("echo ok && cmd /c gradlew test").includes("bash:gradlew test"),
)

// --- 48. control chars: commands, error text, historical gate data ---
check(
  "commands carrying ANSI normalize to the clean form",
  callSignature("bash", { command: "\u001b[32mgit status\u001b[0m" }) === callSignature("bash", { command: "git status" }),
)
check("parameterizeError strips control chars", !parameterizeError("\u001b[31mENOENT: no such file\u001b[0m").includes("\u001b"))
check("stripControl keeps structure (LF/TAB) but drops escapes and NUL", stripControl("a\u001b[31mb\u0000c\td\ne") === "abc\td\ne")
const ansiHistDir = join(tmp, "ansi-history-project")
const ansiHistSig = callSignature("bash", { command: "legacy ansi cmd" }) ?? ""
await seedGates(ansiHistDir, [
  seedGate({
    key: patternKey(ansiHistSig),
    signature: ansiHistSig,
    status: "watching",
    snippet: "\u001b[31mold red error\u001b[0m",
    correction: "fix: \u001b[33mthe thing\u001b[0m",
  }),
])
await Dejavu({ directory: ansiHistDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const ansiHistGate = (await readJson(join(ansiHistDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === patternKey(ansiHistSig))
check(
  "historical gates are sanitized on init (snippet + correction)",
  ansiHistGate !== undefined && !ansiHistGate.snippet.includes("\u001b") && !(ansiHistGate.correction ?? "").includes("\u001b") && ansiHistGate.snippet.includes("old red error"),
)

// --- 49. doctor discovers project stores from the global index ---
const docGlobal = join(tmp, "doctor-global")
const docProject = join(tmp, "doctor-project")
await mkdir(docGlobal, { recursive: true })
await mkdir(join(docProject, ".opencode", "dejavu"), { recursive: true })
await writeFile(join(docGlobal, "gates.json"), JSON.stringify({ version: 1, gates: [] }), "utf8")
await writeFile(join(docProject, ".opencode", "dejavu", "gates.json"), JSON.stringify({ version: 1, gates: [] }), "utf8")
await writeFile(
  join(docGlobal, "index.json"),
  JSON.stringify({ version: 1, keys: { abcdef123456: { projects: [docProject], lastSeen: new Date().toISOString() } } }),
  "utf8",
)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const doctorRun = spawnSync(process.execPath, [join(repoRoot, "scripts", "doctor.ts")], {
  env: { ...process.env, DEJAVU_HOME: docGlobal },
  encoding: "utf8",
})
const doctorOut = doctorRun.stdout
check("doctor without args discovers project stores from the index", doctorOut.includes("discovered 1 project store(s)"))
check("doctor report covers the discovered project scope", doctorOut.includes(docProject))

// --- 50. interpreter flag spellings converge (alternation order matters) ---
check(
  "pwsh -Command and -c with the same payload normalize to one signature",
  callSignature("bash", { command: 'pwsh -Command "Get-Thing"' }) === callSignature("bash", { command: 'pwsh -c "Get-Thing"' }),
)
check(
  "powershell -EncodedCommand converges with -c (no swallowed flag-name debris)",
  callSignature("bash", { command: "powershell -EncodedCommand aGVsbG8=" }) === callSignature("bash", { command: "powershell -c aGVsbG8=" }) &&
    !(callSignature("bash", { command: 'pwsh -Command "Get-Thing"' }) ?? "").includes("-c<code:"),
)
const PY_LAUNCH_A = 'py -3 -c "import alpha"'
const PY_LAUNCH_B = 'py -3 -c "import beta"'
const pyLaunchSig = callSignature("bash", { command: PY_LAUNCH_A }) ?? ""
check("windows py launcher one-liners are fingerprinted (not flattened)", pyLaunchSig.includes("<code:") && !pyLaunchSig.includes("<str>"))
check("different py launcher payloads get different keys", pyLaunchSig !== callSignature("bash", { command: PY_LAUNCH_B }))

// --- 51. guard bypasses closed: -m modules, shell builtins heading chains ---
check("python -m <str> (quoted module) carries no identity", !canBlock("bash", "bash:python -m <str>") && !canRemind("bash", "bash:python -m <str>"))
check("python -m with a literal module keeps identity", canBlock("bash", "bash:python -m http.server <n>"))
check("cd heading a fully-parameterized chain grants no identity", !canBlock("bash", "bash:cd <path> && python <path>"))
check("bare cd <path> never enforces", !hasResidualIdentity("bash:cd <path>"))

// --- 52. cmd /c inner chains: gates fire through the wrapper; marker visible ---
const INNER_CMD = "inner gated deploy run"
await fail(INNER_CMD, "in1", "in1")
await fail(INNER_CMD, "in1", "in2")
await fail(INNER_CMD, "in2", "in3")
gates = await readGates()
check("inner-chain fixture promoted", gates.some((g) => g.signature === `bash:${INNER_CMD}` && g.status === "blocking"))
check(
  "segment expansion unfolds cmd /c payloads (inner chain visible)",
  bashSegmentSignatures(`cmd /c "echo ok && ${INNER_CMD}"`).includes(`bash:${INNER_CMD}`),
)
const viaWrapper = await attempt(`cmd /c "echo ok && ${INNER_CMD}"`, "in3", "in4")
check("gate fires through a cmd /c inner chain", viaWrapper !== null && viaWrapper.message.includes("[dejavu] REMINDER"))
const markerThroughWrapper = await attempt(`cmd /c "${INNER_CMD} # dejavu:proceed"`, "in3", "in5")
check("override marker inside a leading cmd /c payload is honored", markerThroughWrapper === null)
check(
  "marker smuggled in INNER quotes of a cmd payload still does not bypass",
  (await attempt(`cmd /c "echo \\"dejavu:proceed\\" && ${INNER_CMD}"`, "in4", "in6")) !== null,
)

// --- 53. over-generic shapes never fuzzy-match concrete gates ---
const fuzzyGuardDir = join(tmp, "fuzzy-guard-project")
const concreteSig = "bash:node abcdefgh <n> | select-object -last <n>"
await seedGates(fuzzyGuardDir, [seedGate({ key: patternKey(concreteSig), signature: concreteSig })])
const hooksFG = await Dejavu({ directory: fuzzyGuardDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const genericSig = callSignature("bash", { command: 'node "whatever" 5 | Select-Object -Last 20' }) ?? ""
check("test fixture really would fuzzy-match without the guard", fuzzySimilar(genericSig, concreteSig))
check("over-generic incoming signature has no residual identity", !hasResidualIdentity(genericSig))
check("over-generic incoming signature does not enforce via fuzzy", (await attemptWith(hooksFG)('node "whatever" 5 | Select-Object -Last 20', "fg1", "fg1")) === null)
await failOn(hooksFG)('node "whatever" 5 | Select-Object -Last 20', "fg2", "fg2")
const fgGates = await readJson(join(fuzzyGuardDir, ".opencode", "dejavu", "gates.json"))
check("over-generic failure does not consolidate into the concrete gate", fgGates.find((g) => g.key === patternKey(concreteSig))?.count === 3)

// --- 54. concurrency hammer: two instances, parallel failures, one store ---
const hammerDir = join(tmp, "hammer-project")
const hooksHM1 = await Dejavu({ directory: hammerDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const hooksHM2 = await Dejavu({ directory: hammerDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const HAMMER_CMD = "hammer shared load cmd"
const hammerFail = (hooks: Awaited<ReturnType<typeof Dejavu>>) => (session: string, callID: string): Promise<void> =>
  (hooks["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: session, callID, args: { command: HAMMER_CMD } } as unknown as AfterInput,
    { title: HAMMER_CMD, output: "npm ERR! boom\nExit code: 1", metadata: {} } as unknown as AfterOutput,
  )
const hammerJobs: Promise<void>[] = []
for (let i = 0; i < 12; i++) {
  hammerJobs.push(hammerFail(hooksHM1)(`hm-${i % 3}`, `hm1-${i}`))
  hammerJobs.push(hammerFail(hooksHM2)(`hm-${i % 3}`, `hm2-${i}`))
}
await Promise.all(hammerJobs)
const hammerGates = await readJson(join(hammerDir, ".opencode", "dejavu", "gates.json"))
check("concurrent failures from two instances lose no updates", hammerGates.find((g) => g.signature === `bash:${HAMMER_CMD}`)?.count === 24)
const hammerLog = (await readFile(join(hammerDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "")
check(
  "concurrent log appends stay parseable",
  hammerLog.length > 0 &&
    hammerLog.every((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    }),
)

// --- 55. root B-2: a success clears the session's remind→block chain ---
const chainDir = join(tmp, "chain-reset-project")
const CHAIN_CMD = "chain reset deploy cmd"
const chainSig = callSignature("bash", { command: CHAIN_CMD }) ?? ""
const chainKey = patternKey(chainSig)
await seedGates(chainDir, [seedGate({ key: chainKey, signature: chainSig })])
const hooksCH = await Dejavu({ directory: chainDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
check("chain fixture: first attempt reminds", (await attemptWith(hooksCH)(CHAIN_CMD, "ch-ses", "ch1"))?.message.includes("[dejavu] REMINDER") === true)
await new Promise((resolve) => setTimeout(resolve, 600))
await failOn(hooksCH)(CHAIN_CMD, "ch-ses", "ch2") // retry fails -> failedSessions[ch-ses]
check("chain fixture: repeat offense blocks", (await attemptWith(hooksCH)(CHAIN_CMD, "ch-ses", "ch3"))?.message.includes("[dejavu] BLOCKED") === true)
await (hooksCH["tool.execute.after"] as AfterHook)(
  { tool: "bash", sessionID: "ch-ses", callID: "ch4", args: { command: CHAIN_CMD } } as unknown as AfterInput,
  { title: CHAIN_CMD, output: "ok", metadata: { exit: 0 } } as unknown as AfterOutput,
)
const chainGate = (await readJson(join(chainDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === chainKey)
check("success clears failedSessions for the session", chainGate?.failedSessions?.["ch-ses"] === undefined)
check("success clears remindedSessions for the session", chainGate?.remindedSessions?.["ch-ses"] === undefined)
check("session unblocked after proving the fix (heal-aware: runs free, no reminder)", (await attemptWith(hooksCH)(CHAIN_CMD, "ch-ses", "ch5")) === null)

// --- 56. iteration runners remind but never block ---
const iterDir = join(tmp, "iteration-project")
const hooksIT = await Dejavu({ directory: iterDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const DART_RUN = "dart run scripts/gen_tags.dart"
await failOn(hooksIT)(DART_RUN, "it1", "it1")
await failOn(hooksIT)(DART_RUN, "it1", "it2")
await failOn(hooksIT)(DART_RUN, "it2", "it3")
const itGates = await readJson(join(iterDir, ".opencode", "dejavu", "gates.json"))
check("dart run promotes to remind-only (iteration verb)", itGates.find((g) => g.signature === `bash:${DART_RUN}`)?.status === "reminding")
check("reminding-tier gate never interrupts the iteration run", (await attemptWith(hooksIT)(DART_RUN, "it3", "it4")) === null)
const dartOut = { title: DART_RUN, output: "npm ERR! boom\nExit code: 1", metadata: {} }
await (hooksIT["tool.execute.after"] as AfterHook)(
  { tool: "bash", sessionID: "it3", callID: "it4", args: { command: DART_RUN } } as unknown as AfterInput,
  dartOut as unknown as AfterOutput,
)
check("reminding-tier note says the run was NOT interrupted", dartOut.output.includes("NOT interrupted"))

// --- 57. overrides of reminding gates are not counted toward demotion ---
const ovRemDir = join(tmp, "override-reminding-project")
const OV_REM_SIG = "bash:pytest tests/test_x.py"
await seedGates(ovRemDir, [seedGate({ key: patternKey(OV_REM_SIG), signature: OV_REM_SIG, status: "reminding" })])
const hooksOR = await Dejavu({ directory: ovRemDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (let i = 0; i < DEMOTE_OVERRIDES + 1; i++) {
  await attemptWith(hooksOR)(`pytest tests/test_x.py # dejavu:proceed`, `or${i}`, `or${i}`)
}
const orGates = await readJson(join(ovRemDir, ".opencode", "dejavu", "gates.json"))
const orGate = orGates.find((g) => g.key === patternKey(OV_REM_SIG))
check("reminding-tier overrides are not counted on the gate", orGate?.overrideCount === 0)
check("reminding gate survives mass overrides (no demotion)", orGate?.status === "reminding" && orGate?.feedbackDemoted !== true)

// --- 58. index churn: EVERY failure is indexed (the old count<2 skip starved
// once-per-project patterns of cross-project escalation evidence) ---
const idxGateDir = join(tmp, "index-gate-project")
const hooksIG = await Dejavu({ directory: idxGateDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const IDX_CMD = "index gate probe cmd"
const idxKey = patternKey(callSignature("bash", { command: IDX_CMD }) ?? "")
await failOn(hooksIG)(IDX_CMD, "ig1", "ig1")
const idxAfterOne = JSON.parse(await readFile(join(tmp, "global", "index.json"), "utf8")) as { keys: Record<string, unknown> }
check("first failure is indexed (cross-project escalation evidence)", idxAfterOne.keys[idxKey] !== undefined)
await failOn(hooksIG)(IDX_CMD, "ig1", "ig2")
const idxAfterTwo = JSON.parse(await readFile(join(tmp, "global", "index.json"), "utf8")) as { keys: Record<string, unknown> }
check("second failure keeps the pattern indexed", idxAfterTwo.keys[idxKey] !== undefined)

// --- 59. garbage dates cannot make a gate immortal ---
const dateDir = join(tmp, "dates-project")
const dateSig = callSignature("bash", { command: "garbage dates cmd" }) ?? ""
await seedGates(dateDir, [seedGate({ key: patternKey(dateSig), signature: dateSig, firstSeen: "not-a-date", lastSeen: "also-garbage" })])
await Dejavu({ directory: dateDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const dateGate = (await readJson(join(dateDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === patternKey(dateSig))
check("unparseable dates reset to a real date (no immortal gates)", dateGate !== undefined && !Number.isNaN(Date.parse(dateGate.firstSeen)) && !Number.isNaN(Date.parse(dateGate.lastSeen)))

// --- 60. doctor --repair prunes true orphans (it sees every scope) ---
const orphanKey = "deadbeef0123"
const idxPath = join(docGlobal, "index.json")
const idxDoc = JSON.parse(await readFile(idxPath, "utf8")) as { keys: Record<string, unknown> }
idxDoc.keys[orphanKey] = { projects: [docProject], lastSeen: new Date().toISOString() }
await writeFile(idxPath, JSON.stringify(idxDoc), "utf8")
spawnSync(process.execPath, [join(repoRoot, "scripts", "doctor.ts"), "--repair"], {
  env: { ...process.env, DEJAVU_HOME: docGlobal },
  encoding: "utf8",
})
const idxRepaired = JSON.parse(await readFile(idxPath, "utf8")) as { keys: Record<string, unknown> }
check("doctor --repair prunes true-orphan index keys", idxRepaired.keys[orphanKey] === undefined)

// --- 61. migrate never re-promotes feedback-demoted gates ---
const reDemoDir = join(tmp, "remigrate-project")
const RE_DEMO_SIG = "bash:pytest tests/test_redemo.py"
await seedGates(reDemoDir, [
  seedGate({
    key: patternKey(RE_DEMO_SIG),
    signature: RE_DEMO_SIG,
    status: "watching",
    feedbackDemoted: true,
    feedbackBaseline: { recurred: 3, overrides: 0 },
    recurredAfterGate: 3,
  }),
])
await Dejavu({ directory: reDemoDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const reDemoGates = await readJson(join(reDemoDir, ".opencode", "dejavu", "gates.json"))
check("migrate does not re-promote feedback-demoted gates", reDemoGates.find((g) => g.key === patternKey(RE_DEMO_SIG))?.status === "watching")

// --- 61b. migrate never re-promotes a retired (retireBaseline) gate — the
// damping invariant ("re-promotion needs a fresh bar") must hold on EVERY
// mechanical path, not just recordFailure. Without the exemption a healed
// diagnostic gate's lifetime count clears the catch-up bar and re-promotes on
// every migrate, re-opening the promote→heal→promote oscillation. ---
const migHealDir = join(tmp, "migrate-heal-project")
const MIG_HEAL_SIG = "bash:pytest tests/test_migheal.py"
await seedGates(migHealDir, [
  seedGate({
    key: patternKey(MIG_HEAL_SIG),
    signature: MIG_HEAL_SIG,
    status: "watching",
    count: 3,
    sessions: ["mh1", "mh2"],
    retireBaseline: { count: 3 },
  }),
])
await Dejavu({ directory: migHealDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const migHealGates = await readJson(join(migHealDir, ".opencode", "dejavu", "gates.json"))
check("migrate does not re-promote a retired (retireBaseline) gate", migHealGates.find((g) => g.key === patternKey(MIG_HEAL_SIG))?.status === "watching")

// --- 62. success heals/clears only on exact match (no proxy healing) ---
const proxyDir = join(tmp, "proxy-success-project")
const PROXY_SIG = "bash:deploy --to alpha"
await seedGates(proxyDir, [seedGate({ key: patternKey(PROXY_SIG), signature: PROXY_SIG })])
const hooksPX = await Dejavu({ directory: proxyDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const proxyVariant = callSignature("bash", { command: "deploy --to beta" }) ?? ""
check("fixture variant really is fuzzy-similar to the gated command", fuzzySimilar(proxyVariant, PROXY_SIG))
await (hooksPX["tool.execute.after"] as AfterHook)(
  { tool: "bash", sessionID: "px1", callID: "px1", args: { command: "deploy --to beta" } } as unknown as AfterInput,
  { title: "deploy", output: "ok", metadata: { exit: 0 } } as unknown as AfterOutput,
)
const pxGate = (await readJson(join(proxyDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === patternKey(PROXY_SIG))
check("fuzzy proxy success does not heal or clear chains", (pxGate?.succeededAfterGate ?? 0) === 0 && pxGate?.status === "blocking")

// --- 63. override marker requires comment syntax (no smuggling as data) ---
check("unquoted marker smuggled into a chain segment does not bypass", (await attempt(`echo dejavu:proceed && ${CMD}`, "sm1", "sm1")) !== null)
check("bare marker without '#' does not bypass", (await attempt(`${CMD} dejavu:proceed`, "sm2", "sm2")) !== null)
check("comment-form marker still bypasses", (await attempt(`${CMD} # dejavu:proceed`, "sm3", "sm3")) === null)

// --- 64. exit-1 immunity requires every chain segment to be diagnostic ---
check("mixed chain loses exit-1 immunity (deploy failure not hidden by grep)", !isIntendedNonzero("deploy --broken && grep done log.txt", 1))
check("all-diagnostic chain keeps exit-1 immunity", isIntendedNonzero("grep a file && grep b file", 1))
check("single diagnostic command keeps exit-1 immunity", isIntendedNonzero("grep foo bar.txt", 1))
check("exit 2 is never intended", !isIntendedNonzero("grep foo bar.txt", 2))
// Pipe-formatter and navigation transparency: a formatter/navigation segment can
// never be the failing producer, so it must not break a diagnostic's immunity.
check("pipe to Select-Object keeps the diagnostic's immunity", isIntendedNonzero("flutter test --no-pub 2>&1 | Select-Object -Last 5", 1))
check("pipe to Tee-Object keeps the diagnostic's immunity", isIntendedNonzero("npx tsc --noEmit 2>&1 | Tee-Object -filepath out.txt", 1))
check("leading cd does not break the diagnostic's immunity", isIntendedNonzero("cd D:\\proj && npx tsc --noEmit 2>&1", 1))
check("npm test is a diagnostic (tests failing = the work)", isIntendedNonzero("npm test", 1))
check("npm run test:bdd is a diagnostic", isIntendedNonzero("npm run test:bdd 2>&1 | Select-Object -Last 5", 1))
check("yarn/pnpm test are diagnostics", isIntendedNonzero("yarn test", 1) && isIntendedNonzero("pnpm test", 1))
// Transparency must not hide a real non-diagnostic producer: npm install piped
// to a formatter still counts (npm install is not a diagnostic).
check("non-diagnostic piped to a formatter still counts", !isIntendedNonzero("npm install | Select-Object -Last 5", 1))
check("non-diagnostic after cd still counts", !isIntendedNonzero("cd D:\\proj && npm install", 1))
check("npm run build is not a test runner (build failures gate)", !isIntendedNonzero("npm run build", 1))
// Unix output shapers are formatters too — piping a diagnostic into one must
// keep immunity (real data: `npx vitest … | head -5`, `git show … | head`).
check("pipe to unix head keeps the diagnostic's immunity", isIntendedNonzero("npx vitest run 2>&1 | head - 5", 1))
check("pipe to unix tail keeps the diagnostic's immunity", isIntendedNonzero("pytest -q 2>&1 | tail -n 5", 1))
check("cd + vitest piped to head keeps immunity", isIntendedNonzero("cd D:\\proj && npx vitest run src/tests/x.test.ts 2>&1 | head - 5", 1))
check("non-diagnostic piped to head still counts", !isIntendedNonzero("npm install | head - 5", 1))
// Formatter transparency is PIPE-POSITION only: a formatter as the TERMINAL
// producer of a sequence is the failing producer — its exit must still count
// (kimi3-verifier counterexample: `npm test` exits 0 under &&, the exit 1 is
// tail's file-not-found, a real recurring mistake).
check("formatter as terminal producer still counts (&&)", !isIntendedNonzero("npm test && tail -5 missing.log", 1))
check("formatter as terminal producer still counts (;)", !isIntendedNonzero("pytest -q; head -5 missing.log", 1))
check("formatter after || is a producer, not a pipe tail", !isIntendedNonzero("npm test || tail -5 missing.log", 1))

// Navigation is transparent only when PURE: a navigation verb paired with a
// diagnostic and NO separator between them must keep the diagnostic — dropping
// the whole segment as navigation hid the command and broke immunity (prod:
// `cd <path> npx vitest run ...` was being gated).
check("cd + diagnostic in one segment keeps immunity", isIntendedNonzero("cd packages/sourcesiphon npx vitest run src/tests/walker.test.ts 2>&1 | Select-Object -Last 5", 1))
check("pure cd alone still counts (not immune)", !isIntendedNonzero("cd /nonexistent/path", 1))
check("cd && diagnostic keeps immunity (separator form)", isIntendedNonzero("cd packages/foo && npx vitest run 2>&1 | Select-Object -Last 5", 1))

// Subshell-paren flattening must NOT break PowerShell script blocks: the () in
// a method call inside { } (e.g. ForEach-Object { $_.trim() }) is part of that
// segment, not a chain separator (prod: select-string | ForEach-Object was gated).
check("script-block method-call parens keep immunity", isIntendedNonzero("Select-String -path tests\\foo.test.ts -pattern bar | ForEach-Object { $_.line.trim() }", 1))
check("(deploy && grep) still splits — non-diagnostic not hidden", !isIntendedNonzero("(deploy --broken && grep done log.txt)", 1))

// npm/pnpm/yarn typecheck + lint are iteration work (the typecheck gap: prod
// `npm run typecheck` reminded 20+ times because only `npm test` was a
// diagnostic). Includes the `--filter <pkg>` form.
check("npm run typecheck is a diagnostic", isIntendedNonzero("npm run typecheck 2>&1", 1))
check("npm run lint is a diagnostic", isIntendedNonzero("npm run lint 2>&1 | Select-Object -Last 3", 1))
check("pnpm --filter typecheck is a diagnostic", isIntendedNonzero("pnpm --filter @midasai/midas-ui typecheck 2>&1 | Select-Object -Last 5", 1))
// Read-only git inspectors: exit 1 is a downstream filter finding nothing
// (`git show … | Select-String` no-match), not a mistake (the Muffin case).
check("git show piped to Select-String keeps immunity", isIntendedNonzero("git show head:file.cs | Select-String -Pattern x", 1))
check("git show --stat piped to head keeps immunity", isIntendedNonzero("git show --stat abc123 | head - 5", 1))
check("git log piped to Select-String keeps immunity", isIntendedNonzero("git log --oneline -5 | Select-String -Pattern fix", 1))
check("git show with real error (exit 2) still counts", !isIntendedNonzero("git show badref", 2))
check("npm run build is NOT a diagnostic (real failure)", !isIntendedNonzero("npm run build 2>&1", 1))

// --- 65. taught retirement: clean reminders retire the gate softly ---
const taughtDir = join(tmp, "taught-project")
const TAUGHT_CMD = "taught retirement cmd"
const taughtKey = patternKey(callSignature("bash", { command: TAUGHT_CMD }) ?? "")
await seedGates(taughtDir, [seedGate({ key: taughtKey, signature: `bash:${TAUGHT_CMD}`, remindedCount: 4 })])
const hooksTA = await Dejavu({ directory: taughtDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const taughtRemind = await attemptWith(hooksTA)(TAUGHT_CMD, "ta1", "ta1")
check("the retirement reminder is still delivered", taughtRemind !== null && taughtRemind.message.includes("[dejavu] REMINDER"))
check("gate with 5 clean reminders retires to watching (taught)", (await readJson(join(taughtDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === taughtKey)?.status === "watching")
check("retirement logged as retired-taught", (await readFile(join(taughtDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"type":"retired-taught"'))
check("retired gate no longer reminds", (await attemptWith(hooksTA)(TAUGHT_CMD, "ta2", "ta2")) === null)

// --- 65b. anti-nag retirement: a blocking gate whose reminders are consistently
// ignored (agent reoffends in-session right after being reminded) nags instead of
// teaching — retire it and stop interrupting. Mirror of taught retirement, but
// marks feedbackDemoted so it does not mechanically re-promote. ---
const antiNagDir = join(tmp, "antinag-project")
const ANTI_NAG_CMD = "anti nag deploy cmd"
const antiNagKey = patternKey(callSignature("bash", { command: ANTI_NAG_CMD }) ?? "")
await seedGates(antiNagDir, [
  seedGate({ key: antiNagKey, signature: `bash:${ANTI_NAG_CMD}`, status: "blocking", remindedCount: 5, recurredAfterReminder: 3, recurredAfterGate: 0 }),
])
const hooksAN = await Dejavu({ directory: antiNagDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const antiNagResult = await attemptWith(hooksAN)(ANTI_NAG_CMD, "an1", "an1")
const antiNagGate = (await readJson(join(antiNagDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === antiNagKey)
check("anti-nag: ignored-reminder gate retires to watching + feedbackDemoted", antiNagGate?.status === "watching" && antiNagGate?.feedbackDemoted === true)
check("anti-nag: the nagging call proceeds without interruption", antiNagResult === null)
check("anti-nag: retirement logged", (await readFile(join(antiNagDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes("anti-nag retirement"))
check("anti-nag: counters reset so a manual re-enforce gets a fresh start", antiNagGate?.remindedCount === 0 && antiNagGate?.recurredAfterReminder === 0)
check("anti-nag: gate no longer reminds afterwards", (await attemptWith(hooksAN)(ANTI_NAG_CMD, "an2", "an2")) === null)

// --- 65c. anti-nag must NOT fire on a reminding gate. recurredAfterReminder
// accrues only while blocking, but a tier demotion (repairGate/migrate) keeps
// the stale counter: npm test became diagnostic in 2.17.0, so a legacy BLOCKING
// npm-test gate with recurredAfterReminder>=3 is demoted to reminding at init
// and must not then be retired on that stale evidence. ---
const antiNagRemindDir = join(tmp, "antinag-remind-project")
const ANTI_NAG_REMIND_CMD = "npm test"
const antiNagRemindKey = patternKey(callSignature("bash", { command: ANTI_NAG_REMIND_CMD }) ?? "")
await seedGates(antiNagRemindDir, [
  // recurredAfterGate>0 blocks the taught check, so this isolates the anti-nag
  // status guard (the gate must stay reminding, not be retired by anti-nag).
  seedGate({ key: antiNagRemindKey, signature: `bash:${ANTI_NAG_REMIND_CMD}`, status: "blocking", remindedCount: 4, recurredAfterReminder: 3, recurredAfterGate: 2 }),
])
const hooksANR = await Dejavu({ directory: antiNagRemindDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await attemptWith(hooksANR)(ANTI_NAG_REMIND_CMD, "anr1", "anr1")
const antiNagRemindGate = (await readJson(join(antiNagRemindDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === antiNagRemindKey)
check("anti-nag: a reminding gate with a stale counter is NOT retired", antiNagRemindGate?.feedbackDemoted !== true && antiNagRemindGate?.status !== "watching")

// --- 65d. a tier demotion clears the stale recurredAfterReminder at the
// transition; reminding gates accrue it fresh in the after-hook. ---
const staleCtrDir = join(tmp, "stale-counter-project")
const STALE_CTR_CMD = "npm test"
const staleCtrKey = patternKey(callSignature("bash", { command: STALE_CTR_CMD }) ?? "")
await seedGates(staleCtrDir, [
  seedGate({ key: staleCtrKey, signature: `bash:${STALE_CTR_CMD}`, status: "blocking", remindedCount: 4, recurredAfterReminder: 3, recurredAfterGate: 0 }),
])
const hooksStaleCtr = await Dejavu({ directory: staleCtrDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await attemptWith(hooksStaleCtr)(STALE_CTR_CMD, "stc1", "stc1")
const staleCtrGate = (await readJson(join(staleCtrDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === staleCtrKey)
check("tier demotion clears the stale recurredAfterReminder", staleCtrGate?.status === "reminding" && staleCtrGate?.recurredAfterReminder === 0)
check("demoted reminding gate never interrupts the call", (await attemptWith(hooksStaleCtr)(STALE_CTR_CMD, "stc2", "stc2")) === null)
await failOn(hooksStaleCtr)(STALE_CTR_CMD, "stc3", "stc3-f1")
await failOn(hooksStaleCtr)(STALE_CTR_CMD, "stc3", "stc3-f2")
const staleCtrGate2 = (await readJson(join(staleCtrDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === staleCtrKey)
check("demoted gate is not anti-nag-retired on the previous tier's evidence", staleCtrGate2?.status === "reminding" && staleCtrGate2?.feedbackDemoted !== true)

// --- 65e. bash `|&` (pipe stdout+stderr) is a pipe, and unix `tee` is a
// formatter — both were kimi3-verifier blind spots. ---
check("bash |& keeps the diagnostic's immunity", isIntendedNonzero("npm test |& head -5", 1))
check("diagnostic piped to tee keeps immunity", isIntendedNonzero("npm test 2>&1 | tee out.log", 1))
check("non-diagnostic piped to tee still counts", !isIntendedNonzero("npm install | tee out.log", 1))

// --- 65f. anti-nag for reminding gates accrues in the after-hook: notes the
// session keeps ignoring retire the gate. ---
const nagRemDir = join(tmp, "antinag-note-project")
const NAG_REM_CMD = "npm test"
const nagRemKey = patternKey(callSignature("bash", { command: NAG_REM_CMD }) ?? "")
await seedGates(nagRemDir, [seedGate({ key: nagRemKey, signature: `bash:${NAG_REM_CMD}`, status: "reminding", remindedCount: 4 })])
const hooksNR = await Dejavu({ directory: nagRemDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (const call of ["nr-f1", "nr-f2", "nr-f3", "nr-f4"]) await failOn(hooksNR)(NAG_REM_CMD, "nr-ses", call)
const nagRemGate = (await readJson(join(nagRemDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === nagRemKey)
check("anti-nag (after-hook): ignored notes retire the reminding gate", nagRemGate?.status === "watching" && nagRemGate?.feedbackDemoted === true)
check("anti-nag (after-hook): retirement is logged", (await readFile(join(nagRemDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes("anti-nag retirement"))
check("anti-nag (after-hook): counters reset for a manual re-enforce", nagRemGate?.remindedCount === 0 && nagRemGate?.recurredAfterReminder === 0)

// --- 66. env-prefixed interpreter one-liners are fingerprinted ---
const envSig = callSignature("bash", { command: 'PYTHONPATH=x python -c "print(1)"' }) ?? ""
check("env-prefixed one-liner is fingerprinted, not flattened", envSig.includes("<code:") && !envSig.includes("<str>"))

// --- 67. mergeGate preserves the reminding tier ---
const rankTarget = seedGate({ key: "aaaa22222222", status: "watching" }) as unknown as Gate
const rankSource = seedGate({ key: "aaaa22222222", status: "reminding" }) as unknown as Gate
mergeGate(rankTarget, rankSource)
check("mergeGate preserves the reminding tier", rankTarget.status === "reminding")

// --- 68. flood guard evicts feedback-demoted dead weight first, visibly ---
const floodDir = join(tmp, "flood-project")
const floodSeed: Record<string, unknown>[] = []
for (let i = 0; i < 2000; i++) {
  floodSeed.push(
    seedGate({
      key: i.toString(16).padStart(12, "0"),
      signature: `bash:flood filler cmd ${i}`,
      status: "watching",
      count: i === 0 ? 99 : 3,
      ...(i === 0 ? { feedbackDemoted: true } : {}),
    }),
  )
}
await seedGates(floodDir, floodSeed)
const hooksFL = await Dejavu({ directory: floodDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksFL)("flood new pattern cmd", "fl1", "fl1")
const flGates = await readJson(join(floodDir, ".opencode", "dejavu", "gates.json"))
check("flood guard evicts the feedback-demoted gate first", !flGates.some((g) => g.key === "000000000000") && flGates.some((g) => g.signature === "bash:flood new pattern cmd"))
check("low-count teaching gate survives the eviction", flGates.some((g) => g.key === "000000000001"))
check("eviction is logged", (await readFile(join(floodDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes("flood guard evicted"))
check("store stays at the cap", flGates.length === 2000)

// --- 69. log rotation truncates oversized logs ---
const rotDir = join(tmp, "rotate-project")
await mkdir(rotDir, { recursive: true })
const bigLog = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ ts: "2026-08-30T00:00:00.000Z", type: "detected", key: "k", pad: "x".repeat(400), i })).join("\n") + "\n"
await writeFile(join(rotDir, "log.jsonl"), bigLog, "utf8")
await new Stores(new GateStore(join(tmp, "rotate-global")), new GateStore(rotDir)).rotateLogs()
const rotLines = (await readFile(join(rotDir, "log.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "")
check("rotateLog truncates an oversized log to the kept window", rotLines.length > 0 && rotLines.length <= 1000)

// --- 70. forgetSession clears persisted session state ---
const forgetDir = join(tmp, "forget-project")
const forgetSig = callSignature("bash", { command: "forget session cmd" }) ?? ""
await seedGates(forgetDir, [seedGate({ key: patternKey(forgetSig), signature: forgetSig, remindedSessions: { "fs-ses": Date.now() }, failedSessions: { "fs-ses": Date.now() } })])
await new Stores(new GateStore(join(tmp, "forget-global")), new GateStore(join(forgetDir, ".opencode", "dejavu"))).forgetSession("fs-ses")
const forgetGate = (await readJson(join(forgetDir, ".opencode", "dejavu", "gates.json")))[0]
check("forgetSession clears session state from the gate", forgetGate?.remindedSessions === undefined && forgetGate?.failedSessions === undefined)

// --- 71. lock contention degrades to unlocked after the wait window (logged) ---
const degradeDir = join(tmp, "degrade-project")
await seedGates(degradeDir, [seedGate({ key: "deadbeefdead", signature: "bash:degrade probe cmd", status: "watching", count: 1, sessions: ["d0"] })])
const hooksDG = await Dejavu({ directory: degradeDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await writeFile(join(degradeDir, ".opencode", "dejavu", "gates.json.lock"), "999999", "utf8")
await failOn(hooksDG)("degrade probe cmd", "dg1", "dg1")
check("lock contention degrades to unlocked after the wait window (logged)", (await readFile(join(degradeDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"type":"degraded"'))
await rm(join(degradeDir, ".opencode", "dejavu", "gates.json.lock"), { force: true })

// --- 72. race-burst reminders do not count toward taught retirement ---
const burstDir = join(tmp, "burst-project")
const BURST_CMD = "burst race cmd"
const burstKey = patternKey(callSignature("bash", { command: BURST_CMD }) ?? "")
await seedGates(burstDir, [seedGate({ key: burstKey, signature: `bash:${BURST_CMD}`, remindedCount: 3 })])
const hooksBU = await Dejavu({ directory: burstDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const burstResults: (Error | null)[] = []
for (let i = 0; i < 5; i++) burstResults.push(await attemptWith(hooksBU)(BURST_CMD, "bu-ses", `bu${i}`))
const burstGate = (await readJson(join(burstDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === burstKey)
check("race-burst calls all get reminded", burstResults.every((r) => r !== null && r.message.includes("REMINDER")))
check("race-burst counts only the true first encounter", burstGate?.remindedCount === 4)
check("race-burst does not retire the gate", burstGate?.status === "blocking")

// --- 73. re-promotion starts a fresh lifecycle (no retire/re-promote oscillation) ---
const cycleDir = join(tmp, "cycle-project")
const CYCLE_CMD = "cycle lifecycle cmd"
const cycleKey = patternKey(callSignature("bash", { command: CYCLE_CMD }) ?? "")
const hooksCY = await Dejavu({ directory: cycleDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksCY)(CYCLE_CMD, "cy1", "cy1")
await failOn(hooksCY)(CYCLE_CMD, "cy1", "cy2")
await failOn(hooksCY)(CYCLE_CMD, "cy2", "cy3")
for (let i = 4; i <= 6; i++) {
  await (hooksCY["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: `cy${i}`, callID: `cy${i}`, args: { command: CYCLE_CMD } } as unknown as AfterInput,
    { title: CYCLE_CMD, output: "ok", metadata: { exit: 0 } } as unknown as AfterOutput,
  )
}
check("lifecycle 1 heals to watching", (await readJson(join(cycleDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === cycleKey)?.status === "watching")
// Oscillation damping: one failure after heal must NOT re-promote (the gate
// keeps its lifetime count, which alone would clear the bar).
await failOn(hooksCY)(CYCLE_CMD, "cy7", "cy7")
check(
  "single failure after heal does NOT re-promote (oscillation damping)",
  (await readJson(join(cycleDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === cycleKey)?.status === "watching",
)
// A full fresh bar (3 failures since retirement) re-promotes and resets lifecycle.
await failOn(hooksCY)(CYCLE_CMD, "cy8", "cy8")
await failOn(hooksCY)(CYCLE_CMD, "cy9", "cy9")
const cycleGate = (await readJson(join(cycleDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === cycleKey)
check(
  "re-promotion resets lifecycle counters (taught check sees the new lifecycle)",
  cycleGate?.status === "blocking" && cycleGate?.remindedCount === 0 && cycleGate?.recurredAfterGate === 0 && cycleGate?.overrideCount === 0,
)

// --- 74. first-encounter failures never saw a reminder and must not demote ---
const firstDir = join(tmp, "first-encounter-project")
const FIRST_CMD = "first encounter cmd"
const firstKey = patternKey(callSignature("bash", { command: FIRST_CMD }) ?? "")
await seedGates(firstDir, [seedGate({ key: firstKey, signature: `bash:${FIRST_CMD}` })])
const hooksFE = await Dejavu({ directory: firstDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksFE)(FIRST_CMD, "fe-a", "fe-a")
await failOn(hooksFE)(FIRST_CMD, "fe-b", "fe-b")
await failOn(hooksFE)(FIRST_CMD, "fe-c", "fe-c")
const firstGate = (await readJson(join(firstDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === firstKey)
check("first-encounter failures count as recurrences", firstGate?.recurredAfterGate === 3)
check("first-encounter failures do not demote (the gate never spoke)", firstGate?.status === "blocking" && firstGate?.feedbackDemoted !== true)

// --- 75. paren-wrapped chains must not blanket-grant exit-1 immunity ---
check("paren-wrapped chain flattens for immunity (non-diagnostic failure not hidden)", !isIntendedNonzero("(deploy --broken && grep done log.txt)", 1))
check("paren-wrapped all-diagnostic chain keeps immunity", isIntendedNonzero("(grep a f && grep b f)", 1))
check("plain all-diagnostic chain keeps immunity", isIntendedNonzero("grep a f && grep b f", 1))

// --- 76. re-promotion clears stale session chains (no skipped reminder) ---
const rePromoDir = join(tmp, "repromo-project")
const RE_PROMO_CMD = "repromo chain cmd"
const rePromoKey = patternKey(callSignature("bash", { command: RE_PROMO_CMD }) ?? "")
await seedGates(rePromoDir, [
  seedGate({ key: rePromoKey, signature: `bash:${RE_PROMO_CMD}`, remindedSessions: { "rp-old": Date.now() }, failedSessions: { "rp-old": Date.now() } }),
])
const hooksRP = await Dejavu({ directory: rePromoDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (let i = 1; i <= 3; i++) {
  await (hooksRP["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: `rp-h${i}`, callID: `rp-h${i}`, args: { command: RE_PROMO_CMD } } as unknown as AfterInput,
    { title: RE_PROMO_CMD, output: "ok", metadata: { exit: 0 } } as unknown as AfterOutput,
  )
}
check("lifecycle heals before re-promotion test", (await readJson(join(rePromoDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === rePromoKey)?.status === "watching")
// Damping: one failure after heal must NOT re-promote.
await failOn(hooksRP)(RE_PROMO_CMD, "rp-new", "rp-new")
check(
  "single failure after heal does NOT re-promote (chains test)",
  (await readJson(join(rePromoDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === rePromoKey)?.status === "watching",
)
// A full fresh bar re-promotes; the lifecycle reset clears the stale chains.
await failOn(hooksRP)(RE_PROMO_CMD, "rp-new", "rp-n2")
await failOn(hooksRP)(RE_PROMO_CMD, "rp-new", "rp-n3")
const rePromoGate = (await readJson(join(rePromoDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === rePromoKey)
check("re-promotion clears stale session chains", rePromoGate?.status === "blocking" && rePromoGate?.remindedSessions === undefined && rePromoGate?.failedSessions === undefined)
check("re-promoted gate reminds the new session (stale chain did not skip it)", (await attemptWith(hooksRP)(RE_PROMO_CMD, "rp-new", "rp-att"))?.message.includes("REMINDER") === true)

// --- 77. suggestCorrection branch selection (the teaching content) ---
check("suggestCorrection: --check artifacts branch", suggestCorrection("bash:dart run tools/gen.dart --check <n>", "stale").startsWith("Generated artifacts"))
check("suggestCorrection: test-runner branch", suggestCorrection("bash:pytest tests/test_x.py", "FAILED").startsWith("A test is failing"))
check("suggestCorrection: type-error branch", suggestCorrection("bash:npx tsc --noemit <n>", "error TS2322").startsWith("Type errors"))
check("suggestCorrection: network branch", suggestCorrection("bash:curl https://api.example.com", "timeout").startsWith("Network/endpoint"))
check("suggestCorrection: install branch", suggestCorrection("bash:npm install --legacy-peer-deps", "ERESOLVE").startsWith("Dependency install"))
check("suggestCorrection: snippet fallback", suggestCorrection("bash:weird custom cmd", "ENOENT: no such file").includes("ENOENT"))
check("suggestCorrection: generic fallback", suggestCorrection("bash:weird custom cmd", "exit code 1").startsWith("This exact call keeps failing"))

// --- 78. migration stamp: second start of the same version skips the scan ---
const stampDir = join(tmp, "stamp-project")
const STAMP_CMD = "stamp probe cmd"
await seedGates(stampDir, [seedGate({ key: patternKey(callSignature("bash", { command: STAMP_CMD }) ?? ""), signature: `bash:${STAMP_CMD}` })])
await Dejavu({ directory: stampDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const stampedFile = JSON.parse(await readFile(join(stampDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { migrated?: string; gates: unknown[] }
check("first init stamps the store with the plugin version", stampedFile.migrated === PLUGIN_VERSION)
// Corrupt a gate in a way migrate would repair (policy violation), but with
// the stamp present the scan is skipped — repairGate on load still heals it,
// proving the stamp skips only the migrate scan, not safety.
await Dejavu({ directory: stampDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const restampedFile = JSON.parse(await readFile(join(stampDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { migrated?: string; gates: unknown[] }
check("second init keeps the stamp and the gates intact", restampedFile.migrated === PLUGIN_VERSION && restampedFile.gates.length === 1)

// --- 79. stale-steal is pid-liveness-gated and reported ---
const stealDir = join(tmp, "steal-project")
await seedGates(stealDir, [seedGate({ key: "abababababab", signature: "bash:steal probe cmd" })])
const stealLockPath = join(stealDir, ".opencode", "dejavu", "gates.json.lock")
// Find a pid that is definitely dead (process.kill(pid, 0) throws ESRCH).
let deadPid = "999999"
for (const candidate of [999999, 999998, 999997, 888888, 777777]) {
  try {
    process.kill(candidate, 0)
  } catch {
    deadPid = String(candidate)
    break
  }
}
await writeFile(stealLockPath, deadPid, "utf8")
const past = new Date(Date.now() - 60_000)
await utimes(stealLockPath, past, past)
const hooksST = await Dejavu({ directory: stealDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksST)("steal probe cmd", "st1", "st1")
check("stale lock of a dead pid is stolen (init+failure proceed)", !existsSync(stealLockPath))
check("stale-steal is logged", (await readFile(join(stealDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes("stale lock stolen"))

// --- 80. paren sub-expressions do NOT blanket-immunize the outer command ---
check("diagnostic nested as sub-expression does not immunize outer verb", !isIntendedNonzero("deploy (grep x)", 1))
check("paren-wrapped single diagnostic keeps immunity", isIntendedNonzero("(grep a f)", 1))
check("nested diagnostic chain keeps immunity", isIntendedNonzero("(grep a f && grep b f)", 1))

// --- 81. migration stamp survives reconcile (init-storm killer stays alive) ---
const stampSurviveDir = join(tmp, "stamp-survive-project")
const STAMP_SURVIVE_CMD = "stamp survive cmd"
await seedGates(stampSurviveDir, [seedGate({ key: patternKey(callSignature("bash", { command: STAMP_SURVIVE_CMD }) ?? ""), signature: `bash:${STAMP_SURVIVE_CMD}` })])
await Dejavu({ directory: stampSurviveDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
// Second init: reconcile runs BEFORE migrate and must preserve the stamp.
await Dejavu({ directory: stampSurviveDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const stampSurviveFile = JSON.parse(await readFile(join(stampSurviveDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { migrated?: string }
check("migration stamp survives reconcile across restarts", stampSurviveFile.migrated === PLUGIN_VERSION)

// --- 82. flushDeferred persists queued repair events (scripts exit cleanly) ---
const flushDir = join(tmp, "flush-project")
const flushStore = new GateStore(flushDir)
flushStore.deferEvent({ type: "repaired", key: "test", snippet: "flush probe" })
await flushStore.flushDeferred()
check("flushDeferred persists queued events", (await readFile(join(flushDir, "log.jsonl"), "utf8")).includes("flush probe"))
// empty queue is a no-op
await flushStore.flushDeferred()
check("flushDeferred is idempotent on empty queue", true)

// --- 83. logAll scoping: high-volume events stay in the project log, salient
// events (promoted/demoted/healed/override/init) also reach the global log ---
const scopeDir = join(tmp, "scoping-project")
const SCOPE_CMD = "scoping probe cmd"
const scopeKey = patternKey(callSignature("bash", { command: SCOPE_CMD }) ?? "")
const hooksSC = await Dejavu({ directory: scopeDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksSC)(SCOPE_CMD, "sc1", "sc1")
await failOn(hooksSC)(SCOPE_CMD, "sc1", "sc2")
await failOn(hooksSC)(SCOPE_CMD, "sc2", "sc3") // promotes (3 failures x 2 sessions)
const scopeProjLog = await readFile(join(scopeDir, ".opencode", "dejavu", "log.jsonl"), "utf8")
const globalLogScoped = await readFile(join(tmp, "global", "log.jsonl"), "utf8")
check("detected event lands in the project log", scopeProjLog.includes(`"type":"detected","key":"${scopeKey}"`))
check("detected event is NOT duplicated to the global log (scoping)", !globalLogScoped.includes(`"type":"detected","key":"${scopeKey}"`))
check("promoted (salient) event reaches the global log", globalLogScoped.includes(`"type":"promoted","key":"${scopeKey}"`))

// --- 84. recordFailure flat lock phases: escalation still works (no deadlock,
// global-first-then-remove-local preserved). The gate promotes in project A,
// then project B's failure escalates it: B's (just-created) copy moves to
// global and is removed from B; project A's copy stays until migrate dedupes. ---
const escDirA = join(tmp, "flat-esc-a")
const escDirB = join(tmp, "flat-esc-b")
const hooksEA = await Dejavu({ directory: escDirA, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const hooksEB = await Dejavu({ directory: escDirB, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const FLAT_CMD = "flat escalation cmd"
const flatSig = callSignature("bash", { command: FLAT_CMD }) ?? ""
await failOn(hooksEA)(FLAT_CMD, "fe1", "fe1")
await failOn(hooksEA)(FLAT_CMD, "fe1", "fe2")
await failOn(hooksEA)(FLAT_CMD, "fe2", "fe3") // promotes in project A
await failOn(hooksEB)(FLAT_CMD, "fe4", "fe4") // second project -> escalates
const flatGlobalGates = await readJson(join(tmp, "global", "gates.json"))
const flatProjBGates = await readJson(join(escDirB, ".opencode", "dejavu", "gates.json"))
check("flat-phase escalation moves the gate to global", flatGlobalGates.some((g) => g.signature === flatSig))
check("flat-phase escalation removes the escalating project's copy", !flatProjBGates.some((g) => g.signature === flatSig))

// --- 85. cross-channel dedup: the same failure recorded by the after-hook
// (exit/text) AND the event channel (error-state part) within the window is ONE
// call double-firing — count it once. The channels are disjoint by construction
// today, so this guard only ever trips if upstream starts emitting both. ---
const dedupeDir = join(tmp, "dedupe-project")
const DEDUPE_CMD = "dedupe cross channel cmd"
const dedupeKey = patternKey(callSignature("bash", { command: DEDUPE_CMD }) ?? "")
const hooksDD = await Dejavu({ directory: dedupeDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
// Channel 1: after-hook bash failure.
await failOn(hooksDD)(DEDUPE_CMD, "dd1", "dd1")
// Channel 2: the SAME call surfacing as an error-state tool part.
await (hooksDD.event as EventHook)(
  {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "dd-part-1",
          type: "tool",
          tool: "bash",
          sessionID: "dd1",
          state: { status: "error", error: "Error: kaboom", input: { command: DEDUPE_CMD } },
        },
      },
    },
  } as unknown as EventInput,
)
const dedupeGate = (await readJson(join(dedupeDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === dedupeKey)
check("cross-channel duplicate is counted once (dedup guard)", dedupeGate?.count === 1)

// --- 85b. chain dedup symmetry: the after-hook attributes a chained failure to
// the known segment gate, but the dedup must key on the WHOLE-CALL signature
// (matching the event channel) or a double-firing chained call slips through. ---
const chainDedupeDir = join(tmp, "chain-dedupe-project")
const CHAIN_SEG_CMD = "gated seg cmd"
const CHAIN_SEG_SIG = callSignature("bash", { command: CHAIN_SEG_CMD }) ?? ""
// single non-transparent producer (cd is navigation) — attribution applies, so
// the after-hook lands on the segment gate while the event channel signs the
// whole call; dedup must key on the whole-call identity.
const CHAIN_FULL_CMD = "cd /x && gated seg cmd"
const CHAIN_FULL_SIG = callSignature("bash", { command: CHAIN_FULL_CMD }) ?? ""
await seedGates(chainDedupeDir, [
  seedGate({
    key: patternKey(CHAIN_SEG_SIG),
    signature: CHAIN_SEG_SIG,
    status: "watching",
    count: 1,
    sessions: ["c0"],
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  }),
])
const hooksCD = await Dejavu({ directory: chainDedupeDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
// Channel 1: after-hook — the chain attributes to the known segment gate.
await failOn(hooksCD)(CHAIN_FULL_CMD, "cd1", "cd1")
// Channel 2: the SAME chained call surfacing as an error-state part (whole-call signature).
await (hooksCD.event as EventHook)(
  {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "cd-part-1",
          type: "tool",
          tool: "bash",
          sessionID: "cd1",
          state: { status: "error", error: "Error: kaboom", input: { command: CHAIN_FULL_CMD } },
        },
      },
    },
  } as unknown as EventInput,
)
const chainDedupeGates = await readJson(join(chainDedupeDir, ".opencode", "dejavu", "gates.json"))
check("chained double-fire is deduped on the whole-call key", !chainDedupeGates.some((g) => g.key === patternKey(CHAIN_FULL_SIG)))
check("chained failure still attributed to the segment gate once", chainDedupeGates.find((g) => g.key === patternKey(CHAIN_SEG_SIG))?.count === 2)

// --- 85c. multi-producer chains are NOT attributed: with several non-transparent
// producers the exit code does not say which one failed, so the failure records
// under the whole call and must NOT inflate a known segment's gate (the
// playwright-count-56 case: a diagnostic segment inflated by another producer). ---
const multiAttrDir = join(tmp, "multi-attr-project")
const MA_SEG_CMD = "gated multi cmd"
const MA_SEG_SIG = callSignature("bash", { command: MA_SEG_CMD }) ?? ""
const MA_FULL_CMD = "some-producer --run && gated multi cmd"
const MA_FULL_SIG = callSignature("bash", { command: MA_FULL_CMD }) ?? ""
await seedGates(multiAttrDir, [
  seedGate({
    key: patternKey(MA_SEG_SIG),
    signature: MA_SEG_SIG,
    status: "watching",
    count: 1,
    sessions: ["m0"],
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  }),
])
const hooksMA = await Dejavu({ directory: multiAttrDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksMA)(MA_FULL_CMD, "ma1", "ma1")
const multiAttrGates = await readJson(join(multiAttrDir, ".opencode", "dejavu", "gates.json"))
check("multi-producer chain is NOT attributed to the known segment", multiAttrGates.find((g) => g.key === patternKey(MA_SEG_SIG))?.count === 1)
check("multi-producer chain records under the whole-call signature", multiAttrGates.some((g) => g.signature === MA_FULL_SIG))

// --- 87. evidence quality: failureSnippet must never surface a success-shaped
// tail as the failure evidence (the "17 passed" gate). ---
check(
  "failureSnippet picks the error line over a success-shaped tail",
  failureSnippet("Error: No tests found.\n17 passed (3.1m)", 1) === "Error: No tests found.",
)
check("failureSnippet success-only output falls back to the exit code", failureSnippet("17 passed (3.1m)", 1) === "exit code 1")
check("failureSnippet pwsh not-recognized picks the cause line", failureSnippet("head : The term 'head' is not recognized as the name of a cmdlet.\nCheck the spelling of the name.", 1).includes("is not recognized"))
check("looksLikeSuccess detects pass summaries", looksLikeSuccess("17 passed (3.1m)") && looksLikeSuccess("1 passed (50.1s)"))
check("looksLikeSuccess rejects a failure tally", !looksLikeSuccess("1 failed, 1780 passed"))
check("looksLikeFailure detects errors, rejects pass summaries", looksLikeFailure("ENOENT: no such file") && !looksLikeFailure("17 passed (3.1m)"))

// --- 87b. detection coverage: pwsh not-recognized wording, bare "N failed",
// "No tests found", generic "Error:" prefix. ---
check("detectFailure matches pwsh not-recognized wording", detectFailure("head : The term 'head' is not recognized as the name of a cmdlet").matched)
check("detectFailure matches bare runner summary '1 failed'", detectFailure("1 failed, 1780 passed in 136s").matched)
check("detectFailure matches 'No tests found'", detectFailure("Error: No tests found.").matched)
check("detectFailure does not match '0 failed'", !detectFailure("0 failed, 12 passed").matched)

// --- 87c. correction integrity: never quote a success-shaped snippet as
// "Last error"; new families teach platform-correct fixes. ---
check("suggestCorrection does not quote a success-shaped snippet", !suggestCorrection("bash:deploy-tool --flag <str>", "17 passed (3.1m)").includes('Last error: "17 passed'))
check("suggestCorrection quotes a real error line", suggestCorrection("bash:deploy-tool --flag <str>", "ENOENT: no such file or directory").includes("ENOENT"))
check("suggestCorrection unix-in-powershell family", suggestCorrection("bash:git show --stat <hash> | head - <n>", "The term 'head' is not recognized as the name of a cmdlet").includes("Select-Object"))
check("suggestCorrection file-not-found family", suggestCorrection("read:entitlements.py", "File not found: D:\\x\\entitlements.py").includes("glob"))
check("suggestCorrection missing-command family", suggestCorrection("bash:foo-tool --run", "foo-tool: command not found").includes("not installed"))

// --- 87d. repairGate heals legacy success-shaped evidence at the persistence
// boundary and re-derives the machine template correction (human edits kept). ---
const rgGate = {
  key: "000000000001",
  signature: "bash:deploy-tool --flag <str>",
  tool: "bash",
  status: "watching",
  count: 3,
  sessions: ["s1", "s2"],
  projects: [],
  firstSeen: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-02T00:00:00.000Z",
  snippet: "17 passed (3.1m)",
  correction: 'Last error: "17 passed (3.1m)" — address that specific error before retrying this exact call.',
  remindedCount: 0,
  blockedCount: 0,
  recurredAfterReminder: 0,
  recurredAfterGate: 0,
  overrideCount: 0,
} as Gate
repairGate(rgGate)
check("repairGate clears a success-shaped snippet", rgGate.snippet === "")
check("repairGate re-derives the template correction quoting a success line", rgGate.correction !== undefined && !rgGate.correction.includes('Last error: "17 passed'))
const rgHuman = { ...rgGate, snippet: "ENOENT: no such file", correction: "Custom human-written advice" } as Gate
repairGate(rgHuman)
check("repairGate never touches a human-edited correction", rgHuman.correction === "Custom human-written advice")

// --- 87e. evidence monotonicity: a success-shaped snippet never overwrites a
// failure-shaped one already on the gate. ---
const monoDir = join(tmp, "monotonic-project")
const monoStores = new Stores(new GateStore(join(tmp, "monotonic-global")), new GateStore(monoDir))
const monoSig = "bash:monotonic evidence cmd"
const monoKey = patternKey(monoSig)
await monoStores.recordFailure({ key: monoKey, signature: monoSig, tool: "bash", sessionID: "ms1", projectDir: monoDir, snippet: "Error: real failure line", globalProjects: 99 })
await monoStores.recordFailure({ key: monoKey, signature: monoSig, tool: "bash", sessionID: "ms1", projectDir: monoDir, snippet: "17 passed (3.1m)", globalProjects: 99 })
const monoGate = (await new GateStore(monoDir).loadForMutation()).find((g) => g.key === monoKey)
check("success-shaped snippet does not overwrite a failure-shaped one", monoGate?.snippet === "Error: real failure line")

// --- 87f. infrastructure noise is classified (server-side unavailability),
// client-side mistakes stay teachable. ---
check("isNoiseError classifies lsp daemon unreachable", isNoiseError("LSP daemon did not become reachable at \\\\.\\pipe\\omo-lsp-0.1.0-abc"))
check("isNoiseError classifies webfetch non-2xx", isNoiseError("StatusCodeError: non 2xx status code (503 get https://example.com)"))
check("isNoiseError classifies MCP streamable-http transport errors", isNoiseError("StreamableHTTPError: Error posting to endpoint"))
check("isNoiseError classifies webfetch transport error (connection never completed)", isNoiseError("transport error (get https://example.com)"))
check("isNoiseError classifies closed-browser automation error (transient state)", isNoiseError("browserbackend.calltool: target page, context or browser has been closed"))
check("isNoiseError classifies LSP diagnostics timeout (latency hiccup)", isNoiseError("timed out waiting for fresh diagnostics for src/foo.ts within 3000ms."))
check("isNoiseError does not classify a client-side ENOENT", !isNoiseError("ENOENT: no such file or directory"))

// --- 87g. immunity holes closed: env assignments and start-sleep are
// transparent, npm run check:* is diagnostic. ---
check("env-assignment prefix does not break diagnostic immunity", isIntendedNonzero('$env:CI="true"; npx vitest run 2>&1', 1))
check("start-sleep prefix does not break diagnostic immunity", isIntendedNonzero("start-sleep -seconds 5; npx playwright test 2>&1", 1))
check("npm run check:* is a diagnostic", isIntendedNonzero("npm run check:bdd-parity 2>&1", 1))
check("env-assignment + non-diagnostic still counts", !isIntendedNonzero('$env:CI="true"; deploy-tool --broken', 1))

// --- 87h. flag-only wrapper shapes lose residual identity (over-generic). ---
check("flag-only wrapper loses residual identity and cannot block", !hasResidualIdentity("bash:cmd <path> <str> -f") && !canBlock("bash", "bash:cmd <path> <str> -f"))
check("wrapper with a real argument keeps identity", hasResidualIdentity("bash:node scripts/foo.js"))
check("python -m pytest keeps identity", hasResidualIdentity("bash:python -m pytest"))
check("nonTransparentProducers counts cd/env as transparent", nonTransparentProducers("cd /x && npm test") === 1 && nonTransparentProducers('$env:CI="true"; npx vitest run') === 1)
check("nonTransparentProducers counts two real producers", nonTransparentProducers("build-tool --run && npm test") === 2)

// --- 87i. promotionCount: lifetime counter, incremented on promotion. ---
const pcDir = join(tmp, "promo-count-project")
const PC_CMD = "promo count deploy cmd"
const pcKey = patternKey(callSignature("bash", { command: PC_CMD }) ?? "")
const hooksPC = await Dejavu({ directory: pcDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksPC)(PC_CMD, "pc1", "pc-f1")
await failOn(hooksPC)(PC_CMD, "pc1", "pc-f2")
await failOn(hooksPC)(PC_CMD, "pc2", "pc-f3")
const pcGate = (await readJson(join(pcDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === pcKey)
check("promotionCount is 1 after the first promotion", pcGate?.status === "blocking" && pcGate?.promotionCount === 1)

// --- 87j. reminding taught retirement: clean reminders retire a diagnostic
// gate softly (no feedbackDemoted), re-promotion stays possible. ---
const rtDir = join(tmp, "remind-taught-project")
const RT_CMD = "npm test"
const rtKey = patternKey(callSignature("bash", { command: RT_CMD }) ?? "")
await seedGates(rtDir, [seedGate({ key: rtKey, signature: `bash:${RT_CMD}`, status: "reminding", remindedCount: 5 })])
const hooksRT = await Dejavu({ directory: rtDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksRT)(RT_CMD, "rt1", "rt-f1")
const rtGate = (await readJson(join(rtDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === rtKey)
check("reminding gate retires to watching after clean reminders (taught)", rtGate?.status === "watching" && rtGate?.feedbackDemoted !== true)
check("reminding taught retirement is logged", (await readFile(join(rtDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"type":"retired-taught"'))

// --- 87k. save() stamps lastInitVersion with the writer's plugin version. ---
const livDir = join(tmp, "liv-project")
const livStore = new GateStore(livDir)
await livStore.runLocked(async () => {
  const gates = await livStore.loadForMutation()
  gates.push({
    key: "000000000099",
    signature: "bash:liv test",
    tool: "bash",
    status: "watching",
    count: 1,
    sessions: ["l1"],
    projects: [],
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    snippet: "exit code 1",
    remindedCount: 0,
    blockedCount: 0,
    recurredAfterReminder: 0,
    recurredAfterGate: 0,
    overrideCount: 0,
  })
  await livStore.save()
})
check("save stamps lastInitVersion with the plugin version", (JSON.parse(await readFile(join(livDir, "gates.json"), "utf8")) as { lastInitVersion?: string }).lastInitVersion === PLUGIN_VERSION)

// --- 88. cross-language generalization battery. The evidence engine must not be
// biased to the JS/Python/PowerShell formats it was tuned on: every ecosystem's
// failing output must be DETECTED with a real evidence line (not "exit code 1"),
// and every ecosystem's passing summary must be rejected as evidence. Guard
// against the "0 failed" pass tally reading as a failure. ---
const xlFail = (name: string, output: string): void => {
  const detection = detectFailure(output)
  check(`xlang ${name}: failure detected`, detection.matched)
  const snippet = failureSnippet(output, 1)
  check(`xlang ${name}: evidence is a real line, not "exit code 1"`, snippet !== "exit code 1" && snippet !== "")
}
xlFail("go test", "--- FAIL: TestFoo (0.00s)\n    main_test.go:10: expected 5, got 3\nFAIL\nexit status 1")
xlFail("cargo build", "error[E0308]: mismatched types\n --> src/main.rs:2:18\nerror: could not compile `crate` due to 1 previous error")
xlFail("cargo test", "test result: FAILED. 1 passed; 1 failed; 0 ignored")
xlFail("maven", "[ERROR] Tests run: 11, Failures: 1, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE")
xlFail("gradle", "> Task :test FAILED\n3 tests completed, 1 failed\nFAILURE: Build failed with an exception.\nBUILD FAILED in 3s")
xlFail("rspec", "Failures:\n\n  1) Foo fails\n     Failure/Error: expect(5).to eq(3)\n\nFinished in 0.02 seconds\n1 example, 1 failure")
xlFail("dotnet test", "  Failed TestFoo [1 ms]\n  Error Message:\n    Assert.Equal() Failure\n\nFailed!  - Failed: 1, Passed: 10, Skipped: 0, Total: 11")
xlFail("dotnet build", "Program.cs(10,5): error CS1002: ; expected\nBuild FAILED.")
xlFail("phpunit", "1) FooTest::testBar\nFailed asserting that 3 matches expected 5.\n\nFAILURES!\nTests: 2, Assertions: 3, Failures: 1.")
xlFail("elixir mix test", "  1) test foo (MyModuleTest)\n     Assertion with == failed\n\n1 test, 1 failure, 0 excluded")
xlFail("sbt test", "[info] *** 1 TEST FAILED ***\n[error] Failed: Total 19, Failed 1, Errors 0, Passed 18")
xlFail("python unittest", "FAIL: test_something (__main__.TestExample)\nAssertionError: 1 != 2\nFAILED (failures=1)")
xlFail("node --test TAP", "not ok 1 - fails\n# tests 1\n# pass 0\n# fail 1")
xlFail("pytest", "FAILED tests/test_foo.py::test_foo - assert 5 == 3\n========================= 1 failed, 9 passed in 0.05s =========================")
xlFail("jest", "Test Suites: 1 failed, 1 total\nTests:       14 passed, 1 failed, 15 total")

// Passing summaries are never failure evidence — substring match, any decoration.
check("xlang rust pass summary rejected", looksLikeSuccess("test result: ok. 10 passed; 0 failed; 0 ignored"))
check("xlang pytest decorated pass summary rejected", looksLikeSuccess("========================= 10 passed in 0.16s ========================="))
check("xlang gradle pass summary rejected", looksLikeSuccess("BUILD SUCCESSFUL in 3s"))
check("xlang phpunit pass summary rejected", looksLikeSuccess("OK (2 tests, 3 assertions)"))
check("xlang go pass summary rejected", looksLikeSuccess("ok  \texample.com/pkg\t0.001s"))
check("xlang dotnet pass summary rejected", looksLikeSuccess("Passed!  - Failed: 0, Passed: 11, Skipped: 0, Total: 11"))

// A "0 failed" pass tally must never read as a failure, and must be rejected as
// evidence even when it is the tail of a failing run's output.
check("xlang '0 failed' pass tally is not a failure", !looksLikeFailure("test result: ok. 10 passed; 0 failed; 0 ignored"))
check("xlang 'Failed: 0' pass tally is not a failure", !looksLikeFailure("Passed!  - Failed: 0, Passed: 11, Skipped: 0"))
check(
  "xlang pass-summary tail of a failing run is skipped for the real error",
  failureSnippet("error: real cause\n17 passed (3.1m)", 1) === "error: real cause",
)

// --- 89. long-running command guard. Foreground dev-server starts must warn;
// detached / one-shot / build commands must NOT. ---
check("longrun: npm run dev warns", shouldWarnLongRunning("npm run dev"))
check("longrun: next dev warns", shouldWarnLongRunning("next dev"))
check("longrun: python -m http.server warns", shouldWarnLongRunning("python -m http.server"))
check("longrun: vite (no build) warns", shouldWarnLongRunning("vite"))
check("longrun: vite build does NOT warn", !shouldWarnLongRunning("vite build"))
check("longrun: npm run build does NOT warn", !shouldWarnLongRunning("npm run build"))
check("longrun: trailing & does NOT warn", !shouldWarnLongRunning("npm run dev &"))
check("longrun: nohup does NOT warn", !shouldWarnLongRunning("nohup npm run dev &"))
check(
  "longrun: python server.py cli one-shot does NOT warn",
  !shouldWarnLongRunning("python tools/muffin-supervisor/server.py cli start parity-board"),
)
check(
  "longrun: bare python server.py still warns",
  shouldWarnLongRunning("python tools/muffin-supervisor/server.py"),
)
check("longrun: tmux does NOT warn", !shouldWarnLongRunning("tmux new-session -d -s app 'npm run dev'"))
check("longrun: node one-shot does NOT warn", !shouldWarnLongRunning("node scripts/build.js"))
// Canonical starters across ecosystems (hardening pass).
check("longrun: npm start warns", shouldWarnLongRunning("npm start"))
check("longrun: ng serve warns", shouldWarnLongRunning("ng serve"))
check("longrun: django runserver warns", shouldWarnLongRunning("python manage.py runserver"))
check("longrun: php artisan serve warns", shouldWarnLongRunning("php artisan serve"))
check("longrun: jupyter lab warns", shouldWarnLongRunning("jupyter lab"))
check("longrun: webpack serve warns", shouldWarnLongRunning("webpack serve"))
check("longrun: dotnet watch warns", shouldWarnLongRunning("dotnet watch"))
check("longrun: hugo server warns", shouldWarnLongRunning("hugo server"))
check("longrun: mix phx.server warns", shouldWarnLongRunning("mix phx.server"))
check("longrun: nodemon warns", shouldWarnLongRunning("nodemon server.js"))
// False-positive hardening: installs/mentions/filenames must NOT warn.
check("longrun: pip install uvicorn does NOT warn", !shouldWarnLongRunning("pip install uvicorn gunicorn fastapi"))
check("longrun: cat vite.config.ts does NOT warn", !shouldWarnLongRunning("cat vite.config.ts"))
check("longrun: npm run build:vite does NOT warn", !shouldWarnLongRunning("npm run build:vite"))
check("longrun: vite build --watch warns", shouldWarnLongRunning("vite build --watch"))
check("longrun: screen -dm detached does NOT warn", !shouldWarnLongRunning("screen -dmS app npm run dev"))
check("longrun: Start-Job detached does NOT warn", !shouldWarnLongRunning("Start-Job { npm run dev }"))
check("longrun: subshell & detached does NOT warn", !shouldWarnLongRunning("(npm run dev &) && echo bg-started"))
check("longrun: && chain still warns", shouldWarnLongRunning("cd repo && npm run dev"))
// v2.24 hardening: more starters, detached-misfires, wait-loops.
check("longrun: docker compose up warns", shouldWarnLongRunning("docker compose up"))
check("longrun: docker compose up -d does NOT warn", !shouldWarnLongRunning("docker compose up -d"))
check("longrun: node --watch warns", shouldWarnLongRunning("node --watch server.js"))
check("longrun: yarn workspace dev warns", shouldWarnLongRunning("yarn workspace app dev"))
check("longrun: python app.py warns", shouldWarnLongRunning("python app.py"))
// server.py with `cli` subcommand is a one-shot CLI invocation, not a foreground server.
check("longrun: python server.py (bare) warns", shouldWarnLongRunning("python tools/muffin-supervisor/server.py"))
check("longrun: python server.py cli does NOT warn", !shouldWarnLongRunning("python tools/muffin-supervisor/server.py cli overview"))
check("longrun: python server.py cli (bare) does NOT warn", !shouldWarnLongRunning("python server.py cli"))
check("longrun: python server.py with non-cli args still warns", shouldWarnLongRunning("python server.py --port 8099"))
check("longrun: & wait is NOT detached (blocks) so warns", shouldWarnLongRunning("npm run dev & wait"))
check("longrun: nohup without & is NOT detached so warns", shouldWarnLongRunning("nohup npm run dev"))
check("longrun: Start-Process -Wait is NOT detached so warns", shouldWarnLongRunning("Start-Process 'npm run dev' -Wait"))
check("longrun: Start-Process detached does NOT warn", !shouldWarnLongRunning("Start-Process 'npm run dev'"))
check("waitloop: while+sleep warns", shouldWarnWaitLoop("while ($true) { Start-Sleep 1 }"))
check("waitloop: until+curl+sleep warns", shouldWarnWaitLoop("until curl -s http://localhost:3000/health; do sleep 1; done"))
check("waitloop: plain command does NOT warn", !shouldWarnWaitLoop("curl -s --max-time 5 http://localhost:3000/health"))
check("waitloop: multi-line PowerShell while+sleep warns", shouldWarnWaitLoop("while ($true) {\n  try { Invoke-WebRequest http://x } catch { Start-Sleep 1 }\n}"))

// before-hook interrupts a foreground server start, honors the escape hatch.
const lrDir = join(tmp, "longrun-project")
const hooksLR = await Dejavu({ directory: lrDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const lrAttempt = async (command: string): Promise<Error | null> => {
  try {
    await (hooksLR["tool.execute.before"] as BeforeHook)(
      { tool: "bash", sessionID: "lr1", callID: "lr-c1" } as unknown as BeforeInput,
      { args: { command } } as unknown as BeforeOutput,
    )
    return null
  } catch (error) {
    return error as Error
  }
}
const lrBlocked = await lrAttempt("npm run dev")
check("longrun: before-hook interrupts foreground server with LONG-RUNNING note", lrBlocked !== null && lrBlocked.message.includes("LONG-RUNNING"))
check("longrun: dejavu:proceed bypasses the guard", (await lrAttempt("npm run dev # dejavu:proceed")) === null)
check("longrun: detached server is not interrupted", (await lrAttempt("npm run dev &")) === null)
check("longrun: one-shot command is not interrupted", (await lrAttempt("npm run build")) === null)

// --- 97. suppressed-spawn guard (compensating measure for anomalyco/opencode#29831):
// detached daemon + piped/redirected stdout hangs the call forever (stdio EOF
// never comes from the living daemon). Predicate level first. ---
const SPAWN = "node scripts/siphon-supervisor.mjs"
check("spawnwarn: spawn + pipe warns", shouldWarnSuppressedSpawn(`${SPAWN} start | Out-Null`))
check("spawnwarn: spawn + stdout redirect warns", shouldWarnSuppressedSpawn(`${SPAWN} start > $null`))
check("spawnwarn: spawn + attached redirect warns", shouldWarnSuppressedSpawn(`${SPAWN} start>$null`))
check("spawnwarn: spawn + 1> redirect warns", shouldWarnSuppressedSpawn(`${SPAWN} start 1> log.txt`))
check("spawnwarn: spawn + append redirect warns", shouldWarnSuppressedSpawn(`${SPAWN} start >> log.txt`))
check("spawnwarn: restart verb warns", shouldWarnSuppressedSpawn(`${SPAWN} restart | Out-Null`))
check("spawnwarn: double-quoted spawner path warns", shouldWarnSuppressedSpawn(`node "D:/x/siphon-supervisor.mjs" restart | Out-Null`))
check("spawnwarn: single-quoted spawner path warns", shouldWarnSuppressedSpawn("node 'scripts/siphon-supervisor.mjs' start > $null"))
check("spawnwarn: bare spawn does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} start`))
check("spawnwarn: stop + pipe does NOT warn (not a spawn verb)", !shouldWarnSuppressedSpawn(`${SPAWN} stop | Out-Null`))
check("spawnwarn: status + pipe does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} status | ConvertFrom-Json`))
check("spawnwarn: stderr-only redirect does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} start 2> $null`))
check("spawnwarn: stderr merge does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} start 2>&1`))
check("spawnwarn: suppression in ANOTHER segment does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} start; echo done > $null`))
check("spawnwarn: quoted redirect text does NOT warn", !shouldWarnSuppressedSpawn(`${SPAWN} start "log > file"`))
check("spawnwarn: unrelated command with redirect does NOT warn", !shouldWarnSuppressedSpawn("npm run build > build.log"))
check("spawnwarn: chained spawn + pipe warns (segment-scoped)", shouldWarnSuppressedSpawn(`echo a; ${SPAWN} start | Out-Null; echo b`))
check("spawnwarn: spawn piped mid-chain warns", shouldWarnSuppressedSpawn(`${SPAWN} start | Out-Null && echo done`))

// Hook level: the guard interrupts, and the escape hatch bypasses with a warn log.
const ssDir = join(tmp, "spawnwarn-project")
const ssLogs: string[] = []
const hooksSS = await Dejavu({
  directory: ssDir,
  client: {
    app: {
      log: async (opts: { body?: { message?: unknown } }) => {
        ssLogs.push(String(opts?.body?.message ?? ""))
        return {}
      },
    },
  },
} as unknown as Ctx)
const ssAttempt = async (command: string): Promise<Error | null> => {
  try {
    await (hooksSS["tool.execute.before"] as BeforeHook)(
      { tool: "bash", sessionID: "ss1", callID: `ss-${ssLogs.length}-${command.length}` } as unknown as BeforeInput,
      { args: { command } } as unknown as BeforeOutput,
    )
    return null
  } catch (error) {
    return error as Error
  }
}
const ssBlocked = await ssAttempt(`${SPAWN} start | Out-Null`)
check("spawnwarn: before-hook interrupts spawn+pipe with SUPPRESSED-SPAWN", ssBlocked !== null && ssBlocked.message.includes("SUPPRESSED-SPAWN"))
check("spawnwarn: bare spawn is not interrupted", (await ssAttempt(`${SPAWN} start`)) === null)
check("spawnwarn: stderr-only redirect is not interrupted", (await ssAttempt(`${SPAWN} start 2> $null`)) === null)
check("spawnwarn: dejavu:proceed bypasses the guard", (await ssAttempt(`${SPAWN} start | Out-Null # dejavu:proceed`)) === null)
check("spawnwarn: bypass logs a warning", ssLogs.some((m) => m.includes("suppressed-spawn guard bypassed")))

// --- 98. timeout-kill correction: a bash call killed at its timeout must teach
// the call SHAPE (orphaned stdio holder / long run), not a family guess like
// "a test is failing" — the timeout evidence outranks the command family. ---
check(
  "timeoutkill: suggestCorrection outranks the test-family guess",
  suggestCorrection("bash:npx vitest run", "shell tool terminated command after exceeding timeout 120000 ms").includes("stdio"),
)
const tkDir = join(tmp, "timeoutkill-project")
const TK_CMD = "npx vitest run --reporter=verbose"
const tkKey = patternKey(callSignature("bash", { command: TK_CMD }) ?? "")
const hooksTK = await Dejavu({ directory: tkDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const tkError = "shell tool terminated command after exceeding timeout 600000 ms"
const emitTK = async (partId: string, session: string): Promise<void> => {
  await (hooksTK.event as EventHook)({
    event: {
      type: "message.part.updated",
      properties: { part: { id: partId, type: "tool", tool: "bash", sessionID: session, state: { status: "error", error: tkError, input: { command: TK_CMD } } } },
    },
  } as unknown as EventInput)
}
await emitTK("tk-e1", "tk1")
await emitTK("tk-e2", "tk1")
await emitTK("tk-e3", "tk2")
const tkGate = (await readJson(join(tkDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === tkKey)
check("timeoutkill: 3 timeout kills in 2 sessions promote a (reminding) gate", tkGate !== undefined && tkGate.status === "reminding")
check("timeoutkill: the gate teaches the spawn/redirect + timeout correction", (tkGate?.correction ?? "").includes("stdio") && (tkGate?.correction ?? "").includes("timeout"))

// --- 87. self-maintenance additions (2.25.0). Run before 86: 87b uses its own
// DEJAVU_HOME, but the rest touch the shared global store that 86 corrupts. ---

// 87a. git status is a read-only diagnostic: exit 1 is intended, never blocking
check("git status is a diagnostic (exit 1 intended)", isIntendedNonzero("git status --short", 1))
check("git status gate cannot block", !canBlock("bash", "bash:git status --short"))

// 87b. index orphan candidacy: invisible keys get a candidacy timestamp, live
// keys clear it, keys absent past the window are pruned.
const orphGlobal = join(tmp, "orphan-global")
const orphProj = join(tmp, "orphan-project")
await mkdir(orphGlobal, { recursive: true })
const orphNow = new Date().toISOString()
const orphOldCandidacy = Date.now() - 8 * 24 * 60 * 60 * 1000
const hasgateKey = patternKey("bash:some-existing-cmd")
await writeFile(
  join(orphGlobal, "index.json"),
  JSON.stringify({
    version: 1,
    keys: {
      orphanfresh: { projects: ["ghost"], lastSeen: orphNow },
      orphanold: { projects: ["ghost"], lastSeen: orphNow, orphanCandidateSince: orphOldCandidacy },
      [hasgateKey]: { projects: ["ghost"], lastSeen: orphNow, orphanCandidateSince: orphOldCandidacy },
    },
  }),
  "utf8",
)
await writeFile(
  join(orphGlobal, "gates.json"),
  JSON.stringify({ version: 1, gates: [seedGate({ key: hasgateKey, signature: "bash:some-existing-cmd", status: "watching", count: 1, sessions: ["s"], lastSeen: orphNow })] }),
  "utf8",
)
const prevHome = process.env.DEJAVU_HOME
process.env.DEJAVU_HOME = orphGlobal
await Dejavu({ directory: orphProj, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
process.env.DEJAVU_HOME = prevHome
const orphIndex = JSON.parse(await readFile(join(orphGlobal, "index.json"), "utf8")) as { keys: Record<string, { orphanCandidateSince?: number }> }
check("orphan candidacy set for a fresh invisible key", orphIndex.keys["orphanfresh"]?.orphanCandidateSince !== undefined)
check("orphan candidacy prunes a key absent past the window", orphIndex.keys["orphanold"] === undefined)
check("orphan candidacy cleared when a visible gate holds the key", orphIndex.keys[hasgateKey] !== undefined && orphIndex.keys[hasgateKey]?.orphanCandidateSince === undefined)

// 87c. override demotion bar is 3 across 2+ sessions: a blocking gate with
// 3 overrides from distinct sessions demotes on repair
const ov3Dir = join(tmp, "ov3-project")
const OV3_CMD = "deploy --prod --force"
const ov3Key = patternKey(callSignature("bash", { command: OV3_CMD }) ?? "")
await seedGates(ov3Dir, [seedGate({ key: ov3Key, signature: `bash:${OV3_CMD}`, status: "blocking", overrideCount: 3, overrideSessions: ["o1", "o2"] })])
await Dejavu({ directory: ov3Dir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const ov3Gate = (await readJson(join(ov3Dir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === ov3Key)
check("3 overrides from 2 sessions demote a blocking gate on repair", ov3Gate?.status === "watching" && ov3Gate?.feedbackDemoted === true)

// 87d. startup logs a health event for NOT TEACHING gates
const healthDir = join(tmp, "health-project")
const HEALTH_CMD = "deploy --health-check"
const healthKey = patternKey(callSignature("bash", { command: HEALTH_CMD }) ?? "")
await seedGates(healthDir, [seedGate({ key: healthKey, signature: `bash:${HEALTH_CMD}`, status: "blocking", recurredAfterGate: 3 })])
await Dejavu({ directory: healthDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
check("startup logs a health event for NOT TEACHING gates", (await readFile(join(healthDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"health"'))

// --- 88. correction quality: Unix-tool advice, success-shaped noise, AUTO_TEMPLATE re-derive ---
check("suggestCorrection teaches PowerShell-native for legacy 'Check the spelling' head gates", suggestCorrection("bash:git log --oneline | head - <n>", "Check the spelling of the name, or if a path was included").includes("Unix tool"))
check("suggestCorrection teaches PowerShell-native for pwsh 'not recognized' tail gates", suggestCorrection("bash:wc -l <str>", "wc : The term 'wc' is not recognized as the name of a cmdlet").includes("Unix tool"))
check("detectFailure catches PowerShell not-recognized (cmdlet wording)", detectFailure("head : The term 'head' is not recognized as the name of a cmdlet, function, script file, or operable program.").matched)
check("looksLikeSuccess rejects gradle task-summary noise", looksLikeSuccess("47 actionable tasks: 3 executed, 44 up-to-date"))
check("looksLikeSuccess rejects the node version banner", looksLikeSuccess("Node.js v24.12.0"))
const corrGate = seedGate({ key: patternKey("bash:git show --stat <hash> | head - <n>"), signature: "bash:git show --stat <hash> | head - <n>", status: "reminding", snippet: "Check the spelling of the name, or if a path was included", correction: `Last error: "Check the spelling of the name, or if a path was included" — address that specific error before retrying this exact call.` }) as unknown as Gate
const corrChanged = repairGate(corrGate)
check("repairGate upgrades a stale 'Check the spelling' AUTO_TEMPLATE to Unix advice", corrChanged === true && corrGate.correction?.includes("Unix tool") === true)
check("failureSnippet falls back to the last non-success line, not a bare exit code", failureSnippet("Loading project\nConfiguration cache entry stored.", 1) === "Loading project")
check("failureSnippet still never surfaces a success-only tail", failureSnippet("17 passed\nall tests passed", 1) === "exit code 1")

// --- 89. heal-aware blocking first encounter (2.27.0): a gate with recent
// successes does not abort the first run, but the chain stays armed. ---
const healAwareDir = join(tmp, "heal-aware-project")
const HA_CMD = "deploy --prod --force"
const haKey = patternKey(callSignature("bash", { command: HA_CMD }) ?? "")
await seedGates(healAwareDir, [seedGate({ key: haKey, signature: `bash:${HA_CMD}`, status: "blocking", succeededAfterGate: 2 })])
const hooksHA = await Dejavu({ directory: healAwareDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
check("heal-aware: healing blocking gate does not abort the first encounter", (await attemptWith(hooksHA)(HA_CMD, "ha1", "ha1")) === null)
const haGate = (await readJson(join(healAwareDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === haKey)
check("heal-aware: the chain stays armed (remindedSessions set)", haGate?.remindedSessions?.["ha1"] !== undefined)
check("heal-aware: no reminder counted (nothing was shown)", (haGate?.remindedCount ?? 0) === 0)
await failOn(hooksHA)(HA_CMD, "ha1", "ha2")
check("heal-aware: a repeat failure after the armed run still blocks", (await attemptWith(hooksHA)(HA_CMD, "ha1", "ha3"))?.message.includes("[dejavu] BLOCKED") === true)

// --- 90. in-process concurrency: a critical section outliving LOCK_WAIT_MS must not
// let a same-process waiter degrade to unlocked and lose updates (parallel tool calls) ---
const concDir = join(tmp, "concurrency-project")
const concStore = new GateStore(join(concDir, ".opencode", "dejavu"))
await concStore.runLocked(async () => {
  const gates = await concStore.loadForMutation()
  gates.push(seedGate({ key: "cccc00000001", signature: "bash:concurrency probe cmd", status: "watching", count: 0 }) as unknown as Gate)
  await concStore.save()
})
await Promise.all(
  [0, 1].map(() =>
    concStore.runLocked(async () => {
      const gates = await concStore.loadForMutation()
      const gate = gates.find((g) => g.key === "cccc00000001")
      if (gate !== undefined) {
        gate.count += 1
        await new Promise((resolve) => setTimeout(resolve, 3200)) // holder outlives LOCK_WAIT_MS
        await concStore.save()
      }
    }),
  ),
)
await concStore.flushDeferred()
const concCount = (await readJson(join(concDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === "cccc00000001")?.count
check("same-process locked sections serialize (no lost update past LOCK_WAIT_MS)", concCount === 2)
const concLog = await readFile(join(concDir, ".opencode", "dejavu", "log.jsonl"), "utf8").catch(() => "")
check("same-process contention never degrades to unlocked", !concLog.includes('"type":"degraded"'))

// --- 91. a transiently-unreadable gates.json (here: a directory at the file path)
// is NOT an empty store: load must throw and save must stay a no-op, never wipe ---
const unreadDir = join(tmp, "unreadable-project", ".opencode", "dejavu")
await mkdir(join(unreadDir, "gates.json"), { recursive: true })
const unreadStore = new GateStore(unreadDir)
let unreadThrew = false
try {
  await unreadStore.loadForMutation()
} catch {
  unreadThrew = true
}
check("unreadable gates.json throws instead of parsing as an empty store", unreadThrew)
let saveThrew = false
try {
  await unreadStore.save()
} catch {
  saveThrew = true
}
check("save after an unreadable load is a no-op (never clobbers)", !saveThrew && existsSync(join(unreadDir, "gates.json")))

// --- 92. override demotion needs 2+ DISTINCT sessions: one stubborn or
// prompt-injected session must not disarm a gate for everyone ---
const ov1Dir = join(tmp, "override-single-session")
const OVS_CMD = "deploy --to single-session"
const ovsKey = patternKey(callSignature("bash", { command: OVS_CMD }) ?? "")
await seedGates(ov1Dir, [seedGate({ key: ovsKey, signature: `bash:${OVS_CMD}` })])
const hooksOVS = await Dejavu({ directory: ov1Dir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
for (let i = 0; i < DEMOTE_OVERRIDES + 2; i++) {
  await attemptWith(hooksOVS)(`${OVS_CMD} # dejavu:proceed`, "ovs-same", `ovs${i}`)
}
const ovsGate = (await readJson(join(ov1Dir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === ovsKey)
check(
  "overrides from ONE session count but do not demote",
  ovsGate?.overrideCount === DEMOTE_OVERRIDES + 2 && ovsGate?.status === "blocking" && (ovsGate?.overrideSessions?.length ?? 0) === 1,
)
await attemptWith(hooksOVS)(`${OVS_CMD} # dejavu:proceed`, "ovs-other", "ovsX")
const ovsGate2 = (await readJson(join(ov1Dir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === ovsKey)
check("overrides across 2 distinct sessions demote the gate", ovsGate2?.status === "watching" && ovsGate2?.feedbackDemoted === true)

// --- 93. a pattern failing once per project is an agent habit: the index churn gate
// must not starve cross-project escalation (first failure of count<2 was skipped) ---
const escGlobal = join(tmp, "escalate-global")
const escProjA = join(tmp, "escalate-a")
const escProjB = join(tmp, "escalate-b")
const R93_CMD = "some-cli deploy --thing"
const r93Sig = callSignature("bash", { command: R93_CMD }) ?? ""
const escKey = patternKey(r93Sig)
const escStoresA = new Stores(new GateStore(escGlobal), new GateStore(join(escProjA, ".opencode", "dejavu")))
const escStoresB = new Stores(new GateStore(escGlobal), new GateStore(join(escProjB, ".opencode", "dejavu")))
await escStoresA.recordFailure({ key: escKey, signature: r93Sig, tool: "bash", sessionID: "ea1", projectDir: escProjA, snippet: "boom failed", globalProjects: GLOBAL_PROJECTS })
await escStoresB.recordFailure({ key: escKey, signature: r93Sig, tool: "bash", sessionID: "eb1", projectDir: escProjB, snippet: "boom failed", globalProjects: GLOBAL_PROJECTS })
const r93GlobalGates = await readJson(join(escGlobal, "gates.json")).catch(() => [] as GateRow[])
check("once-per-project pattern escalates to the global store", r93GlobalGates.some((g) => g.key === escKey))

// --- 94. noise TTL is for TRUE one-offs: a twice-seen watching pattern gets the
// full TTL so slow recurrences (every 8+ days) can still reach the promotion bar ---
const r94Dir = join(tmp, "ttl-project-r94", ".opencode", "dejavu")
const ttlStore = new GateStore(r94Dir)
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
await mkdir(r94Dir, { recursive: true })
await writeFile(
  join(r94Dir, "gates.json"),
  JSON.stringify({
    version: 1,
    gates: [
      seedGate({ key: "dddd00000001", signature: "bash:ttl oneoff cmd", status: "watching", count: 1, lastSeen: tenDaysAgo, firstSeen: tenDaysAgo }),
      seedGate({ key: "dddd00000002", signature: "bash:ttl slow recurrence cmd", status: "watching", count: 2, lastSeen: tenDaysAgo, firstSeen: tenDaysAgo }),
    ],
  }),
  "utf8",
)
await ttlStore.runLocked(async () => {
  await ttlStore.expire(TTL_DAYS, NOISE_TTL_DAYS)
})
const ttlLeft = await readJson(join(r94Dir, "gates.json"))
check("one-off watching pattern still rots on the noise TTL", !ttlLeft.some((g) => g.key === "dddd00000001"))
check("twice-seen watching pattern survives past the noise TTL", ttlLeft.some((g) => g.key === "dddd00000002"))

// --- 95. chain bypass through command substitution: a gate must fire when the
// command hides inside $(...) or backticks ---
const substDir = join(tmp, "subst-project")
const SUBST_CMD = "custom-subst-tool --deploy-now"
const substKey = patternKey(callSignature("bash", { command: SUBST_CMD }) ?? "")
await seedGates(substDir, [seedGate({ key: substKey, signature: `bash:${SUBST_CMD}` })])
const hooksSUB = await Dejavu({ directory: substDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const substHit = await attemptWith(hooksSUB)(`echo prefix $(${SUBST_CMD}) suffix-more-text`, "sub1", "sub1")
check("gate fires through $(...) command substitution", substHit !== null && substHit.message.includes("[dejavu] REMINDER"))
const substHit2 = await attemptWith(hooksSUB)("echo prefix `" + SUBST_CMD + "` suffix-more-text", "sub2", "sub2")
check("gate fires through backtick substitution", substHit2 !== null && substHit2.message.includes("[dejavu] REMINDER"))

// --- 96. before-hook fallback covers UNGATED calls: an after-hook that arrives
// without args must still record a NEW pattern via the pendingCalls signature ---
await attempt("brand-new-failing-tool --x", "s-pf", "pf1")
await after(
  { tool: "bash", sessionID: "s-pf", callID: "pf1" } as unknown as AfterInput,
  { title: "brand-new-failing-tool --x", output: "command not found", metadata: { exit: 127 } } as unknown as AfterOutput,
)
check(
  "pendingCalls fallback records a new pattern when the after-hook lacks args",
  (await readGates()).some((g) => g.signature === "bash:brand-new-failing-tool --x"),
)

// --- 97. enforcement policy round-10: PowerShell probes, Unix viewers, family shapes ---
// PowerShell read-only probes are diagnostics: never block, remind at most.
check("get-process cannot block", !canBlock("bash", "bash:get-process -name <str> -erroraction silentlycontinue | select-object id, processname"))
check("get-process can remind", canRemind("bash", "bash:get-process -name <str>"))
check("get-item/get-childitem cannot block", !canBlock("bash", "bash:get-item <str> -erroraction silentlycontinue") && !canBlock("bash", "bash:get-childitem -path <str> -directory"))
check("get-content/test-path/resolve-path cannot block", !canBlock("bash", "bash:get-content <str>") && !canBlock("bash", "bash:test-path <str>") && !canBlock("bash", "bash:resolve-path <str>"))
check("probe exit 1 is intended (empty result set)", isIntendedNonzero("get-process -name dart -erroraction silentlycontinue", 1))
// Unix viewers: never block, always remindable — but their exit 1 stays RECORDABLE
// (a missing file / not-recognized is teachable, unlike a diagnostic's empty result).
check("cat|head cannot block but can remind", !canBlock("bash", "bash:cat <str> | head - <n>") && canRemind("bash", "bash:cat <str> | head - <n>"))
check("wc/head/tail cannot block", !canBlock("bash", "bash:wc -l <str> <str>") && !canBlock("bash", "bash:head - <n> <str>") && !canBlock("bash", "bash:tail - <n> <str>"))
check("viewer exit 1 still counts (teachable, not intended)", !isIntendedNonzero("cat missing.txt", 1) && !isIntendedNonzero("npm test && tail -5 missing.log", 1))
check("head:refs refspec is not a viewer (git push stays blockable)", canBlock("bash", "bash:git push origin head:refs/heads/feat/x <n> >& <n>"))
// Family shapes: verb phrase + fully parameterized args = watching only.
check("npx tsx <str> is a family (no identity)", !hasResidualIdentity("bash:npx tsx <str>") && !canBlock("bash", "bash:npx tsx <str>"))
check("npx tsx with a literal script keeps identity", hasResidualIdentity("bash:npx tsx scripts/x.ts"))
check("git commit -m <str> is a family (every commit)", !hasResidualIdentity("bash:git commit -m <str>") && !hasResidualIdentity("bash:cd <path> && git commit -m <str> -m <str> -m <str>"))
check("git commit with a pathspec keeps identity", hasResidualIdentity("bash:git commit src/foo.ts -m <str>"))
check("bun run <str> is a family, bun run script is not", !hasResidualIdentity("bash:bun run <str>") && hasResidualIdentity("bash:bun run scripts/build.ts") && hasResidualIdentity("bash:bun test/smoke.ts"))
check("npx tsc keeps identity (package name is the call)", hasResidualIdentity("bash:npx tsc --noemit <n> >& <n>"))
check("git push/status keep identity", hasResidualIdentity("bash:git push origin master") && hasResidualIdentity("bash:git status --short"))
// PowerShell table rows are success-shaped probe data, never failure evidence.
check("process table row is success-shaped", looksLikeSuccess("78692 dart        02.09.2026 1:10:14"))
check("file table row is success-shaped", looksLikeSuccess("D:\\Sources\\x\\7_Profile.png  04.09.2026 18:36:50"))
check("dir-listing mode row is success-shaped", looksLikeSuccess("-a----        04.09.2026     18:36           1234 f.ts"))
check("real error line is not success-shaped", !looksLikeSuccess("Error: cannot find module foo"))
if (process.platform === "win32") {
  check("bare exit code on a unix-only tool teaches the PowerShell form", suggestCorrection("bash:git status --short | head - <n>", "exit code 1").includes("Select-Object"))
  check("bare exit code on cat|head teaches the PowerShell form", suggestCorrection("bash:cat <str> | head - <n>", "exit code 1").includes("Unix tool"))
}
// 97b. legacy override fallback: overrideCount past the bar with NO session
// tracking (predates overrideSessions) demotes on the migrate feedback catch-up.
const legOvDir = join(tmp, "legacy-override-project")
const LEG_OV_CMD = "legacy deploy --force-prod"
const legOvKey = patternKey(callSignature("bash", { command: LEG_OV_CMD }) ?? "")
await seedGates(legOvDir, [seedGate({ key: legOvKey, signature: `bash:${LEG_OV_CMD}`, status: "blocking", overrideCount: DEMOTE_OVERRIDES })])
await Dejavu({ directory: legOvDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const legOvGate = (await readJson(join(legOvDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === legOvKey)
check("legacy overrides without session tracking still demote", legOvGate?.status === "watching" && legOvGate?.feedbackDemoted === true)
// 97c. diagnostic recurrence exemption: a reminding diagnostic gate failing again
// is the iteration itself — recurredAfterGate must not grow (the 38-reminder case).
const diagDir = join(tmp, "diag-recurrence-project")
const DIAG_CMD = "npx vitest run tests/app.test.ts 2>&1"
const diagSig = callSignature("bash", { command: DIAG_CMD }) ?? ""
const diagKey = patternKey(diagSig)
await seedGates(diagDir, [seedGate({ key: diagKey, signature: diagSig, status: "reminding" })])
const hooksDiag = await Dejavu({ directory: diagDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await failOn(hooksDiag)(DIAG_CMD, "dr-a", "dr-a1")
await failOn(hooksDiag)(DIAG_CMD, "dr-a", "dr-a2")
const diagGate = (await readJson(join(diagDir, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === diagKey)
check("diagnostic recurrence does not grow recurredAfterGate", (diagGate?.recurredAfterGate ?? 0) === 0)
check("diagnostic reminder still counts (remindedCount grows)", (diagGate?.remindedCount ?? 0) === 1)

// --- 98. inherited-spawn guard: Start-Process -RedirectStandard* leaks THIS
// call's stdio pipes to the spawned process (handle inheritance); a daemon that
// outlives the call hangs it forever (opencode ends calls on stdio EOF). ---
const SPAWN_1 = '$d = "C:\\t"; $p = Start-Process dart -ArgumentList "x" -WorkingDirectory $d -WindowStyle Hidden -PassThru -RedirectStandardOutput "$d\\out.log"; "PID=$($p.Id)"'
const SPAWN_2 = '$p = Start-Process dart -ArgumentList "y" -WindowStyle Hidden -PassThru -RedirectStandardOutput "o.log" -RedirectStandardError "e.log"; "PID=$($p.Id)"; $p.Id | Out-File "p.pid"'
check("inherited-spawn: hidden + stdout redirect flags", shouldWarnInheritedSpawn(SPAWN_1))
check("inherited-spawn: hidden + full out/err redirect flags", shouldWarnInheritedSpawn(SPAWN_2))
check("inherited-spawn: hidden + -Wait flags", shouldWarnInheritedSpawn("Start-Process dart x -WindowStyle Hidden -Wait"))
check("inherited-spawn: hidden spawn piped flags", shouldWarnInheritedSpawn("Start-Process dart x -WindowStyle Hidden | Out-Null"))
check("inherited-spawn: bare hidden spawn does NOT flag (no leak)", !shouldWarnInheritedSpawn('Start-Process pwsh -ArgumentList "-c","x" -WindowStyle Hidden -PassThru'))
check("inherited-spawn: redirect without hidden does NOT flag (v1 conservative)", !shouldWarnInheritedSpawn("Start-Process dart x -RedirectStandardOutput o.log"))
check("inherited-spawn: minimized window + redirect flags", shouldWarnInheritedSpawn("Start-Process dart x -WindowStyle Minimized -RedirectStandardOutput o.log"))
check("inherited-spawn: server starter + redirect flags", shouldWarnInheritedSpawn("Start-Process npm run dev -RedirectStandardOutput dev.log"))
check("inherited-spawn: bare server starter does NOT flag", !shouldWarnInheritedSpawn("Start-Process npm run dev"))
check("orphan-job: Start-Job without an in-call wait flags", shouldWarnOrphanJob("Start-Job { deploy-tool --bg }"))
check("orphan-job: Start-Job + Wait-Job does NOT flag", !shouldWarnOrphanJob("Start-Job { x } | Wait-Job | Receive-Job"))
check("orphan-job: Receive-Job -Wait does NOT flag", !shouldWarnOrphanJob("$j = Start-Job { x }; Receive-Job -Job $j -Wait"))
// --- 98b. wait-loop: -Milliseconds/-Seconds spellings were invisible to the guard ---
check("wait-loop: unbounded while + Test-Path + -Milliseconds flags", shouldWarnWaitLoop('while (-not (Test-Path "$d\\done.flag")) { Start-Sleep -Milliseconds 500 }'))
check("wait-loop: multi-line while + Test-Path flags", shouldWarnWaitLoop('while (-not (Test-Path $f)) {\n  Start-Sleep -Milliseconds 500\n}'))
check("wait-loop: bounded for + -Milliseconds stays unflagged", !shouldWarnWaitLoop("for ($i=0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Test-Path f) { break } }"))

// --- 99. repeat channel ---
interface R99Part {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string }
}
interface R99Msg {
  info: { role: string; sessionID?: string }
  parts: R99Part[]
}
const r99Asst = (input: Record<string, unknown>, state: Record<string, unknown> = {}, sessionID = "r99s"): R99Msg => ({
  info: { role: "assistant", sessionID },
  parts: [{ type: "tool", tool: "background_output", state: { status: "completed", output: "ok", ...state, input } }],
})
const r99AsstErr = (input: Record<string, unknown>): R99Msg => r99Asst(input, { status: "error", output: undefined, error: "boom" })
const r99User = (sessionID = "r99s"): R99Msg => ({ info: { role: "user", sessionID }, parts: [{ type: "text" }] })

check("canonicalArgs is key-order independent", canonicalArgs({ b: 2, a: 1 }) === canonicalArgs({ a: 1, b: 2 }))
check("canonicalArgs strips repeat markers", canonicalArgs({ task_id: "x", [REPEAT_MARKER]: 3, [REPEAT_PROCEED]: true }) === canonicalArgs({ task_id: "x" }))
check("detectRepeatSeries: no series in empty/single history", detectRepeatSeries([]).series.length === 0 && detectRepeatSeries([r99Asst({ task_id: "t1" })]).series.length === 0)
const r99ScanRun = detectRepeatSeries([r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" })])
check("detectRepeatSeries: series of 3 consecutive rounds", r99ScanRun.series.length === 1 && r99ScanRun.series[0]?.occurrences.length === 3 && r99ScanRun.series[0]?.reachesTail === true)
const r99DupRound: R99Msg = {
  info: { role: "assistant", sessionID: "r99s" },
  parts: [
    { type: "tool", tool: "background_output", state: { input: { task_id: "t1" } } },
    { type: "tool", tool: "background_output", state: { input: { task_id: "t1" } } },
  ],
}
check("detectRepeatSeries: intra-round duplicates are one round", detectRepeatSeries([r99DupRound]).series.length === 0)
const r99ScanBreak = detectRepeatSeries([r99Asst({ task_id: "t1" }), r99User(), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" })])
check("detectRepeatSeries: user message breaks the run", r99ScanBreak.series.length === 1 && r99ScanBreak.series[0]?.occurrences.length === 2)
const r99ScanMimic = detectRepeatSeries([r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1", [REPEAT_MARKER]: 1 }), r99Asst({ task_id: "t1", [REPEAT_MARKER]: 2 })])
check("detectRepeatSeries: marker mimicry still detected", r99ScanMimic.series.length === 1 && r99ScanMimic.series[0]?.occurrences.length === 3)
check("detectRepeatSeries: sessionID from first message", detectRepeatSeries([r99User("ses_x"), r99Asst({ task_id: "t1" })]).sessionID === "ses_x")

const r99Dir = join(tmp, "r99-project")
const r99Hooks = await Dejavu({ directory: r99Dir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const r99Transform: TransformHook | undefined = r99Hooks["experimental.chat.messages.transform"]
const r99TransformReady = typeof r99Transform === "function"
const r99Before = r99Hooks["tool.execute.before"] as BeforeHook
check("transform hook is registered", r99TransformReady)

const r99Msgs10: R99Msg[] = [r99User(), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" })]
await r99Transform?.({} as never, { messages: r99Msgs10 } as never)
check(
  "sanitize: series of 3 gets markers on occurrences 2+3 only",
  r99TransformReady &&
    r99Msgs10[1]?.parts[0]?.state?.input?.[REPEAT_MARKER] === undefined &&
    r99Msgs10[2]?.parts[0]?.state?.input?.[REPEAT_MARKER] === 1 &&
    r99Msgs10[3]?.parts[0]?.state?.input?.[REPEAT_MARKER] === 2,
)
const r99Msgs11: R99Msg[] = [r99User(), r99Asst({ task_id: "a" }), r99Asst({ task_id: "b" }), r99Asst({ task_id: "c" })]
await r99Transform?.({} as never, { messages: r99Msgs11 } as never)
check("sanitize: no series, no mutation", r99TransformReady && r99Msgs11.every((m) => m.parts.every((p) => p.state?.input?.[REPEAT_MARKER] === undefined)))
const r99Msgs12: R99Msg[] = [r99User(), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" })]
await r99Transform?.({} as never, { messages: r99Msgs12 } as never)
const r99NoteOut = r99Msgs12[2]?.parts[0]?.state?.output ?? ""
check("remind NOTE appended on tail series of length 2", r99TransformReady && r99NoteOut.includes("[dejavu] REPETITION") && r99NoteOut.includes("CORRECTION"))
const r99Msgs13: R99Msg[] = [r99User(), r99AsstErr({ task_id: "t1" }), r99AsstErr({ task_id: "t1" })]
await r99Transform?.({} as never, { messages: r99Msgs13 } as never)
const r99NoteErr = r99Msgs13[2]?.parts[0]?.state?.error ?? ""
check("remind NOTE goes to state.error for error parts", r99TransformReady && r99NoteErr.includes("[dejavu] REPETITION"))
const r99Msgs14: R99Msg[] = [r99User(), r99Asst({ task_id: "t1" }), r99Asst({ task_id: "t1" }), r99User(), r99Asst({ task_id: "t2" })]
await r99Transform?.({} as never, { messages: r99Msgs14 } as never)
check(
  "middle (non-tail) series is sanitized but NOT noted",
  r99TransformReady &&
    r99Msgs14[1]?.parts[0]?.state?.input?.[REPEAT_MARKER] === undefined &&
    r99Msgs14[2]?.parts[0]?.state?.input?.[REPEAT_MARKER] === 1 &&
    r99Msgs14.every((m) => m.parts.every((p) => !(p.state?.output ?? "").includes("REPETITION") && !(p.state?.error ?? "").includes("REPETITION"))),
)

const r99Msgs15: R99Msg[] = [r99User("r99a"), r99Asst({ task_id: "t1" }, {}, "r99a"), r99Asst({ task_id: "t1" }, {}, "r99a")]
await r99Transform?.({} as never, { messages: r99Msgs15 } as never)
const r99Out15 = { args: { task_id: "t1" } }
let r99Blocked: Error | null = null
try {
  await r99Before({ tool: "background_output", sessionID: "r99a", callID: "r99c1" } as unknown as BeforeInput, r99Out15 as unknown as BeforeOutput)
} catch (e) {
  r99Blocked = e as Error
}
check("block: 3rd identical call is blocked after tail series recorded", r99TransformReady && r99Blocked !== null && r99Blocked.message.includes("REPEAT BLOCKED"))
const r99Out16 = { args: { task_id: "t1", [REPEAT_PROCEED]: true, [REPEAT_MARKER]: 9 } }
let r99Bypass: Error | null = null
try {
  await r99Before({ tool: "background_output", sessionID: "r99a", callID: "r99c2" } as unknown as BeforeInput, r99Out16 as unknown as BeforeOutput)
} catch (e) {
  r99Bypass = e as Error
}
check("block: _dejavu_proceed bypasses and strips markers", r99TransformReady && r99Bypass === null && !(REPEAT_PROCEED in r99Out16.args) && !(REPEAT_MARKER in r99Out16.args))
const r99Out17 = { args: { task_id: "t2" } }
let r99Changed: Error | null = null
try {
  await r99Before({ tool: "background_output", sessionID: "r99a", callID: "r99c3" } as unknown as BeforeInput, r99Out17 as unknown as BeforeOutput)
} catch (e) {
  r99Changed = e as Error
}
check("block: changed args pass", r99TransformReady && r99Changed === null)
const r99Out18 = { args: { task_id: "t1" } }
let r99Other: Error | null = null
try {
  await r99Before({ tool: "background_output", sessionID: "r99b", callID: "r99c4" } as unknown as BeforeInput, r99Out18 as unknown as BeforeOutput)
} catch (e) {
  r99Other = e as Error
}
check("block: different session does not block", r99TransformReady && r99Other === null)
const r99Msgs19: R99Msg[] = [r99User(), r99Asst({ task_id: "t1", [REPEAT_MARKER]: 1 }), r99Asst({ task_id: "t1", [REPEAT_MARKER]: 1 })]
await r99Transform?.({} as never, { messages: r99Msgs19 } as never)
check(
  "sanitize: mimicked markers are overwritten to keep occurrences byte-distinct",
  r99TransformReady && JSON.stringify(r99Msgs19[1]?.parts[0]?.state?.input) !== JSON.stringify(r99Msgs19[2]?.parts[0]?.state?.input),
)

// --- 100. interpreter one-liner fingerprint with valued/long flags + fuzzy payload-class guard ---
const r100Sig1 = callSignature("bash", { command: 'python -X utf8 -c "print(1)"' }) ?? ""
const r100Sig2 = callSignature("bash", { command: 'python -X utf8 -c "print(2)"' }) ?? ""
const r100Sig3 = callSignature("bash", { command: 'python -X utf8 -c "print(1)"' }) ?? ""
check("one-liner with a valued flag fingerprints (-X utf8)", /^bash:python -x utf8 -c <code:[0-9a-f]{8}>$/.test(r100Sig1))
check("different one-liners with -X utf8 get different keys", r100Sig1 !== r100Sig2)
check("same one-liner with -X utf8 is stable", r100Sig1 === r100Sig3)
check("one-liner with a long valued flag fingerprints (node --import)", (callSignature("bash", { command: 'node --import tsx -e "console.log(1)"' }) ?? "").includes("<code:"))
check("one-liner with -W flag fingerprints", (callSignature("bash", { command: 'python -W ignore -c "import sys"' }) ?? "").includes("<code:"))
check("one-liner fingerprint stays idempotent after the flag fix", (callSignature("bash", { command: normalizeCommand('python -X utf8 -c "print(1)"') }) ?? "") === r100Sig1)
check("fuzzy: residue -c <str> never matches <path> payload class", !fuzzySimilar("bash:python -x utf8 -c <str>", "bash:python -x utf8 <path>"))
check("fuzzy: residue -e <str> never matches -e <path>", !fuzzySimilar("bash:node -e <str>", "bash:node -e <path>"))
check("fuzzy: distinct code hashes still never merge", !fuzzySimilar("bash:python -x utf8 <code:aaaa1111>", "bash:python -x utf8 <code:bbbb2222>"))
check("fuzzy: legit near-duplicates still merge", fuzzySimilar("bash:node scripts/check-i18n-parity.mjs <n> >& <n>", "bash:node scripts/check-i18n-parity.mjs --full <n> >& <n>"))

// --- 101. iteration discriminator: workspace movement or a changed error form
// downgrades enforcement (stuck = same world; iteration = the world moved) ---
const r101Edit = async (h: Hooks, session: string, callID: string): Promise<void> => {
  await (h["tool.execute.after"] as AfterHook)(
    { tool: "edit", sessionID: session, callID, args: { filePath: "x.ts" } } as unknown as AfterInput,
    { title: "x.ts", output: "ok", metadata: {} } as unknown as AfterOutput,
  )
}
const r101FailWith = async (h: Hooks, cmd: string, session: string, callID: string, out: string, exitCode = 1): Promise<string> => {
  const payload = { title: cmd, output: out, metadata: { exit: exitCode } }
  await (h["tool.execute.after"] as AfterHook)(
    { tool: "bash", sessionID: session, callID, args: { command: cmd } } as unknown as AfterInput,
    payload as unknown as AfterOutput,
  )
  return payload.output
}
// stuck baseline: identical world + identical error — recurrence grows
const r101Dir1 = join(tmp, "r101-stuck-project")
const R101_CMD1 = "deploy-tool --verify-alpha"
const r101Key1 = patternKey(callSignature("bash", { command: R101_CMD1 }) ?? "")
await seedGates(r101Dir1, [seedGate({ key: r101Key1, signature: `bash:${R101_CMD1}`, status: "blocking", snippet: "exit code 1" })])
const r101Hooks1 = await Dejavu({ directory: r101Dir1, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await r101FailWith(r101Hooks1, R101_CMD1, "r101a", "r101c1", "exit code 1")
await r101FailWith(r101Hooks1, R101_CMD1, "r101a", "r101c2", "exit code 1")
const r101Gate1 = (await readJson(join(r101Dir1, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key1)
check("stuck: identical world + identical error grows recurrence", r101Gate1?.recurredAfterGate === 2)
// iteration via workspace movement
const r101Dir2 = join(tmp, "r101-iter-project")
const R101_CMD2 = "deploy-tool --verify-beta"
const r101Key2 = patternKey(callSignature("bash", { command: R101_CMD2 }) ?? "")
await seedGates(r101Dir2, [seedGate({ key: r101Key2, signature: `bash:${R101_CMD2}`, status: "blocking", snippet: "exit code 1" })])
const r101Hooks2 = await Dejavu({ directory: r101Dir2, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await r101FailWith(r101Hooks2, R101_CMD2, "r101b", "r101c3", "exit code 1")
await r101Edit(r101Hooks2, "r101b", "r101c4")
await r101FailWith(r101Hooks2, R101_CMD2, "r101b", "r101c5", "exit code 1")
const r101Gate2 = (await readJson(join(r101Dir2, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key2)
check(
  "iteration: edit between failures stops recurrence growth",
  r101Gate2?.recurredAfterGate === 1 && r101Gate2?.movedOn === 1 && r101Gate2?.iteratedVersion === 1,
)
// iteration via changed error form (no edits)
const r101Dir3 = join(tmp, "r101-errform-project")
const R101_CMD3 = "deploy-tool --verify-gamma"
const r101Key3 = patternKey(callSignature("bash", { command: R101_CMD3 }) ?? "")
await seedGates(r101Dir3, [seedGate({ key: r101Key3, signature: `bash:${R101_CMD3}`, status: "blocking", snippet: "exit code 1" })])
const r101Hooks3 = await Dejavu({ directory: r101Dir3, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await r101FailWith(r101Hooks3, R101_CMD3, "r101c", "r101c6", "AssertionError: first layout")
await r101FailWith(r101Hooks3, R101_CMD3, "r101c", "r101c7", "TypeError: second path")
const r101Gate3a = (await readJson(join(r101Dir3, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key3)
check("iteration: changed error form without edits counts as movement", r101Gate3a?.recurredAfterGate === 1 && r101Gate3a?.movedOn === 1)
await r101FailWith(r101Hooks3, R101_CMD3, "r101c", "r101c8", "TypeError: second path")
const r101Gate3b = (await readJson(join(r101Dir3, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key3)
check("stuck: identical informative error grows recurrence", r101Gate3b?.recurredAfterGate === 2)
// NOTE suppression on iteration (reminding gate)
const r101Dir4 = join(tmp, "r101-note-project")
const R101_CMD4 = "npx vitest run x.test.ts 2>&1"
const r101Key4 = patternKey(callSignature("bash", { command: R101_CMD4 }) ?? "")
await seedGates(r101Dir4, [seedGate({ key: r101Key4, signature: `bash:${R101_CMD4}`, status: "reminding", snippet: "exit code 1" })])
const r101Hooks4 = await Dejavu({ directory: r101Dir4, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const r101Out4a = await r101FailWith(r101Hooks4, R101_CMD4, "r101d1", "r101c9", "FAIL x.test.ts\nError: boom", 2)
await r101Edit(r101Hooks4, "r101d2", "r101c10")
const r101Out4b = await r101FailWith(r101Hooks4, R101_CMD4, "r101d2", "r101c11", "FAIL x.test.ts\nError: boom", 2)
check("reminding: NOTE rides a fresh first-encounter failure", r101Out4a.includes("[dejavu] NOTE"))
check("iteration: NOTE suppressed when the workspace moved", !r101Out4b.includes("[dejavu] NOTE"))
// block chain yields to an edit, re-arms, and blocks a bare retry
const r101Dir5 = join(tmp, "r101-chain-project")
const R101_CMD5 = "deploy-tool --verify-delta"
const r101Key5 = patternKey(callSignature("bash", { command: R101_CMD5 }) ?? "")
await seedGates(r101Dir5, [seedGate({ key: r101Key5, signature: `bash:${R101_CMD5}`, status: "blocking", snippet: "exit code 1" })])
const r101Hooks5 = await Dejavu({ directory: r101Dir5, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const r101Att = attemptWith(r101Hooks5)
await r101Att(R101_CMD5, "r101e", "r101d1")
await r101FailWith(r101Hooks5, R101_CMD5, "r101e", "r101d2", "exit code 1")
const r101Blocked1 = await r101Att(R101_CMD5, "r101e", "r101d3")
await r101Edit(r101Hooks5, "r101e", "r101d4")
const r101Allowed = await r101Att(R101_CMD5, "r101e", "r101d5")
await r101FailWith(r101Hooks5, R101_CMD5, "r101e", "r101d6", "exit code 1")
const r101Blocked2 = await r101Att(R101_CMD5, "r101e", "r101d7")
check("iteration: edited retry passes an armed block", r101Blocked1 !== null && r101Blocked1.message.includes("BLOCKED") && r101Allowed === null)
check("iteration: unedited retry after an iterated failure blocks again", r101Blocked2 !== null && r101Blocked2.message.includes("BLOCKED"))
// promotion dampening: all-moved evidence never leaves watching
const r101Dir6 = join(tmp, "r101-promote-project")
const R101_CMD6 = "deploy-tool --deep-scan-zeta"
const r101Hooks6 = await Dejavu({ directory: r101Dir6, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await r101FailWith(r101Hooks6, R101_CMD6, "r101f1", "r101e1", "exit code 1")
await r101Edit(r101Hooks6, "r101f1", "r101e2")
await r101FailWith(r101Hooks6, R101_CMD6, "r101f2", "r101e3", "exit code 1")
await r101Edit(r101Hooks6, "r101f2", "r101e4")
await r101FailWith(r101Hooks6, R101_CMD6, "r101f1", "r101e5", "exit code 1")
const r101Key6 = patternKey(callSignature("bash", { command: R101_CMD6 }) ?? "")
const r101Gate6 = (await readJson(join(r101Dir6, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key6)
check("iteration: all-moved evidence does not promote", r101Gate6 !== undefined && r101Gate6.status === "watching")
const r101Dir7 = join(tmp, "r101-promote-control")
const R101_CMD7 = "deploy-tool --full-scan-eta"
const r101Hooks7 = await Dejavu({ directory: r101Dir7, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
await r101FailWith(r101Hooks7, R101_CMD7, "r101g1", "r101f1", "exit code 1")
await r101FailWith(r101Hooks7, R101_CMD7, "r101g2", "r101f2", "exit code 1")
await r101FailWith(r101Hooks7, R101_CMD7, "r101g1", "r101f3", "exit code 1")
const r101Key7 = patternKey(callSignature("bash", { command: R101_CMD7 }) ?? "")
const r101Gate7 = (await readJson(join(r101Dir7, ".opencode", "dejavu", "gates.json"))).find((g) => g.key === r101Key7)
check("stuck: unmoved evidence promotes normally", r101Gate7 !== undefined && r101Gate7.status === "blocking")
// coerced {t,v} failedSession shape loads and blocks when nothing moved
const r101Dir8 = join(tmp, "r101-coerce-project")
const R101_CMD8 = "deploy-tool --verify-epsilon"
const r101Key8 = patternKey(callSignature("bash", { command: R101_CMD8 }) ?? "")
await seedGates(r101Dir8, [seedGate({ key: r101Key8, signature: `bash:${R101_CMD8}`, status: "blocking", snippet: "exit code 1", failedSessions: { r101h: { t: Date.now(), v: 0 } } })])
const r101Hooks8 = await Dejavu({ directory: r101Dir8, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const r101Blocked3 = await attemptWith(r101Hooks8)(R101_CMD8, "r101h", "r101g1")
check("iteration: coerced {t,v} failedSession still blocks when nothing moved", r101Blocked3 !== null && r101Blocked3.message.includes("BLOCKED"))

// 101c. regression: after escalation the project store's key index must not keep
// serving the removed gate — a raw splice in phase 3c left byKey() returning the
// extracted gate, so the next failure re-landed on the project store as a fresh
// duplicate (evidence fragmented; iteratedVersion/movedOn lost mid-flight).
const r101EscGlobal = join(tmp, "r101-esc-global")
const r101EscA = join(tmp, "r101-esc-a")
const r101EscB = join(tmp, "r101-esc-b")
const R101_ESCSIG = callSignature("bash", { command: "deploy-tool --verify-escalation" }) ?? ""
const r101EscKey = patternKey(R101_ESCSIG)
const r101ProjStoreB = new GateStore(join(r101EscB, ".opencode", "dejavu"))
const r101StoresA = new Stores(new GateStore(r101EscGlobal), new GateStore(join(r101EscA, ".opencode", "dejavu")))
const r101StoresB = new Stores(new GateStore(r101EscGlobal), r101ProjStoreB)
await r101StoresA.recordFailure({ key: r101EscKey, signature: R101_ESCSIG, tool: "bash", sessionID: "ra1", projectDir: r101EscA, snippet: "boom", globalProjects: GLOBAL_PROJECTS })
await r101StoresB.recordFailure({ key: r101EscKey, signature: R101_ESCSIG, tool: "bash", sessionID: "rb1", projectDir: r101EscB, snippet: "boom", globalProjects: GLOBAL_PROJECTS })
// escalated now (2 projects). The project store instance that served the
// escalation must not keep serving the removed key from a stale key index.
await r101ProjStoreB.load()
check("byKey does not return an extracted gate (stale key index regression)", r101ProjStoreB.byKey(r101EscKey) === undefined)
await r101StoresB.recordFailure({ key: r101EscKey, signature: R101_ESCSIG, tool: "bash", sessionID: "rb2", projectDir: r101EscB, snippet: "boom", globalProjects: GLOBAL_PROJECTS })
const r101EscProjGates = await readJson(join(r101EscB, ".opencode", "dejavu", "gates.json")).catch(() => [] as GateRow[])
const r101EscGlobGate = (await readJson(join(r101EscGlobal, "gates.json"))).find((g) => g.key === r101EscKey)
check("post-escalation failure grows the global copy, no project duplicate", !r101EscProjGates.some((g) => g.key === r101EscKey) && r101EscGlobGate?.count === 2)

// --- 86. round-8 invariant: a corrupt GLOBAL gates.json is quarantined under the
// gates lock by reconcile(); the unlocked routing peeks in reconcileAll (escalation
// filter + index rebuild) are non-force and never write. After init the store is
// fresh and the corrupt bytes are kept. (Runs last: it corrupts the shared global
// store, so nothing after it may depend on global gates.) ---
const r8ProjDir = join(tmp, "round8-project")
const r8GlobalDir = join(tmp, "global")
await mkdir(r8GlobalDir, { recursive: true })
await writeFile(join(r8GlobalDir, "gates.json"), "{ corrupted global gates", "utf8")
await Dejavu({ directory: r8ProjDir, client: { app: { log: async () => ({}) } } } as unknown as Ctx)
const r8Quarantine = (await readdir(r8GlobalDir)).filter((f) => f.startsWith("gates.json.corrupt-"))
check("corrupt global gates.json is quarantined by under-lock reconcile", r8Quarantine.length >= 1)
check("corrupt global bytes are preserved", (await readFile(join(r8GlobalDir, r8Quarantine[0] ?? ""), "utf8")).includes("corrupted global gates"))
check("global store restarts fresh after quarantine", (await readJson(join(r8GlobalDir, "gates.json"))).length === 0)

await rm(tmp, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
