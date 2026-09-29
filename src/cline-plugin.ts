import { extractOutput, internalArgs, internalTool, rec, str, UNKNOWN_SESSION } from "./adapters/shared"
import { createEphemeralState, enforceAfter, enforceBefore, type EnforceContext } from "./enforce"
import { createStores, GLOBAL_PROJECTS, NOISE_TTL_DAYS, PLUGIN_VERSION, TTL_DAYS } from "./store"
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

/** how often a long-lived process re-runs expiry */
const TTL_INTERVAL_MS = 6 * 60 * 60 * 1000
const HOOK_ERROR_LOG_INTERVAL_MS = 60_000

// the Cline plugin sandbox subprocess runs with cwd = the project directory
const projectDir = process.cwd()
const stores = createStores(projectDir)
const ephemeral = createEphemeralState()

const debugEnv = process.env.DEJAVU_DEBUG
const debug = debugEnv !== undefined && debugEnv !== "" && debugEnv !== "0"
const log = (service: string, level: string, message: string): void => {
  if (level !== "debug" || debug) {
    process.stderr.write(`[dejavu] ${service} (${level}): ${message}\n`)
  }
}

let lastHookErrorLogMs = 0
const onHookError = (where: string, error: unknown): void => {
  const now = Date.now()
  if (now - lastHookErrorLogMs < HOOK_ERROR_LOG_INTERVAL_MS) return
  lastHookErrorLogMs = now
  process.stderr.write(`[dejavu] ${where} hook error: ${error instanceof Error ? error.message : String(error)}\n`)
}

const enforceCtx: EnforceContext = {
  stores,
  ephemeral,
  log,
  onHookError,
  platform: process.platform,
  projectDir,
}

// long-lived host: init once at module load; hooks await it before enforcing
const initPromise = (async (): Promise<void> => {
  try {
    await stores.reconcileAll(GLOBAL_PROJECTS)
    await stores.migrate()
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
    await stores.rotateLogs()
    await stores.logAll({ type: "init", key: "dejavu", version: PLUGIN_VERSION })
    const enforced = await stores.enforcedGates()
    const notTeaching = enforced.filter((g) => g.recurredAfterGate >= 3).length
    const review = enforced.filter((g) => g.review === true).length
    if (notTeaching > 0 || review > 0) {
      await stores.logAll({ type: "health", key: "dejavu", snippet: `not-teaching ${notTeaching}, review ${review}` })
    }
    log("dejavu", "info", `dejavu initialized v${PLUGIN_VERSION}`)
  } catch (error) {
    // init failures must not prevent hook registration — but must be visible
    log("dejavu", "error", `dejavu init failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})()

// jittered sweep; the sandbox idle-reclaim is the cleanup, so no dispose export
const scheduleTtl = (): void => {
  const jitter = TTL_INTERVAL_MS * (0.75 + Math.random() * 0.5)
  const timer = setTimeout(async () => {
    try {
      await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
      await stores.rotateLogs()
      await stores.flushDeferredAll()
    } catch {
      // sweep failures must not stop the timer
    }
    scheduleTtl()
  }, jitter)
  ;(timer as { unref?: () => void }).unref?.()
}
scheduleTtl()

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
    const event: NormalizedEvent = {
      harness: "cline",
      phase: "post",
      tool,
      args: internalArgs(tool, rec(context.toolCall, "input") ?? rec(context, "input") ?? {}),
      sessionId: str(context.snapshot, "conversationId") ?? UNKNOWN_SESSION,
      callId: str(context.toolCall, "toolCallId"),
      cwd: projectDir,
      output: result === null ? null : extractOutput(result.output),
      exitCode: null,
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
