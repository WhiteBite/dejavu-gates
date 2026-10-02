/**
 * Hook-config machinery for the installer: harness targets, template loading
 * with {{CLI}} substitution, idempotent merge/strip, atomic writes, and
 * marker-based harness auto-detection. Relocated from scripts/install-hooks.ts.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ntPath } from "./fs"
import { collectCommands as kitCollectCommands, mergeHooks, renderTemplate, type MergeShape } from "./kit"

export type Harness = "claude" | "codex" | "gemini" | "cursor" | "copilot" | "crush" | "devin" | "kiro"

export type Json = Record<string, unknown>

interface HarnessSpec {
  readonly project: string
  /** user-scope path; absent when the harness has no documented user scope */
  readonly user?: string
  /** false = standalone dejavu-owned file: overwrite, never merge */
  readonly merge: boolean
  /** true = the config root IS the hook event map (no "hooks" wrapper) */
  readonly rootHooks?: boolean
  readonly note?: string
}

export const HARNESSES: Record<Harness, HarnessSpec> = {
  claude: { project: ".claude/settings.json", user: ".claude/settings.json", merge: true },
  codex: {
    project: ".codex/hooks.json",
    user: ".codex/hooks.json",
    merge: true,
    note: "codex: hooks are enabled by default; the first run may require a trust prompt for project hooks",
  },
  gemini: { project: ".gemini/settings.json", user: ".gemini/settings.json", merge: true },
  cursor: { project: ".cursor/hooks.json", user: ".cursor/hooks.json", merge: true },
  copilot: { project: ".github/hooks/dejavu.json", user: ".copilot/hooks/dejavu.json", merge: false },
  crush: {
    project: ".crush/crush.json",
    user: ".config/crush/crush.json",
    merge: true,
    note: "crush: no AfterTool hook exists - failure observation is degraded (pre-tool only)",
  },
  devin: {
    project: ".devin/hooks.v1.json",
    merge: true,
    rootHooks: true,
    note: "devin: hooks also auto-import from .claude/settings.json (read_config_from.claude) - a Claude install already gates Devin sessions",
  },
  kiro: { project: ".kiro/hooks/dejavu-gates.json", merge: false },
}

/** import.meta.dir is a Bun extension absent from @types/node. */
const SRC_DIR = (import.meta as ImportMeta & { dir: string }).dir
const PACKAGE_ROOT = dirname(SRC_DIR).replace(/\\/g, "/")

/** Hook commands invoke bare `bun` (resolved from the harness's PATH) against the absolute cli.ts of THIS install. */
const CLI_COMMAND = `bun "${PACKAGE_ROOT}/src/cli.ts"`

const USER_MARKERS: Record<Harness, readonly string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  gemini: [".gemini"],
  cursor: [".cursor"],
  copilot: [".copilot"],
  crush: [".crush", ".config/crush"],
  devin: [".devin"],
  kiro: [".kiro"],
}

const PROJECT_MARKERS: Record<Harness, readonly string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  gemini: [".gemini"],
  cursor: [".cursor"],
  copilot: [".github/hooks"],
  crush: [".crush", "crush.json"],
  devin: [".devin"],
  kiro: [".kiro"],
}

/** Harnesses whose config dirs/files exist at the chosen scope — intersection of present markers with supported harnesses. */
export function detectHarnesses(user: boolean): Harness[] {
  const base = user ? homedir() : process.cwd()
  const markers = user ? USER_MARKERS : PROJECT_MARKERS
  return (Object.keys(markers) as Harness[]).filter((harness) => markers[harness].some((m) => existsSync(ntPath(join(base, m)))))
}

/** A config file that exists but does not parse — install aborts, check reports broken. */
export class ConfigParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = "ConfigParseError"
  }
}

function bunOnPath(): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { stdio: "ignore" }).status === 0
}

/** Hook commands invoke bare `bun` — it must resolve in the harness's shell PATH. */
export function probeBun(): void {
  if (!bunOnPath()) throw new Error("bun is not on PATH — add bun to PATH so harness-spawned hooks can run")
}

/** Non-fatal probe for read-only subs (uninstall, hooks --check) — they manipulate JSON and stay useful on bun-less machines. */
export function warnIfNoBun(): void {
  if (!bunOnPath()) process.stderr.write("warning: bun is not on PATH — harness-spawned hooks will not run until bun is added to PATH\n")
}

