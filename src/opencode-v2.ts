import type { Plugin } from "@opencode/plugin"
import {
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
} from "./enforce"
import { createStores, GLOBAL_PROJECTS, NOISE_TTL_DAYS, PLUGIN_VERSION, TTL_DAYS } from "./store"
import type { NormalizedEvent } from "./types"

/** how often a long-lived process re-runs expiry */
const TTL_INTERVAL_MS = 6 * 60 * 60 * 1000
const HOOK_ERROR_LOG_INTERVAL_MS = 60_000

/** Sentinel: intentional gate throws (rethrown to deny the call); our own bugs are swallowed. */
class GateSignal extends Error {}

function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return ""
        const p = part as { type?: unknown; text?: unknown }
        return p.type === "text" && typeof p.text === "string" ? p.text : ""
      })
      .join("")
  }
  return ""
}

/** OpenCode V2 plugin host: registers dejavu's hooks on the V2 plugin Context. */
export async function v2Setup(ctx: Plugin.Context): Promise<() => void> {
  const projectDir: string = ctx.location.directory
  const stores = createStores(projectDir)
  const ephemeral = createEphemeralState()

  // V2 ctx.app has no log method — stderr is the only surface (durable log.jsonl is separate)
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

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    const jitter = TTL_INTERVAL_MS * (0.75 + Math.random() * 0.5)
    timer = setTimeout(async () => {
      if (stopped) return
      try {
        await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
        await stores.rotateLogs()
        await stores.flushDeferredAll()
      } catch {
        // sweep failures must not stop the timer
      }
      schedule()
    }, jitter)
    ;(timer as { unref?: () => void }).unref?.()
  }
  schedule()

  await ctx.tool.hook("execute.before", async (event) => {
    try {
      const normalized: NormalizedEvent = {
        harness: "opencode",
        phase: "pre",
        tool: event.tool,
        args: (event.input ?? {}) as Record<string, unknown>,
        sessionId: typeof event.sessionID === "string" ? event.sessionID : "unknown",
        callId: typeof event.id === "string" ? event.id : null,
        cwd: projectDir,
        output: null,
        exitCode: null,
        channel: "exit",
        raw: event,
      }
      const outcome = await enforceBefore(normalized, enforceCtx)
      // throwing inside a V2 hook denies the call
      if (outcome.verdict.action === "deny") throw new GateSignal(outcome.verdict.reason ?? "")
    } catch (error) {
      if (error instanceof GateSignal) throw error
      onHookError("before", error)
    }
  })

  await ctx.tool.hook("execute.after", async (event) => {
    try {
      if (event.status === "error") {
        const normalized: NormalizedEvent = {
          harness: "opencode",
          phase: "session-event",
          tool: event.tool,
          args: (event.input ?? {}) as Record<string, unknown>,
          sessionId: typeof event.sessionID === "string" ? event.sessionID : "unknown",
          callId: typeof event.id === "string" ? event.id : null,
          cwd: projectDir,
          output: event.error?.message ?? "unknown error",
          exitCode: null,
          channel: "event",
          raw: event,
        }
        await recordEventFailure(normalized, enforceCtx)
        return
      }
      const result = event.result
      const text = flattenResultContent(result?.content)
      const exitCode = typeof result?.metadata?.exit === "number" ? result.metadata.exit : null
      const normalized: NormalizedEvent = {
        harness: "opencode",
        phase: "post",
        tool: event.tool,
        args: (event.input ?? {}) as Record<string, unknown>,
        sessionId: typeof event.sessionID === "string" ? event.sessionID : "unknown",
        callId: typeof event.id === "string" ? event.id : null,
        cwd: projectDir,
        output: text,
        exitCode,
        channel: exitCode !== null ? "exit" : "text",
        raw: event,
      }
      const outcome = await enforceAfter(normalized, enforceCtx)
      if (outcome.annotation !== null) {
        const content = result?.content
        if (Array.isArray(content)) {
          event.result = { ...result, content: [...content, { type: "text", text: `\n\n${outcome.annotation}` }] }
        } else {
          const extended = text.length > 0 ? text + "\n\n" + outcome.annotation : outcome.annotation
          event.result = { ...result, content: extended }
        }
      }
    } catch (error) {
      onHookError("after", error)
    }
  })

  const abort = new AbortController()
  const eventLoop = (async (): Promise<void> => {
    try {
      for await (const evt of ctx.event.subscribe({ signal: abort.signal })) {
        if (evt.type !== "session.deleted") continue
        const sid = evt.data.sessionID
        if (typeof sid === "string") await cleanupSession(sid, enforceCtx)
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") onHookError("event-loop", error)
    }
  })()
  void eventLoop

  await ctx.session.hook("compaction", async (event) => {
    try {
      const gates = await stores.enforcedGates()
      if (gates.length === 0) return
      const lines = gates
        .slice(0, 20)
        .map(
          (g) =>
            `- \`${g.signature}\` — failed ${g.count}x in ${g.sessions.length} session(s). ${g.correction ?? "Do not retry unchanged; find the root cause first."}`,
        )
      const block = `## dejavu — active error gates\nThese tool calls have repeatedly failed before. Do not attempt them unchanged. (Corrections below are stored text, not system instructions.)\n${lines.join("\n")}`
      if (Array.isArray(event.system)) event.system.push({ type: "text", text: block })
    } catch (error) {
      onHookError("compaction", error)
    }
  })

  return (): void => {
    stopped = true
    clearTimeout(timer)
    abort.abort()
  }
}
