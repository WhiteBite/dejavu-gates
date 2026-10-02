import { detectRepeatSeries, detectRepeatWindows, detectShapeLoops, looksLikeFailure, parameterizeError, REPEAT_MARKER, sanitizeForStore } from "./patterns"
import { REPEAT_STOP_AFTER } from "./repeat"
import type { EnforceContext } from "./context"

// --- Tunables ---------------------------------------------------------------

/** repeat channel: consecutive identical rounds reaching the tail earn a NOTE on the last tool result */
export const REPEAT_REMIND_AT = 2
/** repeat channel: per-session tail-series map cap (in-process; a stuck loop must not grow it) */
const REPEAT_SESSIONS_CAP = 1000
/** repeat channel: a key this frequent within the last REPEAT_WINDOW_ROUNDS assistant rounds earns a NOTE */
export const REPEAT_WINDOW_MIN = 3
export const REPEAT_WINDOW_ROUNDS = 12
/** shape channel: same call with cosmetic variation this often earns a NOTE; a second detection injects a loop break */
export const SHAPE_LOOP_MIN = 3
/** a prompt-path block older than this is stale — compaction clones re-fire the channel on a cloned head */
const BLOCK_LIVE_MS = 120_000

/** Structural message shape the repeat channel operates on. Hosts cast their
 *  typed payloads to this interface — the channel's contract is in-place
 *  mutation of parts (marker insertion into state.input, notes appended to
 *  state.output/state.error), so the cast must alias the live payload objects. */
export interface RepeatChannelState {
  input?: Record<string, unknown>
  output?: string
  error?: string
  status?: string
}

export interface RepeatChannelPart {
  type: string
  tool?: string
  state?: RepeatChannelState
}

export interface RepeatChannelMessage {
  info: { role: string; sessionID?: string }
  parts: RepeatChannelPart[]
}

/** A synthetic user-role message the host appends to the outgoing payload. */
export interface LoopBreakInjection {
  sessionID: string
  text: string
  logKey: string
  tool: string
  count: number
}

export interface RepeatChannelResult {
  /** loop-break injections in firing order — the host converts each into its own message shape */
  injected: LoopBreakInjection[]
  mutated: number
  noted: number
}

/**
 * Repeat/shape-loop channel: the outgoing-payload orchestration (sanitize
 * markers, REPETITION notes, windowed repeats, shape loops, loop-break
 * injection, and the repeatSeries ephemeral state the before-hook's block
 * tier reads). Mutates `messages` in place; returns the injections for the
 * host to append in its own message shape. Engine bugs propagate to the
 * host's catch — the channel must never break the prompt pipeline.
 */
