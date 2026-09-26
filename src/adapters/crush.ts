/**
 * Crush (charmbracelet) hook adapter — PreToolUse only.
 *
 * Crush exposes a single pre-hook channel; there is no post/session-event
 * hook upstream (documented as FUTURE in their docs). mapInbound for "post"
 * and "session-event" always returns null; mapOutbound for "post" always
 * returns allowDecision() regardless of verdict (degraded: nothing to
 * annotate). The gate store still protects Crush users via the pre channel
 * and via gates learned in other harnesses on the shared cross-harness store.
 */
import type { HarnessAdapter, NormalizedEvent, Verdict, OutboundDecision } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, allowDecision, denyDecision } from "./shared"

export const crushAdapter: HarnessAdapter = {
  name: "crush",

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    if (typeof raw !== "object" || raw === null) return null

    // Crush has no post / session-event channels — structural no-op
    if (phase !== "pre") return null

    const r = raw as Record<string, unknown>

    // tool_name must be present and non-string → null (unrecognized)
    const toolName = str(r, "tool_name")
    if (toolName === null) return null

    const toolMapped = internalTool("crush", toolName)
    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const cwd = str(r, "cwd")

    return {
      harness: "crush",
      phase,
      tool: toolMapped,
      args: internalArgs(toolMapped, rec(r, "tool_input") ?? {}),
      sessionId,
      callId: null,
      cwd,
      output: null,
      exitCode: null,
      channel: "text",
      raw,
    }
  },

  mapOutbound(phase: "pre" | "post" | "session-event", verdict: Verdict): OutboundDecision {
    // Post phase is degraded — nothing to annotate, always allow
    if (phase !== "pre") return allowDecision()

    if (verdict.action === "allow") return allowDecision()

    // Crush native decision dialect: JSON on stdout, exit 0
    return {
      json: { version: 1, decision: "deny", halt: false, reason: verdict.reason ?? "" },
      exitCode: 0,
      stderr: null,
    }
  },
}
