import { envFlag } from "./store"
import { detectStuckReasoning, sanitizeForStore, type StuckKind } from "./patterns"
import { LOOP_RECOVERY_SESSIONS_CAP, type EnforceContext } from "./context"

export const LOOP_RECOVERY = envFlag("DEJAVU_LOOP_RECOVERY", false)
export const LOOP_RECOVERY_MAX = 2
export const LOOP_RECOVERY_COOLDOWN_MS = 30_000
export const STUCK_CHECK_GROWTH = 400
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

export function markTurnActed(ctx: EnforceContext, messageID: string): void {
  if (!LOOP_RECOVERY) return
  ctx.ephemeral.stuckReasoningActed.add(messageID)
  evictSet(ctx.ephemeral.stuckReasoningActed, LOOP_RECOVERY_SESSIONS_CAP)
}

export function appendReasoningDelta(ctx: EnforceContext, messageID: string, delta: string): string {
  if (!LOOP_RECOVERY) return delta
  const next = ((ctx.ephemeral.stuckReasoningText.get(messageID) ?? "") + delta).slice(-STUCK_BUFFER_CAP)
  ctx.ephemeral.stuckReasoningText.set(messageID, next)
  evictMap(ctx.ephemeral.stuckReasoningText, LOOP_RECOVERY_SESSIONS_CAP)
  return next
}

export async function checkLoopRecovery(
  ctx: EnforceContext,
  input: { sessionID: string; messageID: string; text: string },
): Promise<LoopRecoveryAction | null> {
  if (!LOOP_RECOVERY) return null
  const eph = ctx.ephemeral
  const count = eph.stuckRecoveryInjected.get(input.sessionID) ?? 0
  if (count >= LOOP_RECOVERY_MAX) return null
  if (Date.now() - (eph.stuckRecoveryLastAt.get(input.sessionID) ?? 0) < LOOP_RECOVERY_COOLDOWN_MS) return null
  const acted = eph.stuckReasoningActed.has(input.messageID)
  if (acted) return null
  const key = `${input.sessionID}:${input.messageID}`
  if (input.text.length - (eph.stuckReasoningChecked.get(key) ?? 0) < STUCK_CHECK_GROWTH) return null
  eph.stuckReasoningChecked.set(key, input.text.length)
  evictMap(eph.stuckReasoningChecked, LOOP_RECOVERY_SESSIONS_CAP)
  const verdict = detectStuckReasoning({ text: input.text, acted })
  if (verdict === null) return null
  eph.stuckRecoveryInjected.set(input.sessionID, count + 1)
  evictMap(eph.stuckRecoveryInjected, LOOP_RECOVERY_SESSIONS_CAP)
  eph.stuckRecoveryLastAt.set(input.sessionID, Date.now())
  evictMap(eph.stuckRecoveryLastAt, LOOP_RECOVERY_SESSIONS_CAP)
  if (!eph.stuckRecoveryLogged.has(input.sessionID)) {
    eph.stuckRecoveryLogged.add(input.sessionID)
    evictSet(eph.stuckRecoveryLogged, LOOP_RECOVERY_SESSIONS_CAP)
    await ctx.stores.logAll({
      type: "loop-recovery",
      key: sanitizeForStore(verdict.kind).slice(0, 80),
      tool: undefined,
      session: sanitizeForStore(input.sessionID).slice(0, 80),
      project: ctx.projectDir,
      reaction: "inject",
      reason: sanitizeForStore(verdict.signal).slice(0, 80),
      warned: count,
      template: TEMPLATE_LOOP_RECOVERY,
    })
  }
  return {
    sessionID: input.sessionID,
    kind: verdict.kind,
    text: verdict.kind === "spam" ? LOOP_RECOVERY_SPAM_TEXT : LOOP_RECOVERY_OSC_TEXT,
    signal: verdict.signal,
    score: verdict.score,
  }
}

export function clearLoopRecoverySession(ctx: EnforceContext, sessionID: string): void {
  ctx.ephemeral.stuckRecoveryInjected.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLogged.delete(sessionID)
  ctx.ephemeral.stuckRecoveryLastAt.delete(sessionID)
  for (const key of ctx.ephemeral.stuckReasoningChecked.keys()) {
    if (key.startsWith(`${sessionID}:`)) ctx.ephemeral.stuckReasoningChecked.delete(key)
  }
}
