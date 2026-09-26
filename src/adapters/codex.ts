/**
 * OpenAI Codex CLI hook adapter — maps Codex's PreToolUse/PostToolUse/session-event
 * payloads to the shared NormalizedEvent shape and back to Codex's decision dialect.
 *
 * Inbound: snake_case, mirrors Claude schema; Bash tool fires for shell commands.
 * Outbound: allow → allowDecision(); deny → denyDecision(reason) (exit 2 + stderr);
 *   annotation → `{json: {hookSpecificOutput: {additionalContext: annotation}}, exitCode: 0, stderr: null}`.
 */
import type { HarnessAdapter, HookPhase, NormalizedEvent, OutboundDecision, Verdict } from "../types"
import { internalTool, internalArgs, str, rec, UNKNOWN_SESSION, allowDecision, denyDecision } from "./shared"

/** Build a string output from a generic tool_response value. */
function buildOutput(response: unknown): string | null {
  if (typeof response === "string") return response
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>
    const parts: string[] = []
    const stdout = str(obj, "stdout")
    if (stdout) parts.push(stdout)
    const stderr = str(obj, "stderr")
    if (stderr) parts.push(stderr)
    if (parts.length > 0) return parts.join("\n")
    return JSON.stringify(response)
  }
  return null
}

export const codexAdapter: HarnessAdapter = {
  name: "codex",

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
    return {
      harness: "codex",
      phase,
      tool,
      args: internalArgs(tool, rec(r, "tool_input") ?? {}),
      sessionId,
      callId,
      cwd,
      output: buildOutput(toolResponse),
      exitCode: null,
      channel: "text",
      raw,
    }
  },

  mapOutbound(phase: HookPhase, verdict: Verdict): OutboundDecision {
    if (verdict.action === "allow") return allowDecision()

    // Deny wins over annotation — exit 2 + stderr (verified Codex block dialect)
    if (phase === "pre") return denyDecision(verdict.reason ?? "[dejavu] BLOCKED")

    // Post-hook: annotation rides on stdout with exit 0
    if (verdict.annotation != null) {
      return {
        json: { hookSpecificOutput: { additionalContext: verdict.annotation } },
        exitCode: 0,
        stderr: null,
      }
    }

    return denyDecision(verdict.reason ?? "[dejavu] BLOCKED")
  },
}
