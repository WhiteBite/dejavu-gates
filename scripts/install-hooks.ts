/** Thin wrapper over src/install.ts — kept for the documented `bun scripts/install-hooks.ts --harness <name> [--user|--project] [--dry-run]` shape. */
import { runInstall } from "../src/install"

process.exitCode = await runInstall(process.argv.slice(2))
