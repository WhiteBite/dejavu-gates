/**
 * dejavu installer: merges hook configs into agent harnesses (install),
 * strips them back out (uninstall), and drift-checks them (hooks --check).
 * Explicit --harness <csv> or marker-based auto-detection; existing configs
 * are backed up to <file>.dejavu-bak before any mutation.
 */
import { existsSync } from "node:fs"
import { copyFile, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { atomicWrite, ntPath } from "./fs"
import {
  asRecord,
  collectCommands,
  collectCommandsRoot,
  ConfigParseError,
  detectHarnesses,
  extractCliPath,
  HARNESSES,
  isDejavuCommand,
  isDejavuHookCommand,
  loadTemplate,
  mergeConfig,
  mergeConfigRoot,
  probeBun,
  readExisting,
  stripDejavu,
  warnIfNoBun,
  type Harness,
  type Json,
} from "./install-config"

const USAGE = `usage: dejavu <install|uninstall|hooks --check> [--harness <csv>] [--user|--project] [--yes] [--dry-run]
  install           write/refresh dejavu hook entries (default when no subcommand is given)
  uninstall         strip dejavu hook entries, keep foreign ones
  hooks --check     drift-check per harness: ok / stale (moved cli) / missing / broken
  --harness <csv>   one or more of: ${Object.keys(HARNESSES).join(", ")} (default: auto-detect)
  --project         target the current directory's config (default)
  --user            target the home-directory config
  --yes             skip the multi-target confirmation prompt
  --dry-run         print the resulting config to stdout without writing`

class UsageError extends Error {}

type Sub = "install" | "uninstall" | "check"

interface InstallArgs {
  readonly sub: Sub
  readonly harnesses: readonly Harness[] | null
  readonly user: boolean
  readonly yes: boolean
  readonly dryRun: boolean
}

function isHarness(name: string): name is Harness {
  return name in HARNESSES
}

function parseHarnessList(value: string): Harness[] {
  const names = value.split(",").map((n) => n.trim()).filter((n) => n !== "")
  if (names.length === 0) throw new UsageError("--harness needs a value")
  const unknown = names.find((n) => !isHarness(n))
  if (unknown !== undefined) throw new UsageError(`unknown harness: ${unknown}`)
  return names.filter(isHarness)
}

function parseInstallArgs(argv: string[]): InstallArgs {
  let rest = argv
  let sub: Sub = "install"
  const head = argv[0]
  if (head === "install" || head === "uninstall") {
    sub = head
    rest = argv.slice(1)
  } else if (head === "hooks") {
    rest = argv.slice(1)
    if (!rest.includes("--check")) throw new UsageError("hooks requires --check")
    sub = "check"
  }
  let harnesses: Harness[] | null = null
  let user: boolean | null = null
  let yes = false
  let dryRun = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ""
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--yes" || arg === "-y") {
      yes = true
    } else if (arg === "--check") {
      if (sub !== "check") throw new UsageError("--check only applies to the hooks subcommand")
    } else if (arg === "--user" || arg === "--project") {
      const value = arg === "--user"
      if (user !== null && user !== value) throw new UsageError("--user and --project are mutually exclusive")
      user = value
    } else if (arg === "--harness") {
      harnesses = parseHarnessList(rest[++i] ?? "")
    } else if (arg.startsWith("--harness=")) {
      harnesses = parseHarnessList(arg.slice("--harness=".length))
    } else {
      throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return { sub, harnesses, user: user ?? false, yes, dryRun }
}

async function confirm(question: string): Promise<boolean> {
  process.stderr.write(question)
  const rl = createInterface({ input: process.stdin, terminal: false })
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.once("line", resolveAnswer)
      rl.once("close", () => resolveAnswer(""))
    })
    return answer.trim().toLowerCase().startsWith("y")
  } finally {
    rl.close()
  }
}

export function targetPath(harness: Harness, user: boolean): string {
  const spec = HARNESSES[harness]
  return user ? join(homedir(), spec.user!) : resolve(spec.project)
}

/** Single rotating backup of the pre-mutation config; skipped when the file does not exist yet. */
async function backup(target: string): Promise<void> {
  if (existsSync(ntPath(target))) await copyFile(ntPath(target), ntPath(`${target}.dejavu-bak`))
}

async function installOne(harness: Harness, user: boolean, dryRun: boolean): Promise<void> {
  const spec = HARNESSES[harness]
  const template = await loadTemplate(harness)
  const target = targetPath(harness, user)
  // merge:false targets are parsed too — an unparseable existing file aborts before any write
  const existing = await readExisting(target)
  const output = spec.merge
    ? spec.rootHooks === true
      ? mergeConfigRoot(existing, template, harness)
      : mergeConfig(existing, template, harness)
    : template
  const bytes = `${JSON.stringify(output, null, 2)}\n`
  if (dryRun) {
    process.stdout.write(bytes)
    process.stderr.write(`dry-run: would write ${target}\n`)
  } else {
    await mkdir(dirname(target), { recursive: true })
    await backup(target)
    await atomicWrite(target, bytes)
    process.stderr.write(`wrote ${target}\n`)
  }
  if (spec.note !== undefined) process.stderr.write(`note: ${spec.note}\n`)
}

