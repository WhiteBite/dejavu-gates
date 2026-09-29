/**
 * Hook-config machinery for the installer: harness targets, template loading
 * with {{CLI}} substitution, idempotent merge/strip, atomic writes, and
 * marker-based harness auto-detection. Relocated from scripts/install-hooks.ts.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Harness = "claude" | "codex" | "gemini" | "cursor" | "copilot" | "crush"

export type Json = Record<string, unknown>

export interface HarnessSpec {
  readonly project: string
  /** user-scope path; absent when the harness has no documented user scope */
  readonly user?: string
  /** false = standalone dejavu-owned file: overwrite, never merge */
  readonly merge: boolean
  readonly note?: string
}

export const HARNESSES: Record<Harness, HarnessSpec> = {
  claude: { project: ".claude/settings.json", user: ".claude/settings.json", merge: true },
  codex: {
    project: ".codex/hooks.json",
    user: ".codex/hooks.json",
    merge: true,
    note: "codex: enable hooks via [features] hooks = true in config.toml; the first run requires /hooks trust",
  },
  gemini: { project: ".gemini/settings.json", user: ".gemini/settings.json", merge: true },
  cursor: { project: ".cursor/hooks.json", user: ".cursor/hooks.json", merge: true },
  copilot: { project: ".github/hooks/dejavu.json", user: ".copilot/hooks/dejavu.json", merge: false },
  crush: {
    project: ".crush/crush.json",
    user: ".config/crush/crush.json",
    merge: true,
    note: "crush: no AfterTool hook exists — failure observation is degraded (pre-tool only)",
  },
}

/** import.meta.dir is a Bun extension absent from @types/node. */
const SRC_DIR = (import.meta as ImportMeta & { dir: string }).dir
export const PACKAGE_ROOT = dirname(SRC_DIR).replace(/\\/g, "/")

/** Hook commands invoke bare `bun` (resolved from the harness's PATH) against the absolute cli.ts of THIS install. */
export const CLI_COMMAND = `bun "${PACKAGE_ROOT}/src/cli.ts"`

const USER_MARKERS: Record<Harness, readonly string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  gemini: [".gemini"],
  cursor: [".cursor"],
  copilot: [".copilot"],
  crush: [".crush", ".config/crush"],
}

const PROJECT_MARKERS: Record<Harness, readonly string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  gemini: [".gemini"],
  cursor: [".cursor"],
  copilot: [".github"],
  crush: [".crush", "crush.json"],
}

/** Harnesses whose config dirs/files exist at the chosen scope — intersection of present markers with supported harnesses. */
export function detectHarnesses(user: boolean): Harness[] {
  const base = user ? homedir() : process.cwd()
  const markers = user ? USER_MARKERS : PROJECT_MARKERS
  return (Object.keys(markers) as Harness[]).filter((harness) => markers[harness].some((m) => existsSync(join(base, m))))
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
  const substituted = (await readFile(path, "utf8")).replaceAll("{{CLI}}", CLI_COMMAND.replaceAll(`"`, `\\"`))
  const parsed: unknown = JSON.parse(substituted)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`template is not a JSON object: ${path}`)
  return parsed as Json
}

export async function readExisting(path: string): Promise<Json> {
  if (!existsSync(path)) return {}
  const raw = await readFile(path, "utf8")
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

/** Append fresh template entries after stripping prior dejavu ones; unknown fields and foreign hooks survive. */
export function mergeConfig(existing: Json, template: Json, harness: string): Json {
  const merged: Json = { ...existing }
  for (const [key, value] of Object.entries(template)) {
    if (key !== "hooks" && !(key in merged)) merged[key] = value
  }
  const mergedHooks: Json = { ...asRecord(merged.hooks) }
  for (const [event, entries] of Object.entries(asRecord(template.hooks))) {
    mergedHooks[event] = [...stripDejavu(mergedHooks[event], harness), ...(Array.isArray(entries) ? entries : [])]
  }
  merged.hooks = mergedHooks
  return merged
}

/** Root-hooks variant of mergeConfig: template.hooks entries are merged into the config root as event keys.
 * Foreign root-level keys and custom fields survive. */
export function mergeConfigRoot(existing: Json, template: Json, harness: string): Json {
  const merged: Json = { ...existing }
  for (const [event, entries] of Object.entries(asRecord(template.hooks))) {
    const existingEntries = merged[event] ?? []
    merged[event] = [...stripDejavu(existingEntries, harness), ...(Array.isArray(entries) ? entries : [])]
  }
  return merged
}

/** All hook command strings in a config matching the predicate, from both flat and nested entry shapes. */
export function collectCommands(config: Json, match: (command: unknown) => boolean): string[] {
  const commands: string[] = []
  const walk = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const record = asRecord(entry)
      if (match(record.command)) commands.push(record.command as string)
      if (Array.isArray(record.hooks)) walk(record.hooks)
    }
  }
  for (const entries of Object.values(asRecord(config.hooks))) walk(entries)
  return commands
}

/** Collect commands from a root-hooks config where event keys sit at the config root. */
export function collectCommandsRoot(config: Json, match: (command: unknown) => boolean): string[] {
  const commands: string[] = []
  const walk = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const record = asRecord(entry)
      if (match(record.command)) commands.push(record.command as string)
      if (Array.isArray(record.hooks)) walk(record.hooks)
    }
  }
  for (const entries of Object.values(config)) {
    if (entries === null || typeof entries !== "object") continue
    if (Array.isArray(entries)) walk(entries)
  }
  return commands
}

/** First .ts script token in a hook command (quoted or bare) — the file whose existence the drift-check verifies. */
export function extractCliPath(command: string): string | null {
  return command.match(/"([^"]+\.ts)"/)?.[1] ?? command.match(/[^\s"]+\.ts/)?.[0] ?? null
}

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])

/** tmp + rename with backoff retry (Windows AV/indexer locks), minimal copy of src/store.ts atomicWrite. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(tmp, content, "utf8")
      await rename(tmp, path)
      return
    } catch (error) {
      const code = (error as { code?: string }).code ?? ""
      if (RETRYABLE.has(code) && attempt < 5) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50 * 2 ** attempt))
        continue
      }
      try {
        await rm(tmp, { force: true })
      } catch {
        // orphan tmp is harmless
      }
      throw error
    }
  }
}
