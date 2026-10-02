import type { HarnessAdapter, NormalizedEvent } from "../types"
import { denyDecision, extractOutput, internalArgs, internalTool, makeOutbound, rec, str, UNKNOWN_SESSION, errorSignalled, genericToolOutput } from "./shared"

const DEVIN_EVENTS = new Set(["PreToolUse", "PostToolUse"])

/** Devin CLI hook adapter: Claude wire dialect (exit-2 deny, hookSpecificOutput annotate) over .devin/hooks.v1.json root events. */
export const devinAdapter: HarnessAdapter = {
  name: "devin",
  postChannel: true,

  mapInbound(phase, raw) {
    if (typeof raw !== "object" || raw === null) return null
    if (phase === "session-event") return null
    const r = raw as Record<string, unknown>
    const toolName = str(r, "tool_name")
    if (toolName === null) return null
    const hookEvent = str(r, "hook_event_name")
    const recognized = (hookEvent !== null && DEVIN_EVENTS.has(hookEvent)) || (rec(r, "tool_input") !== null && str(r, "session_id") !== null)
    if (!recognized) return null
    const toolMapped = internalTool("devin", toolName)
    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const cwd = str(r, "cwd")
    const args = internalArgs(toolMapped, rec(r, "tool_input") ?? {})
    if (phase === "pre") {
      return {
        harness: "devin",
        phase,
        tool: toolMapped,
        args,
        sessionId,
        callId: null,
        cwd,
        output: null,
        exitCode: null,
        channel: "text",
        raw,
      }
    }
    const errored = errorSignalled(r, r.tool_response)
    let output = extractOutput(r.tool_response)
    const errorText = str(r, "error")
    if (errorText !== null) output = output === null ? errorText : `${output}\n${errorText}`
    return {
      harness: "devin",
      phase,
      tool: toolMapped,
      args,
      sessionId,
      callId: null,
      cwd,
      output: genericToolOutput(toolMapped, output, errored),
      exitCode: null,
      channel: "text",
      errored,
      raw,
    }
  },

  mapOutbound: makeOutbound({
    deny: (reason) => denyDecision(reason),
    annotate: (annotation) => ({
      json: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: annotation.slice(0, 10000) } },
      exitCode: 0,
      stderr: null,
    }),
  }),
}