async function uninstallOne(harness: Harness, user: boolean, dryRun: boolean): Promise<void> {
  const spec = HARNESSES[harness]
  const target = targetPath(harness, user)
  if (!existsSync(ntPath(target))) {
    process.stderr.write(`${harness}: nothing to remove (${target} absent)\n`)
    return
  }
  if (!spec.merge) {
    // the standalone file is dejavu-owned — uninstall removes it whole
    if (dryRun) {
      process.stderr.write(`dry-run: would remove ${target}\n`)
      return
    }
    await backup(target)
    await rm(ntPath(target))
    process.stderr.write(`${harness}: removed ${target}\n`)
    return
  }
  const existing = await readExisting(target)
  const collectHere = spec.rootHooks === true ? collectCommandsRoot : collectCommands
  const before = collectHere(existing, (c) => isDejavuCommand(c, harness)).length
  if (before === 0) {
    process.stderr.write(`${harness}: no dejavu entries in ${target}\n`)
    return
  }
  let output: Json
  if (spec.rootHooks === true) {
    const cleanedRoot: Json = {}
    for (const [event, entries] of Object.entries(existing)) {
      if (!Array.isArray(entries)) {
        cleanedRoot[event] = entries
        continue
      }
      const kept = stripDejavu(entries, harness)
      if (kept.length > 0) cleanedRoot[event] = kept
    }
    output = cleanedRoot
  } else {
    const cleanedHooks: Json = {}
    for (const [event, entries] of Object.entries(asRecord(existing.hooks))) {
      if (!Array.isArray(entries)) {
        cleanedHooks[event] = entries
        continue
      }
      const kept = stripDejavu(entries, harness)
      if (kept.length > 0) cleanedHooks[event] = kept
    }
    output = { ...existing, hooks: cleanedHooks }
  }
  const removed = before - collectHere(output, (c) => isDejavuCommand(c, harness)).length
  const noun = removed === 1 ? "entry" : "entries"
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    process.stderr.write(`dry-run: would strip ${removed} dejavu ${noun} from ${target}\n`)
    return
  }
  await backup(target)
  await atomicWrite(target, `${JSON.stringify(output, null, 2)}\n`)
  process.stderr.write(`${harness}: removed ${removed} dejavu ${noun} from ${target}\n`)
}

type CheckStatus = "ok" | "stale" | "missing" | "broken"

async function checkOne(harness: Harness, user: boolean): Promise<{ status: CheckStatus; line: string }> {
  const target = targetPath(harness, user)
  let config: Json
  try {
    config = await readExisting(target)
  } catch (error) {
    if (error instanceof ConfigParseError) return { status: "broken", line: `${harness}: broken — ${target} is not valid JSON` }
    throw error
  }
  const commands = (HARNESSES[harness].rootHooks === true ? collectCommandsRoot : collectCommands)(config, (c) => isDejavuHookCommand(c, harness))
  if (commands.length === 0) return { status: "missing", line: `${harness}: missing — no dejavu hooks in ${target}` }
  const gone = commands.map(extractCliPath).find((p) => p === null || !existsSync(ntPath(p)))
  if (gone !== undefined) return { status: "stale", line: `${harness}: stale — hook cli not on disk: ${gone ?? "(unparseable command)"} (${target})` }
  return { status: "ok", line: `${harness}: ok — ${target}` }
}

/** Installer entry. Returns the process exit code; config errors exit 1 with a message (never a partial write). */
export async function runInstall(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  let args: InstallArgs
  try {
    args = parseInstallArgs(argv)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 1
  }
  try {
    if (args.sub === "install") probeBun()
    else warnIfNoBun()
    let harnesses = args.harnesses ?? detectHarnesses(args.user)
    // In user-mode auto-detect, skip harnesses that have no documented user path
    if (args.user && args.harnesses === null) {
      harnesses = harnesses.filter((h) => HARNESSES[h].user !== undefined)
    }
    if (args.harnesses === null) {
      process.stderr.write(harnesses.length > 0 ? `detected harnesses: ${harnesses.join(", ")}\n` : "no harness markers detected\n")
    }
    if (harnesses.length === 0) {
      process.stderr.write("error: no target harnesses — pass --harness explicitly\n")
      return 1
    }
    if (args.sub === "install" && harnesses.length > 1 && !args.yes && !args.dryRun && process.stdin.isTTY === true) {
      const ok = await confirm(`install dejavu hooks into ${harnesses.length} harness configs (${harnesses.join(", ")})? [y/N] `)
      if (!ok) {
        process.stderr.write("aborted\n")
        return 1
      }
    }
    // --user on a harness without a documented user scope → reject (before any path resolution)
    if (args.user) {
      for (const harness of harnesses) {
        if (HARNESSES[harness].user === undefined) {
          process.stderr.write(`${harness}: no user-scope install documented - use project scope\n`)
          return 1
        }
      }
    }
    if (args.sub === "check") {
      let bad = 0
      for (const harness of harnesses) {
        const result = await checkOne(harness, args.user)
        process.stderr.write(`${result.line}\n`)
        if (result.status === "stale" || result.status === "broken") bad += 1
      }
      process.stderr.write(bad === 0 ? "hooks: all targets ok or missing\n" : `hooks: ${bad} target(s) need reinstall\n`)
      return bad === 0 ? 0 : 1
    }
    // pre-validate every parseable target — an unparseable config aborts before the first write
    for (const harness of harnesses) {
      // merge:false uninstall removes the dejavu-owned file whole — no parse needed
      if (args.sub === "uninstall" && !HARNESSES[harness].merge) continue
      await readExisting(targetPath(harness, args.user))
    }
    for (const harness of harnesses) {
      if (args.sub === "install") await installOne(harness, args.user, args.dryRun)
      else await uninstallOne(harness, args.user, args.dryRun)
    }
    return 0
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
