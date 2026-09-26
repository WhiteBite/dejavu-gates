/**
 * Shared adapter primitives: harness tool-name → internal vocabulary mapping,
 * argument-field normalization, and the universal outbound decision dialects.
 * Internal tool names are exactly what callSignature() understands — anything
 * unmapped passes through and yields a null signature (the engine then allows).
 */
import type { HarnessName, OutboundDecision } from "../types"

/** per-harness tool-name aliases, keyed by the LOWERCASED harness tool name */
const TOOL_ALIASES: Record<HarnessName, Record<string, string>> = {
  opencode: {},
  claude: {},
  codex: { shell: "bash" },
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

/** Universal allow: empty JSON on stdout, exit 0. */
export function allowDecision(): OutboundDecision {
  return { json: {}, exitCode: 0, stderr: null }
}

/** Universal deny: exit 2 + stderr — every supported harness feeds stderr back
 * to the model as the block reason (verified per harness in the contract docs). */
export function denyDecision(reason: string): OutboundDecision {
  return { json: {}, exitCode: 2, stderr: reason }
}
