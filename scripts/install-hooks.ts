/**
 * Install dejavu hook configs into agent harnesses. Settings-style targets are
 * merged (prior dejavu entries replaced, everything else preserved); copilot's
 * standalone namespaced file is overwritten instead.
 *
 * Usage: bun scripts/install-hooks.ts --harness <name> [--user|--project] [--dry-run]
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type Harness = "claude" | "codex" | "gemini" | "cursor" | "copilot" | "crush"

type Json = Record<string, unknown>

interface HarnessSpec {
  readonly project: string
  readonly user: string
  /** false = standalone dejavu-owned file: overwrite, never merge */
  readonly merge: boolean
  readonly note?: string
}

const HARNESSES: Record<Harness, HarnessSpec> = {
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPT_DIR).replace(/\\/g, "/")
const CLI = `bun "${REPO_ROOT}/src/cli.ts"`

const USAGE = `usage: bun scripts/install-hooks.ts --harness <name> [--user|--project] [--dry-run]
  --harness <name>  one of: ${Object.keys(HARNESSES).join(", ")}
  --project         write into the current directory (default)
  --user            write into the home-directory config
  --dry-run         print the resulting config to stdout without writing`

function fail(message: string): never {
  console.error(`error: ${message}`)
  console.error(USAGE)
  process.exit(1)
}

interface Args {
  readonly harness: Harness
  readonly user: boolean
  readonly dryRun: boolean
}

function isHarness(name: string): name is Harness {
  return name in HARNESSES
}

function parseArgs(argv: string[]): Args {
  let harnessName = ""
  let user: boolean | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--user" || arg === "--project") {
      const value = arg === "--user"
      if (user !== null && user !== value) fail("--user and --project are mutually exclusive")
      user = value
    } else if (arg === "--harness") {
      harnessName = argv[++i] ?? fail("--harness needs a value")
    } else if (arg.startsWith("--harness=")) {
      harnessName = arg.slice("--harness=".length)
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE)
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  if (!isHarness(harnessName)) fail(`unknown harness: ${harnessName === "" ? "(missing --harness)" : harnessName}`)
  return { harness: harnessName, user: user ?? false, dryRun }
}

/** Hook commands invoke bare `bun` — it must resolve in the harness's shell PATH. */
function probeBun(): void {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { stdio: "ignore" })
  if (probe.status !== 0) fail("bun is not on PATH — add bun to PATH so harness-spawned hooks can run")
}

async function loadTemplate(harness: Harness): Promise<Json> {
  const path = join(SCRIPT_DIR, "templates", `${harness}.json`)
  // {{CLI}} lands inside a JSON string, so the path quotes must arrive JSON-escaped.
  const substituted = (await readFile(path, "utf8")).replaceAll("{{CLI}}", CLI.replaceAll(`"`, `\\"`))
  const parsed: unknown = JSON.parse(substituted)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(`template is not a JSON object: ${path}`)
  return parsed as Json
}

async function readExisting(path: string): Promise<Json> {
  if (!existsSync(path)) return {}
  const raw = await readFile(path, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`existing config is not valid JSON: ${path} — aborting, file left untouched`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`existing config is not a JSON object: ${path} — aborting, file left untouched`)
  }
  return parsed as Json
}

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

/** A prior dejavu entry is identified by its command string, in either entry shape. */
function isDejavuCommand(command: unknown, harness: string): boolean {
  return typeof command === "string" && command.includes("src/cli.ts") && command.includes(`--harness ${harness}`)
}

/** Drop prior dejavu entries from one event array; nested `hooks` groups lose only their dejavu commands (emptied groups drop). */
function stripDejavu(entries: unknown, harness: string): unknown[] {
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
function mergeConfig(existing: Json, template: Json, harness: string): Json {
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

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])

/** tmp + rename with backoff retry (Windows AV/indexer locks), minimal copy of src/store.ts atomicWrite. */
async function atomicWrite(path: string, content: string): Promise<void> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  probeBun()
  const spec = HARNESSES[args.harness]
  const template = await loadTemplate(args.harness)
  const target = args.user ? join(homedir(), spec.user) : resolve(spec.project)
  const output = spec.merge ? mergeConfig(await readExisting(target), template, args.harness) : template
  const bytes = `${JSON.stringify(output, null, 2)}\n`
  if (args.dryRun) {
    process.stdout.write(bytes)
    console.error(`dry-run: would write ${target}`)
  } else {
    await mkdir(dirname(target), { recursive: true })
    await atomicWrite(target, bytes)
    console.error(`wrote ${target}`)
  }
  if (spec.note !== undefined) console.error(`note: ${spec.note}`)
}

await main()
