import { envFlag } from "./store"
import { detectStuckReasoning, sanitizeForStore, type StuckKind } from "./patterns"
import { evictMap, evictSet, LOOP_RECOVERY_SESSIONS_CAP, type EnforceContext, type StuckMessageState } from "./context"

/** opt-in flag: loop recovery is off until DEJAVU_LOOP_RECOVERY is set */
export const LOOP_RECOVERY = envFlag("DEJAVU_LOOP_RECOVERY", false)
/** landed injections allowed per session */
export const LOOP_RECOVERY_MAX = 2
/** per-session cooldown after a landed injection */
export const LOOP_RECOVERY_COOLDOWN_MS = 30_000
/** accumulated characters between detector checks on one message */
export const STUCK_CHECK_GROWTH = 150
/** log template id for the corrective turn */
export const TEMPLATE_LOOP_RECOVERY = "loop-recovery-inject-v1"
/** corrective turn text for a lexical-spam loop */
export const LOOP_RECOVERY_SPAM_TEXT = "[dejavu loop recovery - automated message, not the user] Your reasoning has degenerated into a repetition loop (the same token/phrase repeated). Stop. State your decision in one line and take the next action - a tool call or a final answer. Do not repeat the loop."
/** corrective turn text for a hedge-heavy deliberation loop */
export const LOOP_RECOVERY_OSC_TEXT = "[dejavu loop recovery - automated message, not the user] You are re-deliberating the same decision without converging. Stop. State the decision in one line and act on it - a tool call or a final answer. Do not re-open the decision."

const STUCK_BUFFER_CAP = 8000

/** decision handed to the host: abort the session and inject `text` as a corrective user turn */
export interface LoopRecoveryAction {
  sessionID: string
  kind: StuckKind
  text: string
  signal: string
}

function stuckKey(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`
}

function stuckState(ctx: EnforceContext, sessionID: string, messageID: string): StuckMessageState {
  const key = stuckKey(sessionID, messageID)
  let state = ctx.ephemeral.stuckReasoning.get(key)
  if (state === undefined) {
    state = { acted: false, checked: 0, total: 0, text: "", pending: false }
    ctx.ephemeral.stuckReasoning.set(key, state)
    evictMap(ctx.ephemeral.stuckReasoning, LOOP_RECOVERY_SESSIONS_CAP)
  }
  return state
}

/** mark a turn that already acted (emitted text or ran a tool): loop recovery never interrupts it */
export function markTurnActed(ctx: EnforceContext, sessionID: string, messageID: string): void {
  if (!LOOP_RECOVERY) return
  stuckState(ctx, sessionID, messageID).acted = true
}

/** accumulate a reasoning delta into the capped per-message buffer and return the buffer */
export function appendReasoningDelta(ctx: EnforceContext, sessionID: string, messageID: string, delta: string): string {
  if (!LOOP_RECOVERY) return delta
  const state = stuckState(ctx, sessionID, messageID)
  state.total += delta.length
  state.text = (state.text + delta).slice(-STUCK_BUFFER_CAP)
  return state.text
}

/** decide whether the streamed reasoning is stuck; the returned action is settled later via settleLoopInjection */
export function checkLoopRecovery(
  ctx: EnforceContext,
  input: { sessionID: string; messageID: string; text: string },
): LoopRecoveryAction | null {
  if (!LOOP_RECOVERY) return null
  const eph = ctx.ephemeral
  if (eph.stuckRecoveryInFlight.has(input.sessionID)) return null
  const count = eph.stuckRecoveryInjected.get(input.sessionID) ?? 0
  if (count >= LOOP_RECOVERY_MAX) return null
  if (Date.now() - (eph.stuckRecoveryLastAt.get(input.sessionID) ?? 0) < LOOP_RECOVERY_COOLDOWN_MS) return null
  const state = stuckState(ctx, input.sessionID, input.messageID)
  if (state.acted) return null
  const total = Math.max(state.total, input.text.length)
  state.total = total
  if (total - state.checked < STUCK_CHECK_GROWTH) return null
  state.checked = total
  const verdict = detectStuckReasoning({ text: input.text, acted: false })
  if (verdict === null) {
    state.pending = false
    return null
  }
  // two consecutive positives confirm a persistent shape; one transient spike arms only
  if (!state.pending) {
    state.pending = true
    return null
  }
  state.pending = false
  eph.stuckRecoveryInFlight.add(input.sessionID)
  evictSet(eph.stuckRecoveryInFlight, LOOP_RECOVERY_SESSIONS_CAP)
  return {
    sessionID: input.sessionID,
    kind: verdict.kind,
    text: verdict.kind === "spam" ? LOOP_RECOVERY_SPAM_TEXT : LOOP_RECOVERY_OSC_TEXT,
    signal: verdict.signal,
  }
}

/** quota, cooldown and log settle here — a failed abort+prompt burns nothing and retries */
export async function settleLoopInjection(
  ctx: EnforceContext,
  input: { sessionID: string; kind: StuckKind; signal: string },
  ok: boolean,
): Promise<void> {
  if (!LOOP_RECOVERY) return
  const eph = ctx.ephemeral
  eph.stuckRecoveryInFlight.delete(input.sessionID)
  if (!ok) return
  const count = (eph.stuckRecoveryInjected.get(input.sessionID) ?? 0) + 1
  eph.stuckRecoveryInjected.set(input.sessionID, count)
  evictMap(eph.stuckRecoveryInjected, LOOP_RECOVERY_SESSIONS_CAP)
  eph.stuckRecoveryLastAt.set(input.sessionID, Date.now())
  evictMap(eph.stuckRecoveryLastAt, LOOP_RECOVERY_SESSIONS_CAP)
  if (eph.stuckRecoveryLogged.has(input.sessionID)) return
  eph.stuckRecoveryLogged.add(input.sessionID)
  evictSet(eph.stuckRecoveryLogged, LOOP_RECOVERY_SESSIONS_CAP)
  await ctx.stores.logAll({
    type: "loop-recovery",
    key: sanitizeForStore(input.kind).slice(0, 80),
    tool: undefined,
    session: sanitizeForStore(input.sessionID).slice(0, 80),
    project: ctx.projectDir,
    reaction: "inject",
    reason: sanitizeForStore(input.signal).slice(0, 80),
    warned: count - 1,
    template: TEMPLATE_LOOP_RECOVERY,
  })
}

/** session teardown: drop every loop-recovery trace the session left */
export function clearLoopRecoverySession(ctx: EnforceContext, sessionID: string): void {
  ctx.ephemeral.stuckRecoveryInFlight.delete(sessionID)
  ctx.ephemeral.stuckRecoveryInjected.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLogged.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLastAt.delete(sessionID)
  const prefix = `${sessionID}:`
  for (const key of ctx.ephemeral.stuckReasoning.keys()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoning.delete(key)
  }
}
