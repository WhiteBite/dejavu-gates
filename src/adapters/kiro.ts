import type { HarnessAdapter, NormalizedEvent } from "../types"
import { denyDecision, extractOutput, internalArgs, internalTool, makeOutbound, rec, str, UNKNOWN_SESSION } from "./shared"

const KIRO_EVENTS = new Set(["pretooluse", "posttooluse"])

/** Kiro hook adapter: Kiro injects a successful hook's stdout into agent context, so allow writes nothing and the NOTE rides raw on stdout. */
export const kiroAdapter: HarnessAdapter = {
  name: "kiro",
  postChannel: true,

  mapInbound(phase, raw) {
    if (typeof raw !== "object" || raw === null) return null
    if (phase === "session-event") return null
    const r = raw as Record<string, unknown>
    const toolName = str(r, "tool_name")
    if (toolName === null) return null
    // config triggers are PascalCase while stdin hook_event_name examples are camelCase
    const hookEvent = str(r, "hook_event_name")?.toLowerCase() ?? null
    const recognized = (hookEvent !== null && KIRO_EVENTS.has(hookEvent)) || (rec(r, "tool_input") !== null && str(r, "session_id") !== null)
    if (!recognized) return null
    const toolMapped = internalTool("kiro", toolName)
    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const cwd = str(r, "cwd")
    const args = internalArgs(toolMapped, rec(r, "tool_input") ?? {})
    if (phase === "pre") {
      return {
        harness: "kiro",
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
    let output = extractOutput(r.tool_response) ?? extractOutput(r.tool_output) ?? extractOutput(r.output)
    const errorText = str(r, "error")
    if (errorText !== null) output = output === null ? errorText : `${output}\n${errorText}`
    return {
      harness: "kiro",
      phase,
      tool: toolMapped,
      args,
      sessionId,
      callId: null,
      cwd,
      output,
      exitCode: null,
      channel: "text",
      raw,
    }
  },

  mapOutbound: makeOutbound({
    deny: (reason) => denyDecision(reason),
    annotate: (annotation) => ({ json: {}, stdoutRaw: annotation.slice(0, 10000), exitCode: 0, stderr: null }),
    allow: () => ({ json: {}, stdoutRaw: "", exitCode: 0, stderr: null }),
  }),
}
