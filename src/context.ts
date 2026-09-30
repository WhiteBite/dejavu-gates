import { scrubSecrets } from "./patterns"
import type { Stores } from "./store"
import type { Verdict } from "./types"

// --- Tunables ---------------------------------------------------------------

/** handled part IDs are capped FIFO-style */
const HANDLED_CAP = 5000
const HANDLED_KEEP = 2500
/** pendingCalls capped — aborted calls never reach the after-hook, so a cap bounds the fallback map */
const PENDING_CAP = 1000
/** cross-channel dedup window: the same (key, session) recorded by two DIFFERENT
 *  detection channels within this span is one call double-firing, not two failures */
const CROSS_CHANNEL_WINDOW_MS = 2000
/** recentRecords is bounded FIFO-style like handledParts */
const RECENT_RECORDS_CAP = 1000
const RECENT_RECORDS_KEEP = 500
/** a gate reminded this many times with ZERO in-session reoffense has taught its
 *  lesson — the agent changed behavior, so no success can ever heal it */
export const TAUGHT_REMINDERS = 5
/** anti-nag retirement (the negative twin of taught): a gate reminded this many
 *  times whose reminders are CONSISTENTLY IGNORED is nagging, not teaching */
export const ANTI_NAG_REMINDERS = 5
export const ANTI_NAG_REOFFENSE = 3

/** repeat channel: per-session live tail series + log watermark + consecutive block count */
export interface RepeatEntry {
  key: string
  length: number
  logged: number
  blocked: number
}

/** In-process (non-persisted) engine state. See createEphemeralState for the
 *  degradation contract of short-lived hosts. */
export interface EphemeralState {
  /** callID -> signature fallback when the after-hook does not receive args */
  pendingCalls: Map<string, string>
  /** repeat channel: sessionID → live tail series; written by the payload-transform
   *  side (host-specific), read by the before-hook block */
  repeatSeries: Map<string, RepeatEntry>
  /** repeat channel: per-session watermark for windowed-repeat NOTE logging */
  repeatWindowLogged: Map<string, number>
  /** loop-break: session:seriesKey pairs that already logged an injection */
  loopBreakInjected: Set<string>
  /** iteration discriminator: projectDir → count of landed edit/write calls;
   *  a failure with a moved version is debugging, not a blind retry */
  workspaceVersions: Map<string, number>
  /** message part IDs already counted as tool-level errors */
  handledParts: Set<string>
  /** (key|session) -> last recording channel/time, for the cross-channel dedup */
  recentRecords: Map<string, { ts: number; channel: string }>
}

/**
 * Fresh in-process state. A long-lived host (the OpenCode plugin process)
 * creates ONE instance and threads it through every hook call. A short-lived
 * CLI host (one process per hook event) creates a fresh empty one per
 * invocation — a DESIGNED degradation, not a bug: repeat-series blocking,
 * the pendingCalls args fallback, the cross-channel dedup window and the
 * iteration discriminator then weaken to the single call the process serves.
 * Gate enforcement itself stays fully multi-window/multi-process safe because
 * the remind→block chain is persisted ON THE GATE (remindedSessions /
 * failedSessions) and always read fresh under the store lock.
 */
export function createEphemeralState(): EphemeralState {
  return {
    pendingCalls: new Map(),
    repeatSeries: new Map(),
    repeatWindowLogged: new Map(),
    loopBreakInjected: new Set(),
    workspaceVersions: new Map(),
    handledParts: new Set(),
    recentRecords: new Map(),
  }
}

/** Everything the enforcement engine needs injected by the host harness. */
export interface EnforceContext {
  /** two-scope gate stores (project + global) */
  stores: Stores
  /** in-process state — one instance per process, see createEphemeralState */
  ephemeral: EphemeralState
  /** host logging sink (OpenCode: client.app.log wrapper; CLI: stderr or noop).
   *  Must never throw. May return a promise; the engine awaits it. */
  log: (service: string, level: string, message: string) => void | Promise<void>
  /** hook-error sink: engine bugs are swallowed by the caller to protect the
   *  tool pipeline, but must stay visible (OpenCode rate-limits this) */
  onHookError: (where: string, error: unknown) => void
  /** os platform ("win32" | "linux" | ...) — reserved for platform-conditional guards */
  platform: string
  /** project directory whose .opencode/dejavu store is in scope ("" = global only) */
  projectDir: string
}

/** Before-hook result: the caller decides how a deny reaches the model
 *  (OpenCode: throw GateSignal; CLI: harness-specific block dialect). */
export interface BeforeOutcome {
  verdict: Verdict
  /** which mechanism produced a deny — informational for logging/metrics */
  signalKind: "block" | "reminder" | "guard" | "repeat" | null
}

/** After-hook result. */
export interface AfterOutcome {
  /** reminder NOTE the caller appends/attaches to the tool output */
  annotation: string | null
  /** true when a failure was recorded and escalation bookkeeping ran */
  recorded: boolean
}

/** Cross-channel double-count guard: the same (key, session) recorded by a
 *  DIFFERENT channel inside the window is one call double-firing — count once. */
export function isCrossChannelDuplicate(eph: EphemeralState, key: string, session: string, channel: string): boolean {
  const k = `${key}|${session}`
  const now = Date.now()
  const prev = eph.recentRecords.get(k)
  const duplicate = prev !== undefined && prev.channel !== channel && now - prev.ts <= CROSS_CHANNEL_WINDOW_MS
  eph.recentRecords.set(k, { ts: now, channel })
  if (eph.recentRecords.size > RECENT_RECORDS_CAP) {
    let drop = eph.recentRecords.size - RECENT_RECORDS_KEEP
    for (const rk of eph.recentRecords.keys()) {
      if (drop <= 0) break
      eph.recentRecords.delete(rk)
      drop -= 1
    }
  }
  return duplicate
}

/** Remember a call's signature for the after-hook args fallback (FIFO-capped). */
export function trackPendingCall(eph: EphemeralState, callId: string, signature: string): void {
  eph.pendingCalls.set(callId, signature)
  while (eph.pendingCalls.size > PENDING_CAP) {
    const oldest = eph.pendingCalls.keys().next()
    if (oldest.done) break
    eph.pendingCalls.delete(oldest.value)
  }
}

/** returns true when this part was already counted as a tool-level error */
export function partAlreadyHandled(eph: EphemeralState, partId: string): boolean {
  if (eph.handledParts.has(partId)) return true
  eph.handledParts.add(partId)
  if (eph.handledParts.size > HANDLED_CAP) {
    eph.handledParts = new Set([...eph.handledParts].slice(-HANDLED_KEEP))
  }
  return false
}

/** secret-scrub the free-form text args before they feed signatures */
export function scrubbedArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.command === "string") return { ...args, command: scrubSecrets(args.command) }
  if (typeof args.pattern === "string") return { ...args, pattern: scrubSecrets(args.pattern) }
  return args
}
