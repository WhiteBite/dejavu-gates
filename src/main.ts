/**
 * Single entry behind the npm bin launcher: `dejavu install|uninstall|hooks`
 * goes to the installer, `dejavu pre|post|session-event` to the hook CLI.
 * The hook path stays fail-open ({} + exit 0 on any unexpected error) —
 * a hook crash must never wedge the host's tool pipeline.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { runHook } from "./cli"
import { runInstall } from "./install"

const INSTALL_SUBS = new Set(["install", "uninstall", "hooks"])
const HOOK_SUBS = new Set(["pre", "post", "session-event"])
const REPORT_SUBS = new Set(["report"])

const USAGE = `usage: dejavu <command> [args]
  install | uninstall | hooks --check   manage harness hook configs (--harness <csv> --user --yes --dry-run)
  pre | post | session-event            hook handler (--harness <name> [--store <dir>])
  report [dirs...]                      gate health report (doctor) over the given project dirs or all discovered stores; pass --repair to heal first`

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runReport(args: readonly string[]): number {
  const srcDir = (import.meta as ImportMeta & { dir: string }).dir
  const doctorPath = join(srcDir, "..", "scripts", "doctor.ts")
  const result = spawnSync(process.execPath, [doctorPath, ...args], { stdio: "inherit" })
  return result.status ?? 1
}

async function main(): Promise<number> {
  const [sub, ...rest] = process.argv.slice(2)
  if (sub !== undefined && INSTALL_SUBS.has(sub)) return runInstall([sub, ...rest])
  if (sub !== undefined && REPORT_SUBS.has(sub)) return runReport(rest)
  if (sub !== undefined && HOOK_SUBS.has(sub)) {
    try {
      return await runHook(process.argv.slice(2))
    } catch (error) {
      process.stderr.write(`[dejavu] fatal: ${formatError(error)}\n`)
      process.stdout.write("{}\n")
      return 0
    }
  }
  process.stderr.write(`${USAGE}\n`)
  return 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`error: ${formatError(error)}\n`)
    process.exitCode = 1
  },
)
