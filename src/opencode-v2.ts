import type { Plugin } from "@opencode/plugin"
import {
  applyRepeatChannel,
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
  type RepeatChannelMessage,
  type RepeatChannelPart,
  type RepeatChannelState,
} from "./enforce"
import { createStores } from "./store"
import { initStores, rateLimitedErrorSink, scheduleSweep } from "./host-init"
import { genericToolOutput } from "./adapters/shared"
import type { NormalizedEvent } from "./types"

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

/** V2 renames the bash tool to "shell"; the engine vocabulary stays harness-neutral */
const ENGINE_TOOL: Record<string, string> = { shell: "bash" }

function engineTool(tool: string): string {
  return ENGINE_TOOL[tool] ?? tool
}

// --- V2 canonical → repeat-channel structural view ---------------------------

/** V2 canonical form: tool calls live in assistant messages, results in
 *  follow-up tool-role messages — the view merges them so the engine sees
 *  V1-shaped rounds. */
interface V2ContentPart {
  type: string
  id?: string
  name?: string
  input?: unknown
  result?: { type: string; value: unknown }
}

interface V2Message {
  role: string
  content: V2ContentPart[]
}

function resultOutputText(result: { type: string; value: unknown }): string | undefined {
  if (result.type === "text" && typeof result.value === "string") return result.value
  if (result.type === "content" && Array.isArray(result.value)) {
    return result.value
      .map((item) =>
        typeof item === "object" && item !== null && (item as { type?: string }).type === "text"
          ? (item as { text?: unknown }).text
          : "",
      )
      .filter((text): text is string => typeof text === "string")
      .join("")
  }
  return undefined
}

function resultErrorText(result: { type: string; value: unknown }): string | undefined {
  if (result.type !== "error") return undefined
  if (typeof result.value === "string") return result.value
  if (typeof result.value === "object" && result.value !== null) {
    const message = (result.value as { error?: { message?: unknown } }).error?.message
    if (typeof message === "string") return message
  }
  return undefined
}

function toolPartView(call: V2ContentPart, result: { type: string; value: unknown } | undefined): RepeatChannelPart {
  const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : undefined
  const state: RepeatChannelState = {
    input,
    get status(): string | undefined {
      if (result === undefined) return undefined
      return result.type === "error" ? "error" : "completed"
    },
    get output(): string | undefined {
      return result === undefined ? undefined : resultOutputText(result)
    },
    set output(value: string) {
      if (result === undefined) return
      if (result.type === "text") {
        result.value = value
        return
      }
      if (result.type === "content" && Array.isArray(result.value)) {
        const previous = resultOutputText(result) ?? ""
        result.value = value.startsWith(previous)
          ? [...result.value, { type: "text", text: value.slice(previous.length) }]
          : [{ type: "text", text: value }]
      }
    },
    get error(): string | undefined {
      return result === undefined ? undefined : resultErrorText(result)
    },
    set error(value: string) {
      if (result === undefined || result.type !== "error") return
      if (typeof result.value === "string") {
        result.value = value
        return
      }
      if (typeof result.value === "object" && result.value !== null) {
        const error = (result.value as { error?: { message?: string } }).error
        if (typeof error === "object" && error !== null) error.message = value
      }
    },
  }
  return { type: "tool", tool: typeof call.name === "string" ? call.name : undefined, state }
}

function toRepeatChannelMessages(messages: unknown, sessionID: string): RepeatChannelMessage[] {
  const v2 = (Array.isArray(messages) ? messages : []) as V2Message[]
  const resultsById = new Map<string, { type: string; value: unknown }>()
  for (const msg of v2) {
    if (msg.role !== "tool") continue
    for (const part of msg.content) {
      if (part.type === "tool-result" && typeof part.id === "string" && part.result != null) resultsById.set(part.id, part.result)
    }
  }
  const structural: RepeatChannelMessage[] = []
  for (const msg of v2) {
    if (msg.role === "tool") continue
    const parts: RepeatChannelPart[] = []
    for (const part of msg.content) {
      if (part.type !== "tool-call") continue
      parts.push(toolPartView(part, typeof part.id === "string" ? resultsById.get(part.id) : undefined))
    }
    structural.push({ info: { role: msg.role, sessionID }, parts })
  }
  return structural
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

  const onHookError = rateLimitedErrorSink((line) => process.stderr.write(`[dejavu] ${line}\n`))

  const enforceCtx: EnforceContext = {
    stores,
    ephemeral,
    log,
    onHookError,
    platform: process.platform,
    projectDir,
  }

  await initStores(stores, {
    logInitEvent: true,
    rotateLogs: true,
    healthLog: true,
    log: (level, message) => log("dejavu", level, `dejavu ${message}`),
  })

  const stopSweep = scheduleSweep(stores)

  await ctx.tool.hook("execute.before", async (event) => {
    try {
      const normalized: NormalizedEvent = {
        harness: "opencode",
        phase: "pre",
        tool: engineTool(event.tool),
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
          tool: engineTool(event.tool),
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
        tool: engineTool(event.tool),
        args: (event.input ?? {}) as Record<string, unknown>,
        sessionId: typeof event.sessionID === "string" ? event.sessionID : "unknown",
        callId: typeof event.id === "string" ? event.id : null,
        cwd: projectDir,
        output: genericToolOutput(engineTool(event.tool), text, false),
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

  // the V2 transform equivalent: the generate hook carries the outgoing payload with mutable messages
  await ctx.session.hook("generate", async (event) => {
    try {
      const structural = toRepeatChannelMessages(event.messages, event.sessionID)
      const result = await applyRepeatChannel(structural, enforceCtx)
      for (const injection of result.injected) {
        const synthetic = { role: "user", content: [{ type: "text", text: injection.text }], metadata: { synthetic: true } }
        event.messages.push(synthetic as unknown as (typeof event.messages)[number])
      }
    } catch (error) {
      onHookError("generate", error)
    }
  })

  return (): void => {
    stopSweep()
    abort.abort()
  }
}
