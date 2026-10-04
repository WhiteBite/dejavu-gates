/**
 * End-to-end CLI suite: spawns `bun src/cli.ts` per hook event over a temp
 * store and asserts the harness decision on stdout/stderr/exit-code, plus the
 * promoted-gate artifact on disk. Run: bun test/cli.ts
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { formatStdout } from "../src/cli"
import { callSignature, patternKey } from "../src/patterns"
import type { OutboundDecision } from "../src/types"
import { makeChecker } from "./helpers"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const cliPath = join(repoRoot, "src", "cli.ts")
const root = await mkdtemp(join(tmpdir(), "dejavu-cli-test-"))

const { check, report } = makeChecker()

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runCli(phase: string, harness: string, payload: unknown, storeDir: string, globalDir: string): CliResult {
  const proc = spawnSync("bun", [cliPath, phase, "--harness", harness, "--store", storeDir], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, DEJAVU_HOME: globalDir },
    cwd: repoRoot,
    encoding: "utf8",
  })
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 }
}

/** like runCli but with no --store override, so the CLI canonicalizes the cwd to its git root */
function runCliNoStore(phase: string, harness: string, payload: unknown, spawnCwd: string, globalDir: string): CliResult {
  const proc = spawnSync("bun", [cliPath, phase, "--harness", harness], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, DEJAVU_HOME: globalDir },
    cwd: spawnCwd,
    encoding: "utf8",
  })
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 }
}

interface World {
  storeDir: string
  globalDir: string
}

async function makeWorld(name: string): Promise<World> {
  const storeDir = join(root, `${name}-project`)
  const globalDir = join(root, `${name}-global`)
  return { storeDir, globalDir }
}

function claudePost(session: string, command: string, output: string, store: World): CliResult {
  return runCli(
    "post",
    "claude",
    {
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `tu-${session}`,
      cwd: store.storeDir,
      tool_response: { stdout: "", stderr: output },
    },
    store.storeDir,
    store.globalDir,
  )
}

// --- S1b: a non-diagnostic bash command failing 3x across 2 sessions promotes to a blocking gate ---
const block = await makeWorld("block")
const blockCmd = "boom-tool --prod"
const blockOut = "boom-tool: command not found"
claudePost("sA", blockCmd, blockOut, block)
claudePost("sA", blockCmd, blockOut, block)
const third = claudePost("sB", blockCmd, blockOut, block)
check("seeding the 3rd failure succeeds (exit 0, no block on post)", third.exitCode === 0)

const gatesRaw = await readFile(join(block.storeDir, ".opencode", "dejavu", "gates.json"), "utf8")
const gates = (JSON.parse(gatesRaw) as { gates: Array<{ status: string; count: number; sessions: string[] }> }).gates
const promoted = gates.find((g) => g.count >= 3 && g.sessions.length >= 2)
check("gates.json holds a promoted gate (count>=3, sessions>=2)", promoted !== undefined)
check("promoted gate is blocking (non-diagnostic bash)", promoted?.status === "blocking")

const blockGates = (JSON.parse(gatesRaw) as { gates: Array<{ count: number; iteratedVersion?: number }> }).gates
const blockPromoted = blockGates.find((g) => g.count >= 3)
check("D3: a CLI post failure leaves iteratedVersion absent", blockPromoted !== undefined && blockPromoted.iteratedVersion === undefined)

const blockPre = runCli(
  "pre",
  "claude",
  { hook_event_name: "PreToolUse", session_id: "sC", tool_name: "Bash", tool_input: { command: blockCmd }, tool_use_id: "tu-pre", cwd: block.storeDir },
  block.storeDir,
  block.globalDir,
)
check("claude pre on a blocking gate → exit 2 (block dialect)", blockPre.exitCode === 2)
check("claude pre block → stderr carries the [dejavu] message", blockPre.stderr.includes("[dejavu]"))
check("claude pre block → stdout stays pure JSON {}", blockPre.stdout.trim() === "{}")

