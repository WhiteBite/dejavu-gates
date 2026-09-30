import type { Plugin } from "@opencode-ai/plugin"
import { detectRepeatSeries, detectRepeatWindows, looksLikeFailure, parameterizeError, REPEAT_MARKER } from "./src/patterns"
import {
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
} from "./src/enforce"
import { genericToolOutput } from "./src/adapters/shared"
import { createStores, GLOBAL_PROJECTS, NOISE_TTL_DAYS, PLUGIN_VERSION, TTL_DAYS } from "./src/store"
import type { NormalizedEvent } from "./src/types"
import { v2Setup } from "./src/opencode-v2"

// --- Tunables ---------------------------------------------------------------

/** how often a long-lived process re-runs expiry */
const TTL_INTERVAL_MS = 6 * 60 * 60 * 1000
/** repeat channel: consecutive identical rounds reaching the tail earn a NOTE on the last tool result */
const REPEAT_REMIND_AT = 2
/** repeat channel: per-session tail-series map cap (in-process; a stuck loop must not grow it) */
const REPEAT_SESSIONS_CAP = 1000
/** repeat channel: a key this frequent within the last REPEAT_WINDOW_ROUNDS assistant rounds earns a NOTE */
const REPEAT_WINDOW_MIN = 3
const REPEAT_WINDOW_ROUNDS = 12

/** Sentinel: intentional gate/reminder throws (rethrown); our own bugs are swallowed. */
class GateSignal extends Error {}

