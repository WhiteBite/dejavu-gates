/**
 * Single entry behind the npm bin launcher: `dejavu install|uninstall|hooks`
 * goes to the installer, `dejavu pre|post|session-event` to the hook CLI.
 * The hook path stays fail-open ({} + exit 0 on any unexpected error) —
 * a hook crash must never wedge the host's tool pipeline.
 */
import { runHook } from "./cli"
import { runInstall } from "./install"

const INSTALL_SUBS = new Set(["install", "uninstall", "hooks"])
const HOOK_SUBS = new Set(["pre", "post", "session-event"])

const USAGE = `usage: dejavu <command> [args]
  install | uninstall | hooks --check   manage harness hook configs (--harness <csv> --user --yes --dry-run)
  pre | post | session-event            hook handler (--harness <name> [--store <dir>])`

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<number> {
  const [sub, ...rest] = process.argv.slice(2)
  if (sub !== undefined && INSTALL_SUBS.has(sub)) return runInstall([sub, ...rest])
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
