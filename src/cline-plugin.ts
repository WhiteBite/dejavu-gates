import { errorSignalled, extractOutput, genericToolOutput, internalArgs, internalTool, rec, str, UNKNOWN_SESSION } from "./adapters/shared"
import { createEphemeralState, enforceAfter, enforceBefore, type EnforceContext } from "./enforce"
import { initStores, rateLimitedErrorSink, scheduleSweep } from "./host-init"
import { createStores } from "./store"
import { findProjectRoot } from "./fs"
import type { NormalizedEvent } from "./types"

/** Narrow structural mirror of the Cline hook context (@cline/shared agent.ts) — no SDK dependency. */
interface ClineHookContext {
  snapshot?: unknown
  tool?: unknown
  toolCall?: unknown
  input?: unknown
}

interface ClineAfterContext extends ClineHookContext {
  result?: unknown
}

interface ClineBeforeResult {
  skip?: boolean
  reason?: string
}

interface ClineAfterResult {
  appendContext?: string
}

// the Cline plugin sandbox subprocess runs with cwd = the project directory
const projectDir = findProjectRoot(process.cwd())
const stores = createStores(projectDir)
const ephemeral = createEphemeralState()

const debugEnv = process.env.DEJAVU_DEBUG
const debug = debugEnv !== undefined && debugEnv !== "" && debugEnv !== "0"
const log = (service: string, level: string, message: string): void => {
  if (level !== "debug" || debug) {
    process.stderr.write(`[dejavu] ${service} (${level}): ${message}\n`)
  }
}

const onHookError = rateLimitedErrorSink((line) => process.stderr.write(`[dejavu] ${line}\n`))

const enforceCtx: EnforceContext = {
  stores,
  ephemeral,
  log,
  onHookError,
  platform: process.platform,
  projectDir,
  iteratedVersionSupported: true,
}

// long-lived host: init once at module load; hooks await it before enforcing
const initPromise = initStores(stores, {
  logInitEvent: true,
  rotateLogs: true,
  healthLog: true,
  log: (level, message) => log("dejavu", level, `dejavu ${message}`),
})

// jittered sweep; the sandbox idle-reclaim is the cleanup, so no dispose export
void scheduleSweep(stores)

const beforeTool = async (context: ClineHookContext): Promise<ClineBeforeResult | undefined> => {
  try {
    await initPromise
    const toolName = str(context.toolCall, "toolName") ?? str(context.tool, "name")
    if (toolName === null) return undefined
    const tool = internalTool("cline", toolName)
    const event: NormalizedEvent = {
      harness: "cline",
      phase: "pre",
      tool,
      args: internalArgs(tool, rec(context.toolCall, "input") ?? rec(context, "input") ?? {}),
      sessionId: str(context.snapshot, "conversationId") ?? UNKNOWN_SESSION,
      callId: str(context.toolCall, "toolCallId"),
      cwd: projectDir,
      output: null,
      exitCode: null,
      channel: "exit",
      raw: context,
    }
    const outcome = await enforceBefore(event, enforceCtx)
    if (outcome.verdict.action === "deny") return { skip: true, reason: outcome.verdict.reason ?? "[dejavu] BLOCKED" }
    return undefined
  } catch (error) {
    onHookError("before", error)
    return undefined
  }
}

const afterTool = async (context: ClineAfterContext): Promise<ClineAfterResult | undefined> => {
  try {
    await initPromise
    const toolName = str(context.toolCall, "toolName") ?? str(context.tool, "name")
    if (toolName === null) return undefined
    const tool = internalTool("cline", toolName)
    const result = rec(context, "result")
    const errored = result !== null && errorSignalled(result, result)
    const event: NormalizedEvent = {
      harness: "cline",
      phase: "post",
      tool,
      args: internalArgs(tool, rec(context.toolCall, "input") ?? rec(context, "input") ?? {}),
      sessionId: str(context.snapshot, "conversationId") ?? UNKNOWN_SESSION,
      callId: str(context.toolCall, "toolCallId"),
      cwd: projectDir,
      output: result === null ? null : genericToolOutput(tool, extractOutput(result.output), errored),
      exitCode: null,
      errored,
      channel: "text",
      raw: context,
    }
    const outcome = await enforceAfter(event, enforceCtx)
    if (outcome.annotation !== null) return { appendContext: outcome.annotation }
    return undefined
  } catch (error) {
    onHookError("after", error)
    return undefined
  }
}

/**
 * dejavu error gates — Cline plugin entry. Cline SDK / CLI / Kanban hosts only:
 * the VS Code extension and JetBrains plugin have no plugin-hook surface.
 * The loader sandbox runs with cwd = the project dir and reclaims the
 * subprocess after ~30 min idle. Hook payloads carry no exit codes (isError
 * only), so failure detection is text-channel only — same as the hook CLI.
 */
export default {
  name: "dejavu-gates",
  hooks: { beforeTool, afterTool },
}