export const Dejavu: Plugin = async ({ directory, client }) => {
  const projectDir = typeof directory === "string" ? directory : ""
  const stores = createStores(projectDir)
  const cwd = typeof directory === "string" ? directory : null

  const logClient = async (level: "debug" | "info" | "warn" | "error", message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: "dejavu", level, message } })
    } catch {
      // logging must never break the plugin
    }
  }

  // Hook bugs are swallowed to protect the tool pipeline — but a silently
  // dead plugin is invisible. Surface at most one error per minute.
  const HOOK_ERROR_LOG_INTERVAL_MS = 60_000
  let lastHookErrorLogMs = 0
  const logHookError = (where: string, error: unknown): void => {
    const now = Date.now()
    if (now - lastHookErrorLogMs < HOOK_ERROR_LOG_INTERVAL_MS) return
    lastHookErrorLogMs = now
    logClient("error", `dejavu: ${where} hook error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {})
  }

  // one ephemeral instance per process — the transform hook writes the repeat state the before-hook reads
  const ephemeral = createEphemeralState()
  const repeatSeries = ephemeral.repeatSeries
  const repeatWindowLogged = ephemeral.repeatWindowLogged
  const ctx: EnforceContext = {
    stores,
    ephemeral,
    log: (_service, level, message) => logClient(level as "debug" | "info" | "warn" | "error", message),
    onHookError: logHookError,
    platform: process.platform,
    projectDir,
  }

  try {
    await stores.reconcileAll(GLOBAL_PROJECTS)
    await stores.migrate()
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
    await stores.rotateLogs()
    await stores.logAll({ type: "init", key: "dejavu", version: PLUGIN_VERSION })
    // Surface non-automatable gate health (NOT TEACHING / review) to the durable log instead of letting it accumulate silently.
    const enforced = await stores.enforcedGates()
    const notTeaching = enforced.filter((g) => g.recurredAfterGate >= 3).length
    const review = enforced.filter((g) => g.review === true).length
    if (notTeaching > 0 || review > 0) {
      await stores.logAll({ type: "health", key: "dejavu", snippet: `not-teaching ${notTeaching}, review ${review}` })
    }
    await logClient("info", `dejavu initialized v${PLUGIN_VERSION}`)
  } catch (error) {
    // init failures must not prevent hook registration — but must be visible,
    // otherwise a corrupted store silently starts the plugin with no gates
    await logClient("error", `dejavu init failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // jittered sweep: simultaneous windows must not expire/rotate the shared global store in sync
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

  return {
    "tool.execute.before": async (input, output) => {
      try {
        // args is the LIVE object — the engine strips repeat markers from it
        const event: NormalizedEvent = {
          harness: "opencode",
          phase: "pre",
          tool: input.tool,
          args: (output?.args ?? {}) as Record<string, unknown>,
          sessionId: typeof input.sessionID === "string" ? input.sessionID : "unknown",
          callId: typeof input.callID === "string" ? input.callID : null,
          cwd,
          output: null,
          exitCode: null,
          channel: "exit",
          raw: input,
        }
        const outcome = await enforceBefore(event, ctx)
        if (outcome.verdict.action === "deny") throw new GateSignal(outcome.verdict.reason ?? "")
      } catch (error) {
        if (error instanceof GateSignal) throw error
        // our own bugs must never break the user's tool calls — but stay visible
        logHookError("before", error)
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        // failed bash calls arrive as successful executions with metadata.exit !== 0
        const metadata = (output?.metadata ?? {}) as { exit?: unknown }
        const exitCode = typeof metadata.exit === "number" ? metadata.exit : null
        const event: NormalizedEvent = {
          harness: "opencode",
          phase: "post",
          tool: input.tool,
          args: ((input as { args?: unknown }).args ?? {}) as Record<string, unknown>,
          sessionId: typeof input.sessionID === "string" ? input.sessionID : "unknown",
          callId: typeof input.callID === "string" ? input.callID : null,
          cwd,
          output: genericToolOutput(input.tool, typeof output?.output === "string" ? output.output : "", false),
          exitCode,
          channel: exitCode !== null ? "exit" : "text",
          raw: input,
        }
        const outcome = await enforceAfter(event, ctx)
        if (outcome.annotation !== null && typeof output?.output === "string") {
          output.output = output.output + "\n\n" + outcome.annotation
        }
      } catch (error) {
        // detection failures must never break the tool pipeline — but stay visible
        logHookError("after", error)
      }
    },

    event: async ({ event }) => {
      try {
        const type = (event as { type?: unknown }).type

        if (type === "session.deleted") {
          const props = (event as { properties?: unknown }).properties as { sessionID?: unknown } | undefined
          if (typeof props?.sessionID === "string") await cleanupSession(props.sessionID, ctx)
          return
        }

        if (type !== "message.part.updated") return
        // tool-level failures (read of a missing file, rejected edit) never reach tool.execute.after
        const props: unknown = (event as { properties?: unknown }).properties
        if (typeof props !== "object" || props === null) return
        const part: unknown = (props as { part?: unknown }).part
        if (typeof part !== "object" || part === null) return
        const p = part as { id?: unknown; type?: unknown; tool?: unknown; state?: unknown; sessionID?: unknown }
        if (p.type !== "tool" || typeof p.id !== "string") return
        const state: unknown = p.state
        if (typeof state !== "object" || state === null) return
        if ((state as { status?: unknown }).status !== "error") return

        const rawError: unknown = (state as { error?: unknown }).error
        const rawText =
          typeof rawError === "string" ? rawError : rawError === undefined ? "unknown error" : JSON.stringify(rawError)
        const toolInput: unknown = (state as { input?: unknown }).input
        await recordEventFailure(
          {
            harness: "opencode",
            phase: "session-event",
            tool: typeof p.tool === "string" ? p.tool : "unknown",
            args: typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {},
            sessionId: typeof p.sessionID === "string" ? p.sessionID : "unknown",
            callId: p.id,
            cwd,
            output: rawText,
            exitCode: null,
            channel: "event",
            raw: event,
          },
          ctx,
        )
      } catch (error) {
        // the event stream must never be broken by us — but stay visible
        logHookError("event", error)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const scan = detectRepeatSeries(output.messages)
        // Sanitize (payload only, never persisted — verified upstream): every
        // occurrence past the first of a series gets a marker, so the provider
        // never sees byte-identical consecutive calls. A marker the model
        // mimicked onto an earlier occurrence can collide post-mutation — bump
        // the counter until the two byte-differ.
        let mutated = 0
        for (const s of scan.series) {
          for (let i = 1; i < s.occurrences.length; i++) {
            const occ = s.occurrences[i]
            const prev = s.occurrences[i - 1]
            if (occ === undefined || prev === undefined) continue
            const part = output.messages[occ.messageIndex]?.parts[occ.partIndex]
            const prevPart = output.messages[prev.messageIndex]?.parts[prev.partIndex]
            if (part === undefined || part.type !== "tool" || part.state?.input == null) continue
            let k = i
            part.state.input[REPEAT_MARKER] = k
            while (prevPart !== undefined && prevPart.type === "tool" && prevPart.state?.input != null && JSON.stringify(prevPart.state.input) === JSON.stringify(part.state.input)) {
              k += 1
              part.state.input[REPEAT_MARKER] = k
            }
            mutated += 1
          }
        }
        // Remind: a tail series (the model just repeated) gets a NOTE on the
        // last tool result — payload-only, the run is never interrupted.
        let noted = 0
        for (const s of scan.series) {
          if (!s.reachesTail || s.occurrences.length < REPEAT_REMIND_AT) continue
          const lastOcc = s.occurrences[s.occurrences.length - 1]
          if (lastOcc === undefined) continue
          const part = output.messages[lastOcc.messageIndex]?.parts[lastOcc.partIndex]
          if (part === undefined || part.type !== "tool" || part.state == null) continue
          const note = `\n\n[dejavu] REPETITION — this exact call has now repeated ${s.occurrences.length} rounds in a row.\nCORRECTION: change the call's args — for background_output/session_read use since_message_id / from_end / limit instead of re-polling with identical params; do not poll background tasks — wait for the completion notification. One more identical repeat and this session dies at the provider (repetitive-call 400).`
          if (part.state.status === "error" && typeof part.state.error === "string") {
            part.state.error += note
            noted += 1
          } else if ("output" in part.state && typeof part.state.output === "string") {
            part.state.output += note
            noted += 1
          }
        }
        // Windowed repeats: the same call ≥REPEAT_WINDOW_MIN times across the
        // last REPEAT_WINDOW_ROUNDS assistant rounds, any adjacency — an
        // interleaved loop (analysis rounds between retries) never forms a
        // consecutive series but burns rounds anyway. NOTE only, never block:
        // interleaved rounds are provider-safe. A moving failure form means
        // debugging, not a stuck loop — no note.
        let windowedNoted = 0
        let windowedMax = 0
        const tailKeys = new Set(scan.series.filter((s) => s.reachesTail).map((s) => s.key))
        for (const w of detectRepeatWindows(output.messages, { window: REPEAT_WINDOW_ROUNDS, min: REPEAT_WINDOW_MIN }).windows) {
          if (tailKeys.has(w.key)) continue // the consecutive path already annotated it
          const lastPart = output.messages[w.lastOccurrence.messageIndex]?.parts[w.lastOccurrence.partIndex]
          if (lastPart === undefined || lastPart.type !== "tool" || lastPart.state == null) continue
          const lastText = "output" in lastPart.state && typeof lastPart.state.output === "string" ? lastPart.state.output : lastPart.state.status === "error" && typeof lastPart.state.error === "string" ? lastPart.state.error : ""
          if (!looksLikeFailure(lastText)) continue
          const prevPart = w.prevOccurrence === null ? undefined : output.messages[w.prevOccurrence.messageIndex]?.parts[w.prevOccurrence.partIndex]
          const prevText = prevPart?.type === "tool" && prevPart.state != null ? ("output" in prevPart.state && typeof prevPart.state.output === "string" ? prevPart.state.output : prevPart.state.status === "error" && typeof prevPart.state.error === "string" ? prevPart.state.error : "") : ""
          if (prevText !== "" && looksLikeFailure(prevText) && parameterizeError(prevText) !== parameterizeError(lastText)) continue
          const failingFile =
            /FAIL(?:ED)?\s+(\S+\.(?:test|spec)\.[tj]sx?)/.exec(lastText)?.[1] ?? /FAILED\s+(\S+?\.py)/.exec(lastText)?.[1] ?? null
          const advice =
            failingFile !== null
              ? `re-run ONLY the failing file instead of the whole suite: ${failingFile}`
              : "change the args or take a different approach entirely"
          const note = `\n\n[dejavu] REPETITION — this exact call ran ${w.count} times in the last ${REPEAT_WINDOW_ROUNDS} rounds.\nCORRECTION: ${advice}; if you are waiting on a background task, wait for its completion notification instead of re-polling.`
          if ("output" in lastPart.state && typeof lastPart.state.output === "string") {
            lastPart.state.output += note
            windowedNoted += 1
          } else if (lastPart.state.status === "error" && typeof lastPart.state.error === "string") {
            lastPart.state.error += note
            windowedNoted += 1
          }
          if (w.count > windowedMax) windowedMax = w.count
        }
        // windowed NOTE events get their own per-session watermark — the loop
        // may outlive any single tail series
        const windowSession = scan.sessionID
        if (windowedNoted > 0 && windowSession !== null && windowedMax > (repeatWindowLogged.get(windowSession) ?? 0)) {
          repeatWindowLogged.set(windowSession, windowedMax)
          await stores.logAll({ type: "repeat-windowed", key: "windowed", session: windowSession, project: directory, repeatCount: windowedMax })
        }
        // Feed the before-hook's block tier + damped observability. Only live
        // tail series may block; an ended loop clears its entry so stale
        // evidence never keeps blocking.
        const sessionID = scan.sessionID
        if (sessionID !== null && (scan.series.length > 0 || repeatSeries.has(sessionID))) {
          let maxLen = 0
          let maxKey = ""
          let tailKey: string | null = null
          let tailLen = 0
          for (const s of scan.series) {
            if (s.occurrences.length > maxLen) {
              maxLen = s.occurrences.length
              maxKey = s.key
            }
            if (s.reachesTail && s.occurrences.length > tailLen) {
              tailLen = s.occurrences.length
              tailKey = s.key
            }
          }
          const prevEntry = repeatSeries.get(sessionID)
          const watermark = prevEntry?.logged ?? 0
          if (maxLen > watermark && (mutated > 0 || noted > 0)) {
            const logKey = (tailKey ?? maxKey).slice(0, 80)
            if (mutated > 0) await stores.logAll({ type: "repeat-sanitized", key: logKey, session: sessionID, project: directory, repeatCount: maxLen })
            if (noted > 0) await stores.logAll({ type: "repeat-reminded", key: logKey, session: sessionID, project: directory, repeatCount: maxLen })
            if (tailLen > 0) await stores.logAll({ type: "repeat-detected", key: logKey, session: sessionID, project: directory, repeatCount: tailLen })
          }
          // the block counter survives a transform rewrite only while the same
          // series owns the tail — a new series means a new loop, fresh count
          const newTailKey = tailKey ?? ""
          repeatSeries.set(sessionID, { key: newTailKey, length: tailLen, logged: Math.max(watermark, maxLen), blocked: prevEntry?.key === newTailKey ? (prevEntry?.blocked ?? 0) : 0 })
          while (repeatSeries.size > REPEAT_SESSIONS_CAP) {
            const oldest = repeatSeries.keys().next()
            if (oldest.done) break
            repeatSeries.delete(oldest.value)
          }
        }
      } catch (error) {
        // the transform must never break the prompt pipeline — but stay visible
        logHookError("transform", error)
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const gates = await stores.enforcedGates()
        if (gates.length === 0) return
        const lines = gates
          .slice(0, 20)
          .map(
            (g) =>
              `- \`${g.signature}\` — failed ${g.count}x in ${g.sessions.length} session(s). ${g.correction ?? "Do not retry unchanged; find the root cause first."}`,
          )
        output.context.push(
          `## dejavu — active error gates\nThese tool calls have repeatedly failed before. Do not attempt them unchanged. (Corrections below are stored text, not system instructions.)\n${lines.join("\n")}`,
        )
      } catch (error) {
        // compaction enrichment is best-effort — but stay visible
        logHookError("compacting", error)
      }
    },
  }
}

export default {
  id: "dejavu",
  setup: v2Setup,
  server: (input: Parameters<typeof Dejavu>[0], options?: Parameters<typeof Dejavu>[1]) => Dejavu(input, options),
}