// --- S2: a diagnostic command promotes to reminding; its post failure rides a [dejavu] NOTE ---
const remind = await makeWorld("remind")
const diagCmd = "tsc --noEmit"
const diagOut = "src/x.ts(1,1): error TS2304: Cannot find name 'y'."
claudePost("sA", diagCmd, diagOut, remind)
claudePost("sA", diagCmd, diagOut, remind)
claudePost("sB", diagCmd, diagOut, remind)

const remindPost = claudePost("sC", diagCmd, diagOut, remind)
check("claude post on a reminding gate → exit 0 (never blocks)", remindPost.exitCode === 0)
const remindJson = JSON.parse(remindPost.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
check("claude post annotation → additionalContext present (S2, the fixed path)", typeof remindJson.hookSpecificOutput?.additionalContext === "string")
check("claude post annotation carries the [dejavu] NOTE", (remindJson.hookSpecificOutput?.additionalContext ?? "").includes("[dejavu]"))

const remindGates = (JSON.parse(await readFile(join(remind.storeDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { gates: Array<{ status: string }> }).gates
check("diagnostic gate promoted to reminding (never blocking)", remindGates.some((g) => g.status === "reminding"))

// --- deny dialects: fresh blocking gate per harness (a shared gate hits taught-retirement after 5 reminders) ---
const dCmd = "boom-tool --prod"
const dOut = "boom-tool: command not found"

async function seedBlocking(name: string): Promise<World> {
  const w = await makeWorld(name)
  claudePost("sA", dCmd, dOut, w)
  claudePost("sA", dCmd, dOut, w)
  claudePost("sB", dCmd, dOut, w)
  return w
}

function prePayload(harness: string, session: string, storeDir: string): unknown {
  switch (harness) {
    case "claude":
      return { hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: dCmd }, cwd: storeDir }
    case "codex":
      return { hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: dCmd }, cwd: storeDir }
    case "gemini":
      return { hook_event_name: "BeforeTool", session_id: session, tool_name: "run_shell_command", tool_input: { command: dCmd }, cwd: storeDir }
    case "cursor":
      return { hook_event_name: "beforeShellExecution", conversation_id: session, command: dCmd, cwd: storeDir }
    case "copilot":
      return { sessionId: session, toolName: "bash", toolArgs: JSON.stringify({ command: dCmd }), cwd: storeDir }
    case "crush":
      return { event: "PreToolUse", session_id: session, tool_name: "bash", tool_input: { command: dCmd }, cwd: storeDir }
    case "devin":
      return { hook_event_name: "PreToolUse", session_id: session, tool_name: "exec", tool_input: { command: dCmd }, cwd: storeDir }
    case "kiro":
      return { hook_event_name: "preToolUse", session_id: session, tool_name: "shell", tool_input: { command: dCmd }, cwd: storeDir }
    default:
      return {}
  }
}

// exit-2 dialect harnesses (block via stderr)
for (const h of ["claude", "codex", "gemini", "devin", "kiro"] as const) {
  const w = await seedBlocking(`dialect-${h}`)
  const r = runCli("pre", h, prePayload(h, `fresh-${h}`, w.storeDir), w.storeDir, w.globalDir)
  check(`${h} pre deny → exit 2 + [dejavu] on stderr`, r.exitCode === 2 && r.stderr.includes("[dejavu]"))
}

// native-JSON dialect harnesses (block via stdout decision, exit 0)
const cursorW = await seedBlocking("dialect-cursor")
const cursorDeny = runCli("pre", "cursor", prePayload("cursor", "fresh-cursor", cursorW.storeDir), cursorW.storeDir, cursorW.globalDir)
check("cursor pre deny → exit 0 + permission:deny JSON", cursorDeny.exitCode === 0 && (JSON.parse(cursorDeny.stdout) as Record<string, unknown>).permission === "deny")

const copilotW = await seedBlocking("dialect-copilot")
const copilotDeny = runCli("pre", "copilot", prePayload("copilot", "fresh-copilot", copilotW.storeDir), copilotW.storeDir, copilotW.globalDir)
check("copilot pre deny → exit 0 + permissionDecision:deny JSON", copilotDeny.exitCode === 0 && (JSON.parse(copilotDeny.stdout) as Record<string, unknown>).permissionDecision === "deny")

const crushW = await seedBlocking("dialect-crush")
const crushDeny = runCli("pre", "crush", prePayload("crush", "fresh-crush", crushW.storeDir), crushW.storeDir, crushW.globalDir)
check("crush pre deny → exit 0 + decision:deny JSON", crushDeny.exitCode === 0 && (JSON.parse(crushDeny.stdout) as Record<string, unknown>).decision === "deny")

// --- crush degraded: post is a structural no-op ---
const crushPost = runCli("post", "crush", { event: "PostToolUse", session_id: "s", tool_name: "bash", tool_input: { command: dCmd } }, crushW.storeDir, crushW.globalDir)
check("crush post → exit 0 + {} (degraded, no post channel)", crushPost.exitCode === 0 && crushPost.stdout.trim() === "{}")

// --- devin post annotate rides hookSpecificOutput.additionalContext (claude dialect) ---
async function seedReminding(name: string): Promise<World> {
  const w = await makeWorld(name)
  claudePost("sA", diagCmd, diagOut, w)
  claudePost("sA", diagCmd, diagOut, w)
  claudePost("sB", diagCmd, diagOut, w)
  return w
}

const devinRemind = await seedReminding("dialect-devin-post")
const devinPost = runCli(
  "post",
  "devin",
  { hook_event_name: "PostToolUse", session_id: "fresh-devin", tool_name: "exec", tool_input: { command: diagCmd }, cwd: devinRemind.storeDir, tool_response: { stdout: "", stderr: diagOut } },
  devinRemind.storeDir,
  devinRemind.globalDir,
)
check("devin post on a reminding gate → exit 0", devinPost.exitCode === 0)
const devinPostJson = JSON.parse(devinPost.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }
check("devin post annotation → hookSpecificOutput.additionalContext carries the [dejavu] NOTE", (devinPostJson.hookSpecificOutput?.additionalContext ?? "").includes("[dejavu]"))
check("devin post annotation → hookEventName PostToolUse", devinPostJson.hookSpecificOutput?.hookEventName === "PostToolUse")

// --- kiro post annotate rides raw stdout (Kiro injects hook stdout into agent context) ---
const kiroRemind = await seedReminding("dialect-kiro-post")
const kiroPost = runCli(
  "post",
  "kiro",
  { hook_event_name: "postToolUse", session_id: "fresh-kiro", tool_name: "shell", tool_input: { command: diagCmd }, cwd: kiroRemind.storeDir, tool_response: { stdout: "", stderr: diagOut } },
  kiroRemind.storeDir,
  kiroRemind.globalDir,
)
check("kiro post on a reminding gate → exit 0", kiroPost.exitCode === 0)
check("kiro post annotation → stdout carries the raw [dejavu] NOTE (not JSON)", kiroPost.stdout.includes("[dejavu]") && !kiroPost.stdout.trimStart().startsWith("{"))

// --- fail-open: malformed stdin never blocks the user's tool call ---
const malformed = runCli("pre", "claude", "{not valid json", block.storeDir, block.globalDir)
check("malformed stdin → exit 0 + {} (fail-open)", malformed.exitCode === 0 && malformed.stdout.trim() === "{}")

const malformedKiro = runCli("pre", "kiro", "{not valid json", block.storeDir, block.globalDir)
check("malformed stdin on kiro → exit 0 + silent stdout (fail-open, nothing injected)", malformedKiro.exitCode === 0 && malformedKiro.stdout === "")

// --- SessionEnd cleanup: Claude session teardown wipes the ended session's gate state ---
const se = await makeWorld("session-end")
const SE_SIG = "bash:se-cleanup-tool --prod"
const seGate = {
  key: "bbbb22222222",
  signature: SE_SIG,
  tool: "bash",
  status: "blocking",
  count: 3,
  sessions: ["seA", "seB"],
  projects: [],
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
  snippet: "se-cleanup-tool: command not found",
  remindedSessions: { seC: Date.now(), seD: Date.now() },
  failedSessions: { seC: Date.now(), seD: Date.now() },
}
await mkdir(join(se.storeDir, ".opencode", "dejavu"), { recursive: true })
await writeFile(join(se.storeDir, ".opencode", "dejavu", "gates.json"), JSON.stringify({ version: 1, gates: [seGate] }), "utf8")

const sessionEnd = runCli(
  "session-event",
  "claude",
  { hook_event_name: "SessionEnd", session_id: "seC", cwd: se.storeDir, transcript_path: "/tmp/t.jsonl", reason: "clear" },
  se.storeDir,
  se.globalDir,
)
check("claude SessionEnd → exit 0 (allow decision)", sessionEnd.exitCode === 0)
check("claude SessionEnd → stdout stays pure JSON {}", sessionEnd.stdout.trim() === "{}")

interface SeGateRow {
  signature?: string
  sessions?: string[]
  remindedSessions?: Record<string, number>
  failedSessions?: Record<string, number>
}
const seGates = (JSON.parse(await readFile(join(se.storeDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { gates: SeGateRow[] }).gates
const seGateAfter = seGates.find((g) => g.signature === SE_SIG)
check("SessionEnd wipes the ended session from remindedSessions", seGateAfter?.remindedSessions?.seC === undefined)
check("SessionEnd wipes the ended session from failedSessions", seGateAfter?.failedSessions?.seC === undefined)
check("SessionEnd keeps other sessions' enforcement state", seGateAfter?.remindedSessions?.seD !== undefined && seGateAfter?.failedSessions?.seD !== undefined)
check("SessionEnd leaves the gate and its session evidence in place", seGateAfter !== undefined && (seGateAfter.sessions?.length ?? 0) === 2)

const seLogPath = join(se.storeDir, ".opencode", "dejavu", "log.jsonl")
const seLog = existsSync(seLogPath) ? await readFile(seLogPath, "utf8") : ""
check("SessionEnd records no failure (no detected event)", !seLog.includes('"detected"'))

const sessionEndNoSession = runCli("session-event", "claude", { hook_event_name: "SessionEnd" }, se.storeDir, se.globalDir)
check("SessionEnd without session_id → {} exit 0 (fail-open)", sessionEndNoSession.exitCode === 0 && sessionEndNoSession.stdout.trim() === "{}")
const sessionEndGarbage = runCli("session-event", "claude", 42, se.storeDir, se.globalDir)
check("garbage session-event payload → {} exit 0 (fail-open)", sessionEndGarbage.exitCode === 0 && sessionEndGarbage.stdout.trim() === "{}")

// --- usage error: missing --harness → exit 1 (distinct from allow/block) ---
const noHarness = spawnSync("bun", [cliPath, "pre"], { input: "{}", env: { ...process.env, DEJAVU_HOME: block.globalDir }, cwd: repoRoot, encoding: "utf8" })
check("missing --harness → exit 1 + usage on stderr", (noHarness.status ?? 0) === 1 && (noHarness.stderr ?? "").includes("usage"))

// --- formatStdout: stdoutRaw replaces the decision JSON verbatim ---
const defaultDecision: OutboundDecision = { json: {}, exitCode: 0, stderr: null }
check("formatStdout default (no stdoutRaw) → \"{}\\n\"", formatStdout(defaultDecision) === "{}\n")

const denyDecision: OutboundDecision = { json: { permission: "deny" }, exitCode: 2, stderr: "blocked" }
check("formatStdout deny → JSON with trailing newline", formatStdout(denyDecision) === '{"permission":"deny"}\n')

const rawEmpty: OutboundDecision = { json: {}, exitCode: 0, stderr: null, stdoutRaw: "" }
check("formatStdout stdoutRaw=\"\" → empty string (Kiro allow writes nothing)", formatStdout(rawEmpty) === "")

const rawNull: OutboundDecision = { json: {}, exitCode: 0, stderr: null, stdoutRaw: null }
check("formatStdout stdoutRaw=null falls through to JSON path", formatStdout(rawNull) === "{}\n")

const rawValue: OutboundDecision = { json: {}, exitCode: 0, stderr: null, stdoutRaw: "CUSTOM_DECISION_PAYLOAD" }
check("formatStdout stdoutRaw set → verbatim raw", formatStdout(rawValue) === "CUSTOM_DECISION_PAYLOAD")

const rawWithNewline: OutboundDecision = { json: {}, exitCode: 0, stderr: null, stdoutRaw: "payload\n" }
check("formatStdout stdoutRaw carries its own trailing newline verbatim", formatStdout(rawWithNewline) === "payload\n")

const rawDeny: OutboundDecision = { json: {}, exitCode: 2, stderr: "denied", stdoutRaw: "RAW_DENY" }
check("formatStdout stdoutRaw + deny → raw payload (exitCode/stderr unchanged)", formatStdout(rawDeny) === "RAW_DENY")

// --- cross-process iteration grace: a landed edit in a separate CLI process re-opens the retry ---
const grace = await makeWorld("cross-process-grace")
const graceCmd = "grace-tool --deploy"
const graceSig = callSignature("bash", { command: graceCmd }) ?? ""
const graceKey = patternKey(graceSig)
const graceSession = "grace-live"
const graceStoreDir = join(grace.storeDir, ".opencode", "dejavu")
await mkdir(graceStoreDir, { recursive: true })
await writeFile(
  join(graceStoreDir, "gates.json"),
  JSON.stringify({
    version: 1,
    gates: [
      {
        key: graceKey,
        signature: graceSig,
        tool: "bash",
        status: "blocking",
        count: 3,
        sessions: [graceSession, "grace-seed"],
        projects: [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        snippet: "grace-tool: command not found",
        remindedSessions: { [graceSession]: Date.now() - 6000 },
        failedSessions: { [graceSession]: { t: Date.now() - 5000, v: 0 } },
      },
    ],
  }),
  "utf8",
)

const graceEdit = runCli(
  "post",
  "claude",
  { hook_event_name: "PostToolUse", session_id: graceSession, tool_name: "Edit", tool_input: { filePath: join(grace.storeDir, "src", "x.ts") }, tool_use_id: "tu-grace-edit", cwd: grace.storeDir, tool_response: { stdout: "ok", stderr: "" } },
  grace.storeDir,
  grace.globalDir,
)
check("a successful edit post exits 0", graceEdit.exitCode === 0)
check("the edit heartbeat sidecar was written to the project store", existsSync(join(graceStoreDir, "edit-heartbeat")))

const gracePre = runCli(
  "pre",
  "claude",
  { hook_event_name: "PreToolUse", session_id: graceSession, tool_name: "Bash", tool_input: { command: graceCmd }, tool_use_id: "tu-grace-pre", cwd: grace.storeDir },
  grace.storeDir,
  grace.globalDir,
)
check("cross-process grace allows the gated retry after an edit landed in another process", gracePre.exitCode === 0 && !gracePre.stderr.includes("[dejavu] BLOCKED"))

// --- D1: project root canonicalizes to the git root, one repo at two depths shares one store ---
const gitRoot = join(root, "git-root")
const gitNested = join(gitRoot, "packages", "app")
await mkdir(gitNested, { recursive: true })
spawnSync("git", ["init"], { cwd: gitRoot, encoding: "utf8" })
const gitRootGlobal = join(root, "git-root-global")
const rootCmd = "gitroot-tool --deploy"
const rootOut = "gitroot-tool: command not found"
function gitCli(phase: string, session: string, cwd: string): CliResult {
  const payload =
    phase === "post"
      ? { hook_event_name: "PostToolUse", session_id: session, tool_name: "Bash", tool_input: { command: rootCmd }, tool_use_id: `tu-${session}-post`, cwd, tool_response: { stdout: "", stderr: rootOut } }
      : { hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: rootCmd }, tool_use_id: `tu-${session}-pre`, cwd }
  return runCliNoStore(phase, "claude", payload, cwd, gitRootGlobal)
}
gitCli("post", "d1-a", gitNested)
gitCli("post", "d1-a", gitNested)
gitCli("post", "d1-b", gitNested)
check("D1: a gate learned in a nested dir lands in the git-root store", existsSync(join(gitRoot, ".opencode", "dejavu", "gates.json")))
check("D1: no store is created at the nested dir", !existsSync(join(gitNested, ".opencode", "dejavu", "gates.json")))
const d1Pre = gitCli("pre", "d1-live", gitRoot)
check("D1: the gate learned at one cwd fires from the repo root", d1Pre.exitCode === 2 && d1Pre.stderr.includes("[dejavu]"))

report()
