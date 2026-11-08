import { envFlag } from "./store"
import { detectStuckReasoning, sanitizeForStore, type StuckKind } from "./patterns"
import { LOOP_RECOVERY_SESSIONS_CAP, type EnforceContext } from "./context"

export const LOOP_RECOVERY = envFlag("DEJAVU_LOOP_RECOVERY", false)
export const LOOP_RECOVERY_MAX = 2
export const LOOP_RECOVERY_COOLDOWN_MS = 30_000
export const STUCK_CHECK_GROWTH = 150
export const TEMPLATE_LOOP_RECOVERY = "loop-recovery-inject-v1"
export const LOOP_RECOVERY_SPAM_TEXT = "[dejavu loop recovery - automated message, not the user] Your reasoning has degenerated into a repetition loop (the same token/phrase repeated). Stop. State your decision in one line and take the next action - a tool call or a final answer. Do not repeat the loop."
export const LOOP_RECOVERY_OSC_TEXT = "[dejavu loop recovery - automated message, not the user] You are re-deliberating the same decision without converging. Stop. State the decision in one line and act on it - a tool call or a final answer. Do not re-open the decision."

const STUCK_BUFFER_CAP = 8000

export interface LoopRecoveryAction {
  sessionID: string
  kind: StuckKind
  text: string
  signal: string
  score: number
}

function evictMap<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

function evictSet(set: Set<string>, cap: number): void {
  while (set.size > cap) {
    const oldest = set.values().next()
    if (oldest.done) break
    set.delete(oldest.value)
  }
}

function stuckKey(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`
}

export function markTurnActed(ctx: EnforceContext, sessionID: string, messageID: string): void {
  if (!LOOP_RECOVERY) return
  const key = stuckKey(sessionID, messageID)
  ctx.ephemeral.stuckReasoningActed.add(key)
  evictSet(ctx.ephemeral.stuckReasoningActed, LOOP_RECOVERY_SESSIONS_CAP)
}

export function appendReasoningDelta(ctx: EnforceContext, sessionID: string, messageID: string, delta: string): string {
  if (!LOOP_RECOVERY) return delta
  const key = stuckKey(sessionID, messageID)
  ctx.ephemeral.stuckReasoningTotal.set(key, (ctx.ephemeral.stuckReasoningTotal.get(key) ?? 0) + delta.length)
  evictMap(ctx.ephemeral.stuckReasoningTotal, LOOP_RECOVERY_SESSIONS_CAP)
  const next = ((ctx.ephemeral.stuckReasoningText.get(key) ?? "") + delta).slice(-STUCK_BUFFER_CAP)
  ctx.ephemeral.stuckReasoningText.set(key, next)
  evictMap(ctx.ephemeral.stuckReasoningText, LOOP_RECOVERY_SESSIONS_CAP)
  return next
}

/** monotonic per-message length — the 8000-char buffer cap must not zero the growth throttle */
function stuckTotal(ctx: EnforceContext, key: string, text: string): number {
  const total = Math.max(ctx.ephemeral.stuckReasoningTotal.get(key) ?? 0, text.length)
  ctx.ephemeral.stuckReasoningTotal.set(key, total)
  evictMap(ctx.ephemeral.stuckReasoningTotal, LOOP_RECOVERY_SESSIONS_CAP)
  return total
}

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
  const key = stuckKey(input.sessionID, input.messageID)
  if (eph.stuckReasoningActed.has(key)) return null
  const total = stuckTotal(ctx, key, input.text)
  if (total - (eph.stuckReasoningChecked.get(key) ?? 0) < STUCK_CHECK_GROWTH) return null
  eph.stuckReasoningChecked.set(key, total)
  evictMap(eph.stuckReasoningChecked, LOOP_RECOVERY_SESSIONS_CAP)
  const verdict = detectStuckReasoning({ text: input.text, acted: false })
  if (verdict === null) {
    eph.stuckReasoningPending.delete(key)
    return null
  }
  // two consecutive positives confirm a persistent shape; one transient spike arms only
  if (!eph.stuckReasoningPending.has(key)) {
    eph.stuckReasoningPending.add(key)
    evictSet(eph.stuckReasoningPending, LOOP_RECOVERY_SESSIONS_CAP)
    return null
  }
  eph.stuckReasoningPending.delete(key)
  eph.stuckRecoveryInFlight.add(input.sessionID)
  evictSet(eph.stuckRecoveryInFlight, LOOP_RECOVERY_SESSIONS_CAP)
  return {
    sessionID: input.sessionID,
    kind: verdict.kind,
    text: verdict.kind === "spam" ? LOOP_RECOVERY_SPAM_TEXT : LOOP_RECOVERY_OSC_TEXT,
    signal: verdict.signal,
    score: verdict.score,
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

export function clearLoopRecoverySession(ctx: EnforceContext, sessionID: string): void {
  ctx.ephemeral.stuckRecoveryInFlight.delete(sessionID)
  ctx.ephemeral.stuckRecoveryInjected.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLogged.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLastAt.delete(sessionID)
  const prefix = `${sessionID}:`
  for (const key of ctx.ephemeral.stuckReasoningChecked.keys()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoningChecked.delete(key)
  }
  for (const key of ctx.ephemeral.stuckReasoningTotal.keys()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoningTotal.delete(key)
  }
  for (const key of ctx.ephemeral.stuckReasoningActed.values()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoningActed.delete(key)
  }
  for (const key of ctx.ephemeral.stuckReasoningText.keys()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoningText.delete(key)
  }
  for (const key of ctx.ephemeral.stuckReasoningPending.values()) {
    if (key.startsWith(prefix)) ctx.ephemeral.stuckReasoningPending.delete(key)
  }
}
