/**
 * Shared type contract for the cross-harness port of dejavu.
 * Types only — no runtime values, no imports. Adapters construct their own
 * verdicts and decisions from these shapes.
 *
 * Design decisions baked into the contract:
 * (a) unified store — all harnesses share .opencode/dejavu/ per project +
 *     ~/.config/opencode/dejavu/ global (DEJAVU_HOME overrides), so gates
 *     learned in one harness protect all;
 * (b) Crush runs degraded — PreToolUse only, post phase is a no-op;
 * (c) universal block dialect — exit 2 + stderr for harnesses without
 *     JSON-deny, JSON decision otherwise.
 */

/** Which harness produced or will consume this event */
export type HarnessName = "opencode" | "claude" | "codex" | "gemini" | "cursor" | "copilot" | "crush" | "devin" | "kiro"

/** Phase at which the hook fires */
export type HookPhase = "pre" | "post" | "session-event"

/** Unified event shape that every adapter normalizes inbound payloads to */
export interface NormalizedEvent {
  /** harness that produced this event */
  harness: HarnessName
  /** which hook phase fired */
  phase: HookPhase
  /** tool / command name (e.g. "bash", "read", "edit") */
  tool: string
  /** tool arguments as received by the harness */
  args: Record<string, unknown>
  /** current session identifier */
  sessionId: string
  /** unique call identifier within the session, or null when unavailable */
  callId: string | null
  /** working directory of the agent at call time, or null */
  cwd: string | null
  /** tool output text, or null when not yet available (pre-hook) */
  output: string | null
  /** process exit code, or null when the harness never provides it
   * (harnesses like Claude Code never provide exit codes — null means
   * text-only failure detection via output scanning) */
  exitCode: number | null
  /** detection channel: exit-code scan, stdout/stderr text scan, or event stream */
  channel: "exit" | "text" | "event"
  /** original hook payload for adapter-specific fallbacks */
  raw: unknown
}

/** Enforcement decision returned by the core engine */
export interface Verdict {
  /** whether the call is allowed through or denied */
  action: "allow" | "deny"
  /** block message shown to the model, carries the [dejavu] prefix */
  reason: string | null
  /** post-hook note appended/attached to tool output */
  annotation: string | null
  /** true when the harness lacks a channel (e.g. Crush has no post hook) */
  degraded: boolean
}

/** Harness-specific outbound decision for printing to stdout/stderr */
export interface OutboundDecision {
  /** harness-specific decision JSON to print on stdout */
  json: unknown
  /** 0 allow, 2 block-with-stderr dialect */
  exitCode: number
  /** stderr text for block-with-stderr dialect */
  stderr: string | null
  /** raw stdout payload replacing the decision JSON when set — a harness whose context channel is hook stdout */
  stdoutRaw?: string | null
}

/** Adapter between a harness's native hook format and the shared contract */
export interface HarnessAdapter {
  /** canonical name of this harness */
  readonly name: HarnessName
  /** false when the harness has no post-hook channel (e.g. Crush) — annotations are structurally impossible; detection still runs so the shared store learns */
  readonly postChannel: boolean
  /** normalize an inbound raw payload to the shared event shape
   * returns null when the payload is unrecognized (CLI no-ops) */
  mapInbound(phase: HookPhase, raw: unknown): NormalizedEvent | null
  /** translate a core verdict into harness-specific stdout/stderr output */
  mapOutbound(phase: HookPhase, verdict: Verdict): OutboundDecision
}
