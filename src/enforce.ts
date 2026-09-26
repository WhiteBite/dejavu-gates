/**
 * Harness-agnostic enforcement engine — the public surface of the cross-harness
 * port. Everything a host needs is re-exported here; the engine imports only
 * node: builtins, ./types, ./patterns, ./store and its own siblings (never a
 * harness SDK). Host contract: build a NormalizedEvent from the native hook
 * payload, call enforceBefore/enforceAfter/recordEventFailure/cleanupSession,
 * and map the returned verdict to the harness's block dialect (the engine never
 * throws for enforcement — verdict.action "deny" carries the verbatim message).
 */
export {
  ANTI_NAG_REOFFENSE,
  ANTI_NAG_REMINDERS,
  TAUGHT_REMINDERS,
  createEphemeralState,
  isCrossChannelDuplicate,
  partAlreadyHandled,
  scrubbedArgs,
  trackPendingCall,
  type AfterOutcome,
  type BeforeOutcome,
  type EnforceContext,
  type EphemeralState,
  type RepeatEntry,
} from "./context"
export { blockMessage, remindMessage, remindNote } from "./messages"
export { guardBypassWarnings, proactiveGuardMessage } from "./guards"
export { REPEAT_BLOCK_AT, REPEAT_STOP_AFTER, repeatSeriesDecision, type RepeatDecision } from "./repeat"
export { enforceBefore } from "./before"
export { enforceAfter } from "./after"
export { cleanupSession, recordEventFailure } from "./event"
