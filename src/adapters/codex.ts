/**
 * OpenAI Codex CLI hook adapter — maps Codex's PreToolUse/PostToolUse/session-event
 * payloads to the shared NormalizedEvent shape and back to Codex's decision dialect.
 *
 * Inbound: snake_case, mirrors Claude schema; Bash tool fires for shell commands.
 * Outbound: allow → allowDecision(); deny → denyDecision(reason) (exit 2 + stderr);
 *   annotation → `{json: {hookSpecificOutput: {additionalContext: annotation}}, exitCode: 0, stderr: null}`.
 */
import type { HarnessAdapter, HookPhase, NormalizedEvent } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, denyDecision, makeOutbound, errorSignalled, extractOutput, genericToolOutput } from "./shared"

export const codexAdapter: HarnessAdapter = {
  name: "codex",
  postChannel: true,

  mapInbound(phase: HookPhase, raw: unknown): NormalizedEvent | null {
    // session-event phase: no normalization needed
    if (phase === "session-event") return null

    // Reject non-object payloads early — defensive, never throw
    if (typeof raw !== "object" || raw === null) return null

    const r = raw as Record<string, unknown>
    const toolName = str(r, "tool_name")
    if (!toolName) return null

    const tool = internalTool("codex", toolName)
    const sessionId = str(r, "session_id") ?? UNKNOWN_SESSION
    const callId = str(r, "tool_use_id") ?? null
    const cwd = str(r, "cwd")

    if (phase === "pre") {
      const toolInput = rec(r, "tool_input") ?? {}
      return {
        harness: "codex",
        phase,
        tool,
        args: internalArgs(tool, toolInput),
        sessionId,
        callId,
        cwd,
        output: null,
        exitCode: null,
        channel: "text",
        raw,
      }
    }

    // post phase
    const toolResponse = r.tool_response
    const errored = errorSignalled(r, toolResponse)
    return {
      harness: "codex",
      phase,
      tool,
      args: internalArgs(tool, rec(r, "tool_input") ?? {}),
      sessionId,
      callId,
      cwd,
      output: genericToolOutput(tool, extractOutput(toolResponse), errored),
      exitCode: null,
      channel: "text",
      errored,
      raw,
    }
  },

  mapOutbound: makeOutbound({
    deny: (reason) => denyDecision(reason),
    annotate: (annotation) => ({
      json: { hookSpecificOutput: { additionalContext: annotation.slice(0, 10000) } },
      exitCode: 0,
      stderr: null,
    }),
  }),
}
