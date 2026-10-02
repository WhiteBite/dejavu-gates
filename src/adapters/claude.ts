/**
 * Claude Code hook adapter — normalizes Claude Code's snake_case hook payloads
 * to the shared NormalizedEvent contract and maps verdicts back to the
 * documented Claude dialect (exit-2 + stderr for deny, JSON with
 * hookSpecificOutput for annotation).
 */
import type { HarnessAdapter, NormalizedEvent } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, denyDecision, makeOutbound, errorSignalled, extractOutput, genericToolOutput } from "./shared"

export const claudeAdapter: HarnessAdapter = {
  name: "claude",
  postChannel: true,

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    const r = raw as Record<string, unknown>

    // SessionEnd is session teardown, not a tool call — cleanup-only, nothing to record
    if (phase === "session-event") {
      if (str(r, "hook_event_name") !== "SessionEnd") return null
      const sessionId = str(r, "session_id")
      if (sessionId === null || sessionId === "") return null
      return {
        harness: "claude",
        phase,
        tool: "session",
        args: {},
        sessionId,
        callId: null,
        cwd: str(r, "cwd"),
        output: null,
        exitCode: null,
        channel: "event",
        raw,
      }
    }

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
      const errored = errorSignalled(r, toolResponse)
      let output = extractOutput(toolResponse)

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
        output: genericToolOutput(toolMapped, output, errored),
        exitCode: null,
        channel: "text",
        errored,
        raw,
      }
    }

    return null
  },

  mapOutbound: makeOutbound({
    deny: (reason) => denyDecision(reason),
    annotate: (annotation) => ({
      json: {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: annotation.slice(0, 10000),
        },
      },
      exitCode: 0,
      stderr: null,
    }),
  }),
}