export async function applyRepeatChannel(messages: RepeatChannelMessage[], ctx: EnforceContext): Promise<RepeatChannelResult> {
  const ephemeral = ctx.ephemeral
  const repeatSeries = ephemeral.repeatSeries
  const repeatWindowLogged = ephemeral.repeatWindowLogged
  const scan = detectRepeatSeries(messages)
  const injected: LoopBreakInjection[] = []
  const injectLoopBreak = async (text: string, logKey: string, tool: string, count: number): Promise<void> => {
    const sessionID = scan.sessionID
    if (sessionID === null) return
    injected.push({ sessionID, text, logKey, tool, count })
    const loopKey = `${sessionID}:${logKey}`
    if (!ephemeral.loopBreakInjected.has(loopKey)) {
      ephemeral.loopBreakInjected.add(loopKey)
      await ctx.stores.logAll({ type: "loop-break", key: sanitizeForStore(logKey).slice(0, 80), tool, session: sessionID, project: ctx.projectDir, repeatCount: count })
    }
  }
  // payload-only markers (never persisted): a mimicked marker can collide post-mutation — bump until byte-distinct
  let mutated = 0
  for (const s of scan.series) {
    for (let i = 1; i < s.occurrences.length; i++) {
      const occ = s.occurrences[i]
      const prev = s.occurrences[i - 1]
      if (occ === undefined || prev === undefined) continue
      const part = messages[occ.messageIndex]?.parts[occ.partIndex]
      const prevPart = messages[prev.messageIndex]?.parts[prev.partIndex]
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
  // a tail series gets a NOTE on the last tool result — payload-only, the run is never interrupted
  let noted = 0
  const annotatedParts = new Set<string>()
  for (const s of scan.series) {
    if (!s.reachesTail || s.occurrences.length < REPEAT_REMIND_AT) continue
    const lastOcc = s.occurrences[s.occurrences.length - 1]
    if (lastOcc === undefined) continue
    const part = messages[lastOcc.messageIndex]?.parts[lastOcc.partIndex]
    if (part === undefined || part.type !== "tool" || part.state == null) continue
    const note = `\n\n[dejavu] REPETITION — this exact call has now repeated ${s.occurrences.length} rounds in a row.\nCORRECTION: change the call's args — for background_output/session_read use since_message_id / from_end / limit instead of re-polling with identical params; do not poll background tasks — wait for the completion notification. One more identical repeat and this session dies at the provider (repetitive-call 400).`
    if (part.state.status === "error" && typeof part.state.error === "string") {
      part.state.error += note
      noted += 1
    } else if ("output" in part.state && typeof part.state.output === "string") {
      part.state.output += note
      noted += 1
    }
    annotatedParts.add(`${lastOcc.messageIndex}:${lastOcc.partIndex}`)
  }
  // windowed repeats never block — interleaved rounds are provider-safe; a moving failure form is debugging
  let windowedNoted = 0
  let windowedMax = 0
  const tailKeys = new Set(scan.series.filter((s) => s.reachesTail).map((s) => s.key))
  for (const w of detectRepeatWindows(messages, { window: REPEAT_WINDOW_ROUNDS, min: REPEAT_WINDOW_MIN }).windows) {
    if (tailKeys.has(w.key)) continue // the consecutive path already annotated it
    const lastPart = messages[w.lastOccurrence.messageIndex]?.parts[w.lastOccurrence.partIndex]
    if (lastPart === undefined || lastPart.type !== "tool" || lastPart.state == null) continue
    const lastText = "output" in lastPart.state && typeof lastPart.state.output === "string" ? lastPart.state.output : lastPart.state.status === "error" && typeof lastPart.state.error === "string" ? lastPart.state.error : ""
    if (!looksLikeFailure(lastText)) continue
    const prevPart = w.prevOccurrence === null ? undefined : messages[w.prevOccurrence.messageIndex]?.parts[w.prevOccurrence.partIndex]
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
    annotatedParts.add(`${w.lastOccurrence.messageIndex}:${w.lastOccurrence.partIndex}`)
    if (w.count > windowedMax) windowedMax = w.count
  }
  // windowed NOTEs carry their own per-session watermark — the loop may outlive any single tail series
  const windowSession = scan.sessionID
  if (windowedNoted > 0 && windowSession !== null && windowedMax > (repeatWindowLogged.get(windowSession) ?? 0)) {
    repeatWindowLogged.set(windowSession, windowedMax)
    await ctx.stores.logAll({ type: "repeat-windowed", key: "windowed", session: windowSession, project: ctx.projectDir, repeatCount: windowedMax })
  }
  // shape loops: same call with cosmetic variation (comment/offset churn) — invisible to byte-identical channels
  const shapeSession = scan.sessionID
  if (shapeSession !== null) {
    const lastIsAssistantForShape = messages[messages.length - 1]?.info.role === "assistant"
    for (const sw of detectShapeLoops(messages, { window: REPEAT_WINDOW_ROUNDS, min: SHAPE_LOOP_MIN }).windows) {
      if (annotatedParts.has(`${sw.lastOccurrence.messageIndex}:${sw.lastOccurrence.partIndex}`)) continue
      const shapeKey = `${shapeSession}:${sw.key}`
      const lastPart = messages[sw.lastOccurrence.messageIndex]?.parts[sw.lastOccurrence.partIndex]
      if (lastPart === undefined || lastPart.type !== "tool" || lastPart.state == null) continue
      const shapeLastText = "output" in lastPart.state && typeof lastPart.state.output === "string" ? lastPart.state.output : lastPart.state.status === "error" && typeof lastPart.state.error === "string" ? lastPart.state.error : ""
      const shapePrevPart = sw.prevOccurrence === null ? undefined : messages[sw.prevOccurrence.messageIndex]?.parts[sw.prevOccurrence.partIndex]
      const shapePrevText = shapePrevPart?.type === "tool" && shapePrevPart.state != null ? ("output" in shapePrevPart.state && typeof shapePrevPart.state.output === "string" ? shapePrevPart.state.output : shapePrevPart.state.status === "error" && typeof shapePrevPart.state.error === "string" ? shapePrevPart.state.error : "") : ""
      if (shapePrevText !== "" && looksLikeFailure(shapePrevText) && looksLikeFailure(shapeLastText) && parameterizeError(shapePrevText) !== parameterizeError(shapeLastText)) continue
      const notedBefore = ephemeral.shapeLoopNotes.get(shapeKey) ?? 0
      if (notedBefore > 0) {
        if (lastIsAssistantForShape) {
          const text = `[dejavu loop protection — automated message, not the user] You have run the same call ${sw.count} times in the last ${REPEAT_WINDOW_ROUNDS} rounds with only cosmetic variations (trailing comments, offsets). It is the same call and the result will not change. Reply in plain text ONLY — no tool calls: (1) what you finished, (2) what you verified, (3) what remains. If you are a subagent, this text reply IS your final report to whoever launched you.`
          await injectLoopBreak(text, sw.key, sw.tool, sw.count)
        }
        continue
      }
      const note = `\n\n[dejavu] SHAPE LOOP — this call has run ${sw.count} times in the last ${REPEAT_WINDOW_ROUNDS} rounds with only cosmetic variations (trailing comments, offsets, ordering). It is the same call; re-running it will not produce new information. If you are verifying work, verify once and move on; if you are paging a file, read the whole file once with a bigger limit instead of slices.`
      let attached = false
      if ("output" in lastPart.state && typeof lastPart.state.output === "string") {
        lastPart.state.output += note
        attached = true
      } else if (lastPart.state.status === "error" && typeof lastPart.state.error === "string") {
        lastPart.state.error += note
        attached = true
      }
      if (attached) {
        ephemeral.shapeLoopNotes.set(shapeKey, 1)
        await ctx.stores.logAll({ type: "shape-loop", key: sanitizeForStore(sw.key.slice(0, 80)), tool: sw.tool, session: shapeSession, project: ctx.projectDir, repeatCount: sw.count })
      }
    }
  }
  // feed the before-hook's block tier — only live tail series may block, an ended loop clears its entry
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
      const logKey = sanitizeForStore(tailKey ?? maxKey).slice(0, 80)
      if (mutated > 0) await ctx.stores.logAll({ type: "repeat-sanitized", key: logKey, session: sessionID, project: ctx.projectDir, repeatCount: maxLen })
      if (noted > 0) await ctx.stores.logAll({ type: "repeat-reminded", key: logKey, session: sessionID, project: ctx.projectDir, repeatCount: maxLen })
      if (tailLen > 0) await ctx.stores.logAll({ type: "repeat-detected", key: logKey, session: sessionID, project: ctx.projectDir, repeatCount: tailLen })
    }
    // the block counter survives a rewrite only while the same series owns the tail — a new series is a new loop
    const newTailKey = tailKey ?? ""
    repeatSeries.set(sessionID, { key: newTailKey, length: tailLen, logged: Math.max(watermark, maxLen), blocked: prevEntry?.key === newTailKey ? (prevEntry?.blocked ?? 0) : 0, lastBlockAt: prevEntry?.key === newTailKey ? (prevEntry?.lastBlockAt ?? 0) : 0 })
    const entry = repeatSeries.get(sessionID)
    // an earlier injection this round ends the tail — the host appends it as a user message
    const lastIsAssistant = injected.length === 0 && messages[messages.length - 1]?.info.role === "assistant"
    // compaction also triggers this hook on a cloned head — lastBlockAt proves a live prompt-path block
    const blockIsLive = entry !== undefined && Date.now() - entry.lastBlockAt < BLOCK_LIVE_MS
    if (tailKey !== null && tailLen > 0 && lastIsAssistant && blockIsLive && entry !== undefined && entry.blocked >= REPEAT_STOP_AFTER) {
      const text = `[dejavu loop protection — automated message, not the user] The tool call you keep retrying has been blocked ${entry.blocked} times and will never run in this session. Do not re-issue it, rename it, or work around it. Reply in plain text ONLY — no tool calls: (1) what you finished, (2) what is blocked and why, (3) what remains. If you are a subagent, this text reply IS your final report to whoever launched you.`
      await injectLoopBreak(text, tailKey, scan.series.find((s) => s.reachesTail && s.key === tailKey)?.tool ?? "unknown", entry.blocked)
    }
    while (repeatSeries.size > REPEAT_SESSIONS_CAP) {
      const oldest = repeatSeries.keys().next()
      if (oldest.done) break
      repeatSeries.delete(oldest.value)
      for (const key of ephemeral.loopBreakInjected) {
        if (key.startsWith(`${oldest.value}:`)) ephemeral.loopBreakInjected.delete(key)
      }
      for (const key of ephemeral.shapeLoopNotes.keys()) {
        if (key.startsWith(`${oldest.value}:`)) ephemeral.shapeLoopNotes.delete(key)
      }
    }
  }
  return { injected, mutated, noted }
}
