/**
 * End-to-end CLI suite: spawns `bun src/cli.ts` per hook event over a temp
 * store and asserts the harness decision on stdout/stderr/exit-code, plus the
 * promoted-gate artifact on disk. Run: bun test/cli.ts
 */
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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
    default:
      return {}
  }
}

// exit-2 dialect harnesses (block via stderr)
for (const h of ["claude", "codex", "gemini"] as const) {
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

// --- fail-open: malformed stdin never blocks the user's tool call ---
const malformed = runCli("pre", "claude", "{not valid json", block.storeDir, block.globalDir)
check("malformed stdin → exit 0 + {} (fail-open)", malformed.exitCode === 0 && malformed.stdout.trim() === "{}")

// --- usage error: missing --harness → exit 1 (distinct from allow/block) ---
const noHarness = spawnSync("bun", [cliPath, "pre"], { input: "{}", env: { ...process.env, DEJAVU_HOME: block.globalDir }, cwd: repoRoot, encoding: "utf8" })
check("missing --harness → exit 1 + usage on stderr", (noHarness.status ?? 0) === 1 && (noHarness.stderr ?? "").includes("usage"))

report()
