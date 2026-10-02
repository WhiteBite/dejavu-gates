/**
 * Cursor hook adapter — detects which of Cursor's two hook families a payload
 * belongs to and normalizes it to the shared NormalizedEvent contract.
 *
 * Family A (shell events): top-level `command` string → beforeShellExecution /
 *   afterShellExecution. tool = "bash", no exit code, channel "text".
 * Family B (CC-compatible generic): top-level `tool_name` string → preToolUse /
 *   postToolUse. Maps via internalTool + internalArgs, output from tool_output.
 * Unknown shape or session-event phase → null.
 */
import type { HarnessAdapter, NormalizedEvent } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, makeOutbound, errorSignalled, extractOutput, genericToolOutput } from "./shared"

export const cursorAdapter: HarnessAdapter = {
  name: "cursor",
  postChannel: true,

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    // session-event has no inbound mapping for Cursor
    if (phase === "session-event") return null

    const r = raw as Record<string, unknown>

    // Detect family A: shell events — top-level `command` is a string
    const command = str(r, "command")
    if (command !== null) {
      const sessionId = str(r, "conversation_id") ?? UNKNOWN_SESSION
      const callId = str(r, "generation_id") ?? null
      const cwd = str(r, "cwd")

      if (phase === "pre") {
        return {
          harness: "cursor",
          phase,
          tool: "bash",
          args: { command },
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
        return {
          harness: "cursor",
          phase,
          tool: "bash",
          args: { command },
          sessionId,
          callId,
          cwd,
          output: str(r, "output"),
          exitCode: null,
          channel: "text",
          raw,
        }
      }

      return null
    }

    // Detect family B: CC-compatible generic — top-level `tool_name` string
    const toolName = str(r, "tool_name")
    if (toolName !== null) {
      const toolMapped = internalTool("cursor", toolName)
      const sessionId = str(r, "session_id") ?? str(r, "conversation_id") ?? UNKNOWN_SESSION
      const callId = str(r, "tool_use_id") ?? null
      const cwd = str(r, "cwd")

      if (phase === "pre") {
        const toolInput = rec(r, "tool_input") ?? {}
        return {
          harness: "cursor",
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
        const errored = errorSignalled(r, r.tool_output)
        let output = extractOutput(r.tool_output)
        // postToolUseFailure carries an `error` field - append after the output text
        const errorText = str(r, "error")
        if (errorText !== null) output = output === null ? errorText : `${output}\n${errorText}`
        return {
          harness: "cursor",
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
    }

    // Neither family detected — unrecognized payload
    return null
  },

  mapOutbound: makeOutbound({
    deny: (reason) => ({
      json: {
        permission: "deny",
        user_message: "[dejavu] repeated failing call blocked",
        agent_message: reason,
      },
      exitCode: 0,
      stderr: null,
    }),
    annotate: (annotation) => ({
      json: { additional_context: annotation },
      exitCode: 0,
      stderr: null,
    }),
  }),
}
