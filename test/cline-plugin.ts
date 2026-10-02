/**
 * Characterization test for the Cline plugin host (src/cline-plugin.ts).
 * Run: bun test/cline-plugin.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

const tmp = await mkdtemp(join(tmpdir(), "dejavu-cline-"))
const projectDir = join(tmp, "project")
await mkdir(projectDir, { recursive: true })
process.env.DEJAVU_HOME = join(tmp, "global")
// the plugin resolves projectDir from process.cwd() at module load, like the sandbox does
const prevCwd = process.cwd()
process.chdir(projectDir)

interface BeforeResult {
  skip?: boolean
  reason?: string
}
interface AfterResult {
  appendContext?: string
}

try {
  const plugin = (await import("../src/cline-plugin")).default

  check("plugin name is dejavu-gates", plugin.name === "dejavu-gates")
  check("beforeTool hook is a function", typeof plugin.hooks.beforeTool === "function")
  check("afterTool hook is a function", typeof plugin.hooks.afterTool === "function")

  const beforeTool = plugin.hooks.beforeTool
  const afterTool = plugin.hooks.afterTool

  const ctx = (session: string, call: string, toolName: string, input: unknown): unknown => ({
    snapshot: { conversationId: session },
    tool: { name: toolName },
    toolCall: { toolCallId: call, toolName, input },
    input,
  })
  const post = (session: string, call: string, toolName: string, input: unknown, output: unknown): unknown => ({
    ...(ctx(session, call, toolName, input) as Record<string, unknown>),
    result: { output, isError: true },
    startedAt: 0,
    endedAt: 1,
    durationMs: 1,
  })

  const fresh = (await beforeTool(ctx("s0", "c0", "execute_command", { command: "echo hi" }) as never)) as BeforeResult | undefined
  check("beforeTool on a fresh store allows the call", fresh === undefined)

  const blockCmd = "cline-deploy --prod"
  const boom = "Error: cline-deploy exploded\n"
  await afterTool(post("s1", "c1", "execute_command", { command: blockCmd }, boom) as never)
  await afterTool(post("s1", "c2", "execute_command", { command: blockCmd }, boom) as never)
  await afterTool(post("s2", "c3", "execute_command", { command: blockCmd }, boom) as never)
  const denied = (await beforeTool(ctx("s3", "c4", "execute_command", { command: blockCmd }) as never)) as BeforeResult | undefined
  check("three failures across two sessions make beforeTool skip the call", denied?.skip === true)
  check("the skip reason carries the [dejavu] prefix", (denied?.reason ?? "").includes("[dejavu]"))

  const grepCmd = "grep needle src/haystack.ts"
  await afterTool(post("s1", "c5", "execute_command", { command: grepCmd }, boom) as never)
  await afterTool(post("s1", "c6", "execute_command", { command: grepCmd }, boom) as never)
  await afterTool(post("s2", "c7", "execute_command", { command: grepCmd }, boom) as never)
  const noted = (await afterTool(post("s3", "c8", "execute_command", { command: grepCmd }, boom) as never)) as AfterResult | undefined
  check("a reminding gate annotates the failing output", (noted?.appendContext ?? "").includes("[dejavu] NOTE"))

  const graceCmd = "cline-grace-tool --run"
  const graceBoom = "Error: grace exploded\n"
  await afterTool(post("g1", "gc1", "execute_command", { command: graceCmd }, graceBoom) as never)
  await afterTool(post("g1", "gc2", "execute_command", { command: graceCmd }, graceBoom) as never)
  await afterTool(post("g2", "gc3", "execute_command", { command: graceCmd }, graceBoom) as never)
  await beforeTool(ctx("g3", "gc4", "execute_command", { command: graceCmd }) as never)
  await afterTool(post("g3", "gc5", "execute_command", { command: graceCmd }, graceBoom) as never)
  await afterTool(post("g3", "gc6", "write_to_file", { path: "src/x.ts", content: "x" }, "Error: write failed") as never)
  const stillBlocked = (await beforeTool(ctx("g3", "gc7", "execute_command", { command: graceCmd }) as never)) as BeforeResult | undefined
  check("a failed cline edit does not lift the block (errored wiring)", stillBlocked?.skip === true)

  const ok = (await afterTool(post("s3", "c9", "execute_command", { command: "echo hi" }, "hi\n") as never)) as AfterResult | undefined
  check("afterTool on a successful call returns undefined", ok === undefined)

  const unknownTool = (await beforeTool(ctx("s3", "c10", "some_mcp_tool", { query: "x" }) as never)) as BeforeResult | undefined
  check("beforeTool with an unrecognized tool name allows without crashing", unknownTool === undefined)

  let threw = false
  try {
    await beforeTool({} as never)
    await afterTool({} as never)
    await beforeTool({ toolCall: null } as never)
    await afterTool({ result: null } as never)
  } catch {
    threw = true
  }
  check("minimal non-conforming contexts never throw", !threw)
} finally {
  process.chdir(prevCwd)
  await rm(tmp, { recursive: true, force: true })
}

report()
