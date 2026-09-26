/**
 * Claude Code hook adapter — normalizes Claude Code's snake_case hook payloads
 * to the shared NormalizedEvent contract and maps verdicts back to the
 * documented Claude dialect (exit-2 + stderr for deny, JSON with
 * hookSpecificOutput for annotation).
 */
import type { HarnessAdapter, NormalizedEvent, Verdict, OutboundDecision } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, allowDecision, denyDecision } from "./shared"

/** Extract tool output text from a PostToolUse response payload. */
function extractToolText(response: unknown): string | null {
  if (typeof response === "string") return response
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>
    const stdout = str(obj, "stdout")
    const stderr = str(obj, "stderr")
    const parts: string[] = []
    if (stdout) parts.push(stdout)
    if (stderr) parts.push(stderr)
    if (parts.length > 0) return parts.join("\n")
    return JSON.stringify(obj)
  }
  return null
}

export const claudeAdapter: HarnessAdapter = {
  name: "claude",

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    const r = raw as Record<string, unknown>
    const toolName = str(r, "tool_name")

    // tool_name missing or non-string → unrecognized payload
    if (!toolName) return null

    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const callId = str(r, "tool_use_id") ?? null
    const cwd = str(r, "cwd")
    const toolMapped = internalTool("claude", toolName)

    if (phase === "pre") {
      const toolInput = rec(r, "tool_input") ?? {}
      return {
        harness: "claude",
        phase,
        tool: toolMapped,
        args: internalArgs(toolMapped, toolInput),
        sessionId,
        callId,
        cwd,
        output: null,
        exitCode: null,
        channel: "text",
        raw,
      }
    }

    if (phase === "post") {
      const toolResponse = r.tool_response
      let output = extractToolText(toolResponse) ?? null

      // PostToolUseFailure carries an `error` field — append after response text
      const errorText = str(r, "error")
      if (errorText) {
        output = output ? output + "\n" + errorText : errorText
      }

      return {
        harness: "claude",
        phase,
        tool: toolMapped,
        args: internalArgs(toolMapped, rec(r, "tool_input") ?? {}),
        sessionId,
        callId,
        cwd,
        output,
        exitCode: null,
        channel: "text",
        raw,
      }
    }

    // session-event: Claude has no such channel
    return null
  },

  mapOutbound(phase: "pre" | "post" | "session-event", verdict: Verdict): OutboundDecision {
    // post: the call already ran — annotation rides on it, a post is never a block
    if (phase === "post") {
      if (verdict.annotation === null) return allowDecision()
      return {
        json: {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: verdict.annotation.slice(0, 10000),
          },
        },
        exitCode: 0,
        stderr: null,
      }
    }
    // pre: deny blocks the call (exit-2 + stderr dialect), allow passes it through
    if (verdict.action === "deny") return denyDecision(verdict.reason ?? "")
    return allowDecision()
  },
}
