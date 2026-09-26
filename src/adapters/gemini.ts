/**
 * Gemini CLI hook adapter — normalizes Gemini CLI's snake_case hook payloads
 * to the shared NormalizedEvent contract and maps verdicts back to the
 * documented Gemini dialect (exit-2 + stderr for deny, JSON with
 * hookSpecificOutput for annotation).
 */
import type { HarnessAdapter, NormalizedEvent, Verdict, OutboundDecision } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, allowDecision, denyDecision } from "./shared"

/** Extract tool output text from a Gemini AfterTool response object. */
function extractToolText(response: unknown): string | null {
  if (typeof response === "string") return response
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>
    // error field takes priority (explicit failure signal)
    const errorText = str(obj, "error")
    if (errorText) return errorText
    // returnDisplay: string or structured output
    const display = obj.returnDisplay
    if (typeof display === "string") return display
    if (typeof display === "object" && display !== null) return JSON.stringify(display)
    // llmContent: string or structured output
    const content = obj.llmContent
    if (typeof content === "string") return content
    if (typeof content === "object" && content !== null) return JSON.stringify(content)
  }
  return null
}

export const geminiAdapter: HarnessAdapter = {
  name: "gemini",

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    const r = raw as Record<string, unknown>
    const toolName = str(r, "tool_name")

    // tool_name missing or non-string → unrecognized payload
    if (!toolName) return null

    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const cwd = str(r, "cwd")
    const toolMapped = internalTool("gemini", toolName)

    if (phase === "pre") {
      const toolInput = rec(r, "tool_input") ?? {}
      return {
        harness: "gemini",
        phase,
        tool: toolMapped,
        args: internalArgs(toolMapped, toolInput),
        sessionId,
        callId: null,
        cwd,
        output: null,
        exitCode: null,
        channel: "text",
        raw,
      }
    }

    if (phase === "post") {
      const toolResponse = rec(r, "tool_response") ?? {}
      const output = extractToolText(toolResponse) ?? null

      return {
        harness: "gemini",
        phase,
        tool: toolMapped,
        args: internalArgs(toolMapped, rec(r, "tool_input") ?? {}),
        sessionId,
        callId: null,
        cwd,
        output,
        exitCode: null,
        channel: "text",
        raw,
      }
    }

    // session-event: Gemini has no such channel
    return null
  },

  mapOutbound(phase: "pre" | "post" | "session-event", verdict: Verdict): OutboundDecision {
    // post: the call already ran — annotation rides on it, a post is never a block
    if (phase === "post") {
      if (verdict.annotation === null) return allowDecision()
      return {
        json: {
          hookSpecificOutput: {
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
