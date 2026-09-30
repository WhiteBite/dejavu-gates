/**
 * Shared adapter primitives: harness tool-name → internal vocabulary mapping,
 * argument-field normalization, and the universal outbound decision dialects.
 * Internal tool names are exactly what callSignature() understands — anything
 * unmapped passes through and yields a null signature (the engine then allows).
 */
import type { HarnessName, HookPhase, OutboundDecision, Verdict } from "../types"
import { PROBE_TOOLS } from "../patterns"

/** per-harness tool-name aliases, keyed by the LOWERCASED harness tool name */
const TOOL_ALIASES: Record<HarnessName, Record<string, string>> = {
  opencode: {},
  claude: {},
  codex: { shell: "bash", apply_patch: "edit" },
  gemini: {
    run_shell_command: "bash",
    read_file: "read",
    write_file: "write",
    replace: "edit",
    search_file_content: "grep",
  },
  cursor: {},
  copilot: { powershell: "bash", view: "read" },
  crush: { multiedit: "edit" },
  devin: { exec: "bash", apply_patch: "edit" },
  kiro: { shell: "bash" },
  cline: { execute_command: "bash", read_file: "read", write_to_file: "write", apply_patch: "edit" },
}

/** Map a harness tool name to the internal vocabulary ("bash"/"read"/"edit"/"write"/"glob"/"grep"). */
export function internalTool(harness: HarnessName, tool: string): string {
  const lower = tool.toLowerCase()
  return TOOL_ALIASES[harness][lower] ?? lower
}

/** Normalize harness argument field names to the shapes callSignature() reads. */
export function internalArgs(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "read":
    case "edit":
    case "write": {
      const filePath = raw.filePath ?? raw.file_path ?? raw.path ?? raw.target_file
      return typeof filePath === "string" ? { filePath } : {}
    }
    case "glob":
    case "grep": {
      const pattern = raw.pattern
      return typeof pattern === "string" ? { pattern } : {}
    }
    case "bash": {
      const command = raw.command
      return typeof command === "string" ? { command } : {}
    }
    default:
      return raw
  }
}

/** Safe string field extraction from an unknown JSON object. */
export function str(obj: unknown, key: string): string | null {
  if (typeof obj !== "object" || obj === null) return null
  const value = (obj as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

/** Safe nested-object field extraction from an unknown JSON object. */
export function rec(obj: unknown, key: string): Record<string, unknown> | null {
  if (typeof obj !== "object" || obj === null) return null
  const value = (obj as Record<string, unknown>)[key]
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

/** Safe integer field extraction (exit codes, when a harness ever provides one). */
export function num(obj: unknown, key: string): number | null {
  if (typeof obj !== "object" || obj === null) return null
  const value = (obj as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

/** session id fallback — the engine keys session state on this string */
export const UNKNOWN_SESSION = "unknown"

/** Extract output text from a post-hook payload field: string, array of lines, or {stdout,stderr} object. */
export function extractOutput(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value
  if (Array.isArray(value)) return value.map(String).join("\n") || null
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const parts: string[] = []
    const stdout = str(obj, "stdout")
    const stderr = str(obj, "stderr")
    if (stdout !== null) parts.push(stdout)
    if (stderr !== null) parts.push(stderr)
    if (parts.length > 0) return parts.join("\n")
    return JSON.stringify(value)
  }
  return null
}

/** True when the payload explicitly marks a failed call (failure event, `error`, `is_error`/`status`). */
export function errorSignalled(r: Record<string, unknown>, response: unknown = undefined): boolean {
  const hookEvent = str(r, "hook_event_name") ?? str(r, "hookEventName")
  if (hookEvent !== null && /fail/i.test(hookEvent)) return true
  if (str(r, "error") !== null) return true
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>
    if (obj.is_error === true || obj.isError === true) return true
    if (typeof obj.status === "string" && /error|fail/i.test(obj.status)) return true
    if (str(obj, "error") !== null) return true
  }
  return false
}

/** A successful generic result is CONTENT, not command output — only error-signalled calls feed the scan. */
export function genericToolOutput(tool: string, output: string | null, errored: boolean): string | null {
  if (tool === "bash" || PROBE_TOOLS.has(tool)) return output
  return errored ? output : null
}

/** Universal allow: empty JSON on stdout, exit 0. */
export function allowDecision(): OutboundDecision {
  return { json: {}, exitCode: 0, stderr: null }
}

/** Universal deny: exit 2 + stderr — every supported harness feeds stderr back
 * to the model as the block reason (verified per harness in the contract docs). */
export function denyDecision(reason: string): OutboundDecision {
  return { json: {}, exitCode: 2, stderr: reason }
}

/** Shared mapOutbound skeleton: post never blocks (annotation rides on allow);
 * pre AND session-event share the deny/allow path. Optional `allow` overrides default. */
export function makeOutbound(dialect: {
  deny: (reason: string) => OutboundDecision
  annotate: ((annotation: string) => OutboundDecision) | null
  allow?: () => OutboundDecision
}): (phase: HookPhase, verdict: Verdict) => OutboundDecision {
  return (phase, verdict) => {
    if (phase === "post") {
      if (verdict.annotation !== null && dialect.annotate !== null) return dialect.annotate(verdict.annotation)
      return dialect.allow?.() ?? allowDecision()
    }
    if (verdict.action === "deny") return dialect.deny(verdict.reason ?? "[dejavu] BLOCKED")
    return dialect.allow?.() ?? allowDecision()
  }
}
