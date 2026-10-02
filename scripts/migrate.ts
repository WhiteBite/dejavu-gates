/**
 * One-off migration runner for existing dejavu stores.
 * Re-tiers gates learned under older policies (probe-tool blocking → watching,
 * diagnostics → reminding), backfills mechanical corrections, sanitizes
 * signatures/snippets/corrections (secrets + terminal control chars), applies
 * feedback-demotion catch-up, and merges stale project copies of global gates.
 * Idempotent; also runs automatically at plugin init.
 *
 * Usage: bun scripts/migrate.ts <projectDir> [moreProjectDirs...]
 */
import { join } from "node:path"
import { createStores, GateStore, NOISE_TTL_DAYS, resolveGlobalDir, TTL_DAYS } from "../src/store"

const globalDir = resolveGlobalDir()
const projects = process.argv.slice(2)
const targets = projects.length > 0 ? projects : [process.cwd()]

for (const project of targets) {
  const stores = createStores(project)
  await stores.migrate(true)
  await stores.flushDeferredAll()
  // migrate backdates noise to the epoch — only the TTL sweep actually expires it
  await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
  // the script exits after the loop — deferred events must not die with it
  await stores.flushDeferredAll()
  if (stores.projectStore !== null) await stores.projectStore.scrubLog()
  console.log(`migrated: ${project}`)
}

// Historical logs are scrubbed too — secrets must not linger on disk.
await new GateStore(globalDir).scrubLog()