export async function loadTemplate(harness: Harness): Promise<Json> {
  const path = join(PACKAGE_ROOT, "scripts", "templates", `${harness}.json`)
  // {{CLI}} lands inside a JSON string, so the path quotes must arrive JSON-escaped.
  const rendered = renderTemplate(await readFile(ntPath(path), "utf8"), { CLI: CLI_COMMAND })
  const parsed: unknown = JSON.parse(rendered)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`template is not a JSON object: ${path}`)
  return parsed as Json
}

export async function readExisting(path: string): Promise<Json> {
  if (!existsSync(ntPath(path))) return {}
  const raw = await readFile(ntPath(path), "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigParseError(`existing config is not valid JSON: ${path} — aborting, file left untouched`, path)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigParseError(`existing config is not a JSON object: ${path} — aborting, file left untouched`, path)
  }
  return parsed as Json
}

export function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

/** A prior dejavu entry is identified by its command string, in either entry shape. */
export function isDejavuCommand(command: unknown, harness: string): command is string {
  return typeof command === "string" && command.includes("src/cli.ts") && command.includes(`--harness ${harness}`)
}

/** Drift-tolerant variant of isDejavuCommand — survives a moved/corrupted cli path (that IS the drift hooks --check looks for). */
export function isDejavuHookCommand(command: unknown, harness: string): command is string {
  return typeof command === "string" && command.includes("bun ") && command.includes(`--harness ${harness}`) && command.includes(".ts")
}

/** Drop prior dejavu entries from one event array; nested `hooks` groups lose only their dejavu commands (emptied groups drop). */
export function stripDejavu(entries: unknown, harness: string): unknown[] {
  if (!Array.isArray(entries)) return []
  const kept: unknown[] = []
  for (const entry of entries) {
    const record = asRecord(entry)
    if (typeof record.command === "string") {
      if (!isDejavuCommand(record.command, harness)) kept.push(entry)
      continue
    }
    if (Array.isArray(record.hooks)) {
      const inner = record.hooks.filter((hook) => !isDejavuCommand(asRecord(hook).command, harness))
      if (inner.length > 0) kept.push({ ...record, hooks: inner })
      continue
    }
    kept.push(entry)
  }
  return kept
}

/** mergeHooks replaces non-array foreign event values with the template array; the golden suite pins their verbatim survival. */
function restoreForeignEvents(target: Json, source: Json): void {
  for (const [event, value] of Object.entries(source)) {
    if (!Array.isArray(value)) target[event] = value
  }
}

/** Append fresh template entries after stripping prior dejavu ones; unknown fields and foreign hooks survive. */
export function mergeConfig(existing: Json, template: Json, harness: string): Json {
  const merged = mergeHooks(existing, template, { shape: "nested-hooks", isMine: (command) => isDejavuCommand(command, harness) })
  restoreForeignEvents(asRecord(merged.hooks), asRecord(existing.hooks))
  return merged
}

/** Root-hooks variant of mergeConfig: template.hooks entries are merged into the config root as event keys.
 * Foreign root-level keys and custom fields survive. */
export function mergeConfigRoot(existing: Json, template: Json, harness: string): Json {
  const merged = mergeHooks(existing, asRecord(template.hooks), { shape: "root-events", isMine: (command) => isDejavuCommand(command, harness) })
  restoreForeignEvents(merged, existing)
  return merged
}

/** All hook command strings in a config matching the predicate, from both flat and nested entry shapes. */
export function collectCommands(config: Json, match: (command: unknown) => boolean): string[] {
  // kiro configs carry hooks as an entry array, not an event map
  const shape: MergeShape = Array.isArray(config.hooks) ? "hooks-array" : "nested-hooks"
  return kitCollectCommands(config, { shape }).filter((command) => match(command))
}

/** Collect commands from a root-hooks config where event keys sit at the config root. */
export function collectCommandsRoot(config: Json, match: (command: unknown) => boolean): string[] {
  return kitCollectCommands(config, { shape: "root-events" }).filter((command) => match(command))
}

/** Kit collector/drift shape for a harness's hook config. */
export function configShape(harness: Harness): MergeShape {
  if (HARNESSES[harness].rootHooks === true) return "root-events"
  return harness === "kiro" ? "hooks-array" : "nested-hooks"
}
