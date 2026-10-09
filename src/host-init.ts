/**
 * Host boot lifecycle shared by every host form (OpenCode V1/V2 plugins, the
 * Cline sandbox, the hook CLI): the ordered init sequence, the jittered TTL
 * sweep, and the rate-limited hook-error sink. Hosts inject only their log
 * dialect; the init ORDER (reconcile → migrate → expire) is an invariant and
 * lives here exactly once.
 */
import { NORMALIZATION_VERSION } from "./patterns"
import { DEMOTE_RECURRENCES, GLOBAL_PROJECTS, NOISE_TTL_DAYS, PLUGIN_VERSION, TTL_DAYS, type Stores } from "./store"

// --- Tunables ---------------------------------------------------------------

/** how often a long-lived process re-runs expiry */
const TTL_INTERVAL_MS = 6 * 60 * 60 * 1000
/** hook errors surface at most once per interval — visible, never spammy */
const HOOK_ERROR_LOG_INTERVAL_MS = 60_000

/** Host log dialect for init lines: receives the semantic line ("initialized
 *  v…", "init failed: …"); the host adds its own prefix. Must never throw. */
export type HostLogSink = (level: "info" | "warn" | "error", message: string) => void | Promise<void>

export interface InitStoresOptions {
  /** emit the init log event + the "initialized" info line (long-lived hosts) */
  logInitEvent: boolean
  /** rotate logs at init (the short-lived CLI skips it) */
  rotateLogs: boolean
  /** surface NOT TEACHING / review gate health to the durable log */
  healthLog: boolean
  /** surface a newer-writer version drift at boot (default on; the short-lived
   * CLI opts out — one process per hook call would spam the log) */
  versionDriftCheck?: boolean
  log: HostLogSink
}

/** Stores whose newer-writer drift was already surfaced in this process. */
const driftSeenStores = new Set<string>()

/** Numeric semver compare (2.10.0 > 2.9.0); a malformed component compares equal so a corrupt stamp never drifts. */
function semverCompare(a: string, b: string): number {
  const parse = (v: string): number[] => v.split(".").slice(0, 3).map((n) => Number.parseInt(n, 10))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return 0
    if (x !== y) return x - y
  }
  return 0
}

// runs before reconcile — reconcile re-stamps the file with this process's version, erasing the newer-writer evidence
async function checkVersionDrift(stores: Stores, log: HostLogSink): Promise<void> {
  const scopes = stores.projectStore !== null ? [stores.projectStore, stores.globalStore] : [stores.globalStore]
  for (const store of scopes) {
    await store.load()
    const stamp = store.lastWriterVersion
    if (stamp === null || driftSeenStores.has(store.dir) || semverCompare(stamp, PLUGIN_VERSION) <= 0) continue
    driftSeenStores.add(store.dir)
    await log("warn", `dejavu: store last written by ${stamp}, this process is ${PLUGIN_VERSION} — restart the window to pick up the newer plugin`)
    await stores.logAll({ type: "version-drift", key: "dejavu", snippet: `store ${store.dir} last written by ${stamp}, this process is ${PLUGIN_VERSION}` })
  }
}

/**
 * The ordered init sequence every host runs at boot: reconcile → migrate →
 * expire (the order is an invariant), then the long-lived extras. Never
 * throws — a failed init is reported through the sink and the host stays
 * registered (fail-open; the CLI proceeds gateless).
 */
export async function initStores(stores: Stores, opts: InitStoresOptions): Promise<void> {
  try {
    if (opts.versionDriftCheck !== false) await checkVersionDrift(stores, opts.log)
    await stores.reconcileAll(GLOBAL_PROJECTS)
    await stores.migrate()
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
    if (opts.rotateLogs) await stores.rotateLogs()
    if (opts.logInitEvent) await stores.logAll({ type: "init", key: "dejavu", version: PLUGIN_VERSION, snippet: `normalization ${NORMALIZATION_VERSION}` })
    if (opts.healthLog) {
      // surface non-automatable gate health to the durable log instead of letting it accumulate silently
      const enforced = await stores.enforcedGates()
      const notTeaching = enforced.filter((g) => g.recurredAfterGate >= DEMOTE_RECURRENCES).length
      const review = enforced.filter((g) => g.review === true).length
      if (notTeaching > 0 || review > 0) {
        await stores.logAll({ type: "health", key: "dejavu", snippet: `not-teaching ${notTeaching}, review ${review}` })
      }
    }
    if (opts.logInitEvent) await opts.log("info", `initialized v${PLUGIN_VERSION}`)
  } catch (error) {
    // init failures must not prevent hook registration — but must stay visible
    await opts.log("error", `init failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Jittered TTL sweep for long-lived hosts (0.75–1.25× interval so
 * simultaneous windows do not expire/rotate the shared global store in
 * sync): expire → rotate → flush deferred, rescheduled forever. Returns the
 * disposer — V2's dispose stops the sweep; hosts without a dispose surface
 * simply never call it.
 */
export function scheduleSweep(stores: Stores): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    const jitter = TTL_INTERVAL_MS * (0.75 + Math.random() * 0.5)
    timer = setTimeout(async () => {
      if (stopped) return
      try {
        await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
        await stores.rotateLogs()
        await stores.flushDeferredAll()
      } catch {
        // sweep failures must not stop the timer
      }
      schedule()
    }, jitter)
    ;(timer as { unref?: () => void }).unref?.()
  }
  schedule()
  return (): void => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Rate-limited hook-error sink: hosts swallow hook bugs to protect the tool
 * pipeline, so at most one error line per interval keeps a silently dead
 * plugin visible without spamming. The write callback receives the complete
 * semantic line ("<where> hook error: <message>"); the host adds its dialect
 * prefix. The short-lived CLI writes unlimited stderr instead — one process
 * serves one call, so there is nothing to rate-limit.
 */
export function rateLimitedErrorSink(write: (message: string) => void): (where: string, error: unknown) => void {
  let lastLogMs = 0
  return (where, error): void => {
    const now = Date.now()
    if (now - lastLogMs < HOOK_ERROR_LOG_INTERVAL_MS) return
    lastLogMs = now
    write(`${where} hook error: ${error instanceof Error ? error.message : String(error)}`)
  }
}
