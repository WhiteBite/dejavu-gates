/**
 * GitHub Copilot CLI hook adapter — detects which of Copilot's two payload
 * casings a raw event belongs to and normalizes it to the shared contract.
 *
 * Casing A (camelCase): `toolName` string present → pre/postToolUse.
 *   toolArgs is a JSON STRING that must be parsed (try/catch → {} on failure).
 *   Post carries `toolResult.textResultForLlm` (+ optional `error`).
 * Casing B (PascalCase, CC-compatible): `tool_name` string present → pre/
 *   postToolUse / postToolUseFailure. tool_input is a plain object.
 *   Post carries `tool_response`.
 *
 * Both map via internalTool + internalArgs; sessionId from sessionId|session_id;
 * callId always null (Copilot exposes no per-call id); exitCode null, channel "text".
 */
import type { HarnessAdapter, NormalizedEvent } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, makeOutbound, errorSignalled, extractOutput, genericToolOutput } from "./shared"

/** Parse toolArgs JSON string → object; returns {} on any parse failure. */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  const s = str(raw, "toolArgs")
  if (s === null) return {}
  try {
    const parsed = JSON.parse(s)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  }
  catch {
    return {}
  }
}

export const copilotAdapter: HarnessAdapter = {
  name: "copilot",
  postChannel: true,

  mapInbound(phase: "pre" | "post" | "session-event", raw: unknown): NormalizedEvent | null {
    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    // session-event has no inbound mapping for Copilot
    if (phase === "session-event") return null

    const r = raw as Record<string, unknown>

    // Detect casing A: camelCase — top-level `toolName` string
    const toolNameCamel = str(r, "toolName")
    if (toolNameCamel !== null) {
      const toolMapped = internalTool("copilot", toolNameCamel)
      const sessionId = str(r, "sessionId") ?? UNKNOWN_SESSION
      const cwd = str(r, "cwd")

      if (phase === "pre") {
        return {
          harness: "copilot",
          phase,
          tool: toolMapped,
          args: internalArgs(toolMapped, parseToolArgs(r)),
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
        const toolResult = rec(r, "toolResult")
        const errored = errorSignalled(r, toolResult)
        let output = extractOutput(toolResult?.textResultForLlm)
        // Append error string when present (failure event)
        const errorText = str(r, "error")
        if (errorText !== null) {
          output = output ? `${output}\n${errorText}` : errorText
        }
        return {
          harness: "copilot",
          phase,
          tool: toolMapped,
          args: internalArgs(toolMapped, parseToolArgs(r)),
          sessionId,
          callId: null,
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

    // Detect casing B: PascalCase (CC-compatible) — top-level `tool_name` string
    const toolNamePascal = str(r, "tool_name")
    if (toolNamePascal !== null) {
      const toolMapped = internalTool("copilot", toolNamePascal)
      const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
      const cwd = str(r, "cwd")

      if (phase === "pre") {
        return {
          harness: "copilot",
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
      }

      if (phase === "post") {
        const errored = errorSignalled(r, r.tool_response)
        let output = extractOutput(r.tool_response)
        // Append error string when present (failure event)
        const errorText = str(r, "error")
        if (errorText !== null) {
          output = output ? `${output}\n${errorText}` : errorText
        }
        return {
          harness: "copilot",
          phase,
          tool: toolMapped,
          args: internalArgs(toolMapped, rec(r, "tool_input") ?? {}),
          sessionId,
          callId: null,
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

    // Neither casing detected — unrecognized payload
    return null
  },

  mapOutbound: makeOutbound({
    deny: (reason) => ({
      json: { permissionDecision: "deny", permissionDecisionReason: reason },
      exitCode: 0,
      stderr: null,
    }),
    annotate: (annotation) => ({
      json: { additionalContext: annotation.slice(0, 10000) },
      exitCode: 0,
      stderr: null,
    }),
  }),
}
