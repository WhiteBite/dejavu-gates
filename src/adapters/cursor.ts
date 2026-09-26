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
import type { HarnessAdapter, NormalizedEvent, Verdict, OutboundDecision } from "../types"
import { internalTool, internalArgs, str, rec, num, UNKNOWN_SESSION, allowDecision, denyDecision } from "./shared"

/** Extract text from a tool_output value (string | object | null). */
function extractOutput(value: unknown): string | null {
  if (typeof value === "string") return value || null
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
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

export const cursorAdapter: HarnessAdapter = {
  name: "cursor",

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
        return {
          harness: "cursor",
          phase,
          tool: toolMapped,
          args: internalArgs(toolMapped, rec(r, "tool_input") ?? {}),
          sessionId,
          callId,
          cwd,
          output: extractOutput(r.tool_output),
          exitCode: null,
          channel: "text",
          raw,
        }
      }

      return null
    }

    // Neither family detected — unrecognized payload
    return null
  },

  mapOutbound(phase: "pre" | "post" | "session-event", verdict: Verdict): OutboundDecision {
    // post: the call already ran — annotation rides on it, a post is never a block
    if (phase === "post") {
      if (verdict.annotation === null) return allowDecision()
      return {
        json: { additional_context: verdict.annotation },
        exitCode: 0,
        stderr: null,
      }
    }
    // pre: deny blocks via Cursor's native permission JSON (agent_message is model-visible)
    if (verdict.action === "deny") {
      return {
        json: {
          permission: "deny",
          user_message: "[dejavu] repeated failing call blocked",
          agent_message: verdict.reason ?? "[dejavu] BLOCKED",
        },
        exitCode: 0,
        stderr: null,
      }
    }
    return allowDecision()
  },
}
