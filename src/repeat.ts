import { REPEAT_MARKER, REPEAT_PROCEED, signRepeatedCall, stripQuotedSpans } from "./patterns"
import type { EnforceContext } from "./context"
import type { NormalizedEvent } from "./types"

// --- Tunables ---------------------------------------------------------------

/** an incoming call that would extend a live tail series to this length is
 *  hard-blocked (provider 400 prevention is payload-side, host-specific) */
export const REPEAT_BLOCK_AT = 3
/** after this many consecutive blocks of the same series the message switches
 *  to a hard stop — weak models keep retrying past a plain correction */
export const REPEAT_STOP_AFTER = 3

export type RepeatDecision =
  | { kind: "block" | "stop"; message: string }
  | { kind: "override" }

/**
 * Repeat channel: a call matching a live tail series at the block threshold is
 * hard-stopped — one more identical repeat and the provider kills the session
 * with a 400. MUTATES event.args: the internal marker keys are deleted (they
 * must never reach the tool or a signature). An "override" decision is NOT a
 * pass-through verdict — the caller must continue with normal gate processing.
 */
export async function repeatSeriesDecision(event: NormalizedEvent, ctx: EnforceContext): Promise<RepeatDecision | null> {
  const rawArgs = event.args
  const bypass =
    rawArgs[REPEAT_PROCEED] === true ||
    (typeof rawArgs.command === "string" && /#[ \t]*dejavu:proceed\b/.test(stripQuotedSpans(rawArgs.command)))
  delete rawArgs[REPEAT_MARKER]
  delete rawArgs[REPEAT_PROCEED]
  const entry = ctx.ephemeral.repeatSeries.get(event.sessionId)
  if (entry === undefined || entry.length < REPEAT_BLOCK_AT - 1 || signRepeatedCall(event.tool, rawArgs) !== entry.key) return null
  if (bypass) {
    await ctx.stores.logAll({ type: "override", key: entry.key.slice(0, 80), tool: event.tool, session: event.sessionId, project: ctx.projectDir, repeatCount: entry.length })
    return { kind: "override" }
  }
  entry.blocked += 1
  await ctx.stores.logAll({ type: "repeat-blocked", key: entry.key.slice(0, 80), tool: event.tool, session: event.sessionId, project: ctx.projectDir, repeatCount: entry.length })
  if (entry.blocked >= REPEAT_STOP_AFTER) {
    return {
      kind: "stop",
      message: `[dejavu] REPEAT STOP — this exact call has been blocked ${entry.blocked} times in a row; it will not succeed in this session no matter how many times you retry.\nSTOP this line of work entirely: do not re-issue the call, do not rename it, do not work around it. Finish with what you already have and report partial results to whoever launched you.`,
    }
  }
  return {
    kind: "block",
    message: `[dejavu] REPEAT BLOCKED — this would be identical call #${entry.length + 1} in a row; DashScope hard-rejects consecutive identical tool calls (HTTP 400) and the session is one repeat away from dying.\nCORRECTION: change the args (readers: since_message_id / from_end / limit) or take a different approach entirely; do not re-issue this call unchanged.\nEVIDENCE: ${entry.length} consecutive identical calls already in this session's history.\nBypass (logged): _dejavu_proceed: true in the call args (or the trailing "# dejavu:proceed" comment for bash).`,
  }
}
