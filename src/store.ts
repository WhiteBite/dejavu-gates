import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { atomicWrite, ntPath } from "./fs"
import { canBlock, canRemind, fuzzySimilar, FUZZY_MAX_LEN, hasGenericResidualIdentity, hasResidualIdentity, isBareExitSnippet, isGenericSignature, isNoiseError, isRepoLocal, looksLikeFailure, parameterizeError, sanitizeForStore, scrubSecrets, suggestCorrection, type DfIndex } from "./patterns"
import { coerceGateShape, failedAtMs, isAutoCorrection, repairGate } from "./validate"

/** Bumped on behavior changes; stamped into init log events so stale sessions are visible. */
export const PLUGIN_VERSION = "2.52.0"

/** Global store root — DEJAVU_HOME overrides it (testing, custom setups). */
export function resolveGlobalDir(): string {
  return process.env.DEJAVU_HOME ?? join(homedir(), ".config", "opencode", "dejavu")
}

/** Resolve a DEJAVU_* integer override once at module load; invalid or out-of-range values fall back. */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

/** Shared two-scope construction ("" = global only); the init sequence (reconcile/migrate/expire) stays at each call site. */
export function createStores(projectDir: string): Stores {
  const projectStore = projectDir !== "" ? new GateStore(join(projectDir, ".opencode", "dejavu")) : null
  return new Stores(new GateStore(resolveGlobalDir()), projectStore)
}

/** Declarative retirement condition: the taught error is obsolete once a
 * dependency reaches a version, a path appears/disappears, or a git tag
 * exists. Evaluated by doctor (report + --repair), never in the hooks. */
export type RetireWhen =
  | { kind: "dep"; name: string; min: string }
  | { kind: "path"; mode: "present" | "absent"; path: string }
  | { kind: "tag"; tag: string }

export interface Gate {
  /** sha1 signature prefix — the pattern identity */
  key: string
  /** normalized call signature, e.g. "bash:npm install --legacy-peer-deps" */
  signature: string
  tool: string
  /** watching = collecting evidence; reminding = enforced as reminder only
   * (diagnostics — never block); blocking = reminder + hard block on repeat */
  status: "watching" | "reminding" | "blocking"
  count: number
  /** distinct session IDs where the failure was seen */
  sessions: string[]
  /** distinct project directories where the failure was seen */
  projects: string[]
  firstSeen: string
  lastSeen: string
  /** last observed error line, as evidence (secret-scrubbed) */
  snippet: string
  /** optional human/agent-written guidance shown in reminder/block messages */
  correction?: string
  /** who wrote the correction: machine (suggestCorrection at promotion/backfill),
   * agent (lesson set run by the AI agent) or owner (the human — lesson set
   * --author owner / gates.json edit). Drives merge precedence and protects
   * owner text from template re-derivation; absent on legacy records. */
  correctionOrigin?: "machine" | "agent" | "owner"
  /** epoch ms when the authored correction was written */
  correctionAt?: number
  /** the gate's counters at lesson-write time, so recurrence-since-correction stays computable */
  correctionBaseline?: { recurred: number; reminded: number; overrides: number; promoted?: number }
  /** lifetime successes on a gate carrying an authored correction — the "lesson proven" signal */
  correctionsProven?: number
  remindedCount: number
  blockedCount: number
  recurredAfterReminder: number
  /** the core health metric: failures of this pattern AFTER it became a gate */
  recurredAfterGate: number
  /** explicit bypasses (dejavu:proceed) against this gate — negative feedback:
   * a gate the agent keeps overriding is friction, not teaching */
  overrideCount: number
  /** distinct sessions that explicitly bypassed this gate (capped). Override
   * demotion needs votes from several of them: one stubborn or prompt-injected
   * session must not be able to disarm a gate for everyone. */
  overrideSessions?: string[]
  /** demoted once by behavioral feedback (recurrences/overrides). Such gates
   * never re-promote mechanically — a human re-enforces by clearing the flag */
  feedbackDemoted?: boolean
  /** counters at the moment of feedback demotion. A human re-enforcement
   * (status set back to enforced) must get a FRESH grace window — without the
   * baseline, the stale counters would re-demotion on the very next failure */
  feedbackBaseline?: { recurred: number; overrides: number }
  /** consecutive successes after the gate was enforced — reaching HEAL_SUCCESSES
   * retires the gate to watching (the underlying command got fixed) */
  succeededAfterGate?: number
  /** lifetime promotions of this pattern — never reset by the lifecycle reset.
   * The definitive flapping measure (promote→heal→promote oscillation); doctor
   * escalates FLAPPY with it. Report-only: no mechanical auto-demotion. */
  promotionCount?: number
  /** count at the moment the gate retired (healed or taught). `count`/`sessions`
   * are lifetime-cumulative, so without damping a retired gate re-promoted on the
   * VERY NEXT single failure (promote→heal→promote oscillation). Re-promotion now
   * requires a full fresh bar: `count - retireBaseline.count >= threshold`.
   * movedOn rides along so since-retirement iteration evidence stays computable. */
  retireBaseline?: { count: number; movedOn?: number }
  /** flagged for manual review when the gate fires often but errors stopped */
  review?: boolean
  /** sessions currently reminded about this gate: sessionID -> remind time (ms).
   * Persisted on the gate so the remind→block chain survives process restarts
   * and is visible to every window serving the session. */
  remindedSessions?: Record<string, number>
  /** sessions that failed again after a reminder: sessionID -> { t: fail time
   * (ms, drives expiry), v: workspaceVersion at fail time } — an edit after the
   * failed attempt turns the next attempt into a fresh try, not an ignored
   * reminder. Legacy bare numbers (fail time only) never prove iteration. */
  failedSessions?: Record<string, number | { t: number; v: number }>
  /** workspace version at the last recorded failure (iteration evidence —
   * process-local count of landed edit/write calls in the project) */
  iteratedVersion?: number
  /** lifetime failures that carried iteration evidence (moved workspace or a
   * changed error form) — promotion requires stuck evidence, not just volume */
  movedOn?: number
  /** distinct sessions that reoffended AFTER being reminded (capped). The
   * demotion vote counts only failures the gate had a chance to prevent —
   * first-encounter failures never saw a reminder and must not demote. */
  reoffenseSessions?: string[]
  /** the latest recorded failure was text-only (no exit code, no structural
   * errored signal) — output text alone cannot prove the call failed, so such
   * evidence promotes to reminding at most, never blocking. A structural
   * failure clears the flag (the gate earned real evidence). */
  textOnly?: boolean
  /** declarative retirement condition — doctor --repair retires the gate (retireTaught) once met */
  retireWhen?: RetireWhen
}

interface GatesFile {
  version: 1
  gates: Gate[]
  /** PLUGIN_VERSION that last ran migrate() on this file — lets subsequent
   * starts skip the full per-gate scan (init storm killer) */
  migrated?: string
  /** PLUGIN_VERSION of the process that last SAVED this file. Unlike
   * `migrated` (which converges to the newest version as every reader re-loads
   * it), this is stamped with the WRITER's own version on every save, so a
   * stale plugin session writing here leaves its old version behind — the
   * durable version-drift signal (log init events rotate away). */
  lastInitVersion?: string
}

/** Cross-project pattern index: which project dirs have seen each key. */
interface IndexEntry {
  projects: string[]
  lastSeen: string
  /** set when no scope visible to the sweeper holds the gate; pruned if it stays absent past ORPHAN_CANDIDATE_DAYS */
  orphanCandidateSince?: number
}

interface IndexFile {
  version: 1
  keys: Record<string, IndexEntry>
}

export type LogEventType =
  | "detected"
  | "promoted"
  | "reminded"
  | "retry-allowed"
  | "blocked"
  | "override"
  | "expired"
  | "recurred-after-gate"
  | "demoted"
  | "init"
  | "health"
  | "repaired"
  | "quarantined"
  | "degraded"
  | "retired-healed"
  | "retired-taught"
  | "healed"
  | "corrected"
  | "repeat-detected"
  | "repeat-reminded"
  | "repeat-blocked"
  | "repeat-sanitized"
  | "repeat-windowed"
  | "repeat-override"
  | "loop-break"
  | "shape-loop"

/** Events that change what the machine remembers — the only ones worth the
 * global log lock (the most-contended lock, shared by every window of every
 * project). High-volume events (detected/reminded/blocked/retry-allowed/
 * recurred-after-gate) stay in the project log only. */
const GLOBAL_LOG_EVENTS = new Set<LogEventType>([
  "init",
  "promoted",
  "demoted",
  "healed",
  "retired-healed",
  "retired-taught",
  "override",
  "corrected",
])

export interface LogEvent {
  type: LogEventType
  key: string
  tool?: string
  session?: string
  project?: string
  /** harness that observed the failure (detected events) */
  harness?: string
  snippet?: string
  /** which detection channel fired: metadata exit, bash text scan, or event stream */
  channel?: "exit" | "text" | "event"
  /** raw tool exit code when available */
  exit?: number
  /** how the gate matched the call */
  via?: "exact" | "fuzzy" | "segment"
  /** plugin version (init events) */
  version?: string
  /** length of the consecutive-identical-call series (repeat channel) */
  repeatCount?: number
  /** expired-gate tombstone: posthumous FP forensics — the counters and correction vanish with the gate */
  status?: Gate["status"]
  overrideCount?: number
  recurredAfterGate?: number
  machineDefaultCorrection?: boolean
  correction?: string
}

export const MAX_SESSIONS = 50
const MAX_PROJECTS = 20
const LOG_ROTATE_BYTES = 512 * 1024
/** the global log aggregates every project — rotate it later or forensics vanish in a day */
const GLOBAL_LOG_ROTATE_BYTES = 2048 * 1024
const LOG_ROTATE_KEEP_LINES = 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** trust the loaded-gates cache this long without re-statting (hot path: every tool call) */
const LOAD_CACHE_TTL_MS = 1000

/** distinct project dirs in the global index before a pattern escalates to
 * the global store (agent-level habit, not a repo quirk) */
export const GLOBAL_PROJECTS = 2
/** gates expire when the pattern has not recurred for this many days */
export const TTL_DAYS = envInt("DEJAVU_TTL_DAYS", 60, 1, 3650)
/** one-off patterns that NEVER recurred (watching, count ≤ 1) rot this fast; a
 * twice-seen pattern has proven recurrence and gets the full TTL_DAYS instead,
 * so slow recurrences can still accumulate to the promotion bar */
export const NOISE_TTL_DAYS = envInt("DEJAVU_NOISE_TTL_DAYS", 7, 1, 365)
/** failures required before a pattern becomes an enforced gate */
export const PROMOTE_COUNT = envInt("DEJAVU_PROMOTE_COUNT", 3, 1, 100)
/** file-probe tools fail routinely during normal probing — higher bar, never block */
export const PROMOTE_COUNT_PROBE = envInt("DEJAVU_PROMOTE_COUNT_PROBE", 5, 1, 100)
/** distinct sessions required — same-session loops never promote */
export const PROMOTE_SESSIONS = envInt("DEJAVU_PROMOTE_SESSIONS", 2, 1, 100)
/** consecutive successes after a gate that retire it — the command is fixed,
 * so the gate must stop reminding (the ruff-check-false-positive case) */
export const HEAL_SUCCESSES = envInt("DEJAVU_HEAL_SUCCESSES", 3, 1, 100)
/** store size bound: flooding with unique failures must not bloat gates.json
 * or slow the fuzzy scan — the weakest watching gate is evicted past this */
export const MAX_GATES = 2000
/** enforcement feedback: an enforced gate whose pattern fails this many times
 * AFTER promotion is not teaching (iteration or a useless correction) —
 * demote it instead of nagging/blocking forever */
export const DEMOTE_RECURRENCES = envInt("DEJAVU_DEMOTE_RECURRENCES", 3, 1, 100)
/** enforcement feedback: this many explicit bypasses mean the agent considers
 * the gate friction — demote it regardless of recurrence */
export const DEMOTE_OVERRIDES = envInt("DEJAVU_DEMOTE_OVERRIDES", 3, 1, 100)
/** override demotion additionally requires this many DISTINCT bypassing
 * sessions — mirror of DEMOTE_REOFFENSE_SESSIONS: one stubborn/injected
 * session must not disarm a gate for everyone */
const DEMOTE_OVERRIDE_SESSIONS = 2
/** reminding-tier demotion is session-vote only (no raw-count bar): bypassing a
 *  gate that never interrupts is weaker friction, so it needs 5 distinct sessions */
const DEMOTE_OVERRIDES_REMINDING = 5
/** recurrence demotion additionally requires this many DISTINCT sessions that
 * reoffended after a reminder — one bad session (or one bad model in a shared
 * store) must not be able to demote a gate for everyone else */
const DEMOTE_REOFFENSE_SESSIONS = 2
/** an authored lesson unproven and unrecurred past this many days is dormant — the pattern died out */
export const STALE_LESSON_DAYS = 120
/** prune an index key absent from every scope visible to the sweeper after this many days (a live gate in an unopened project clears its own candidacy) */
const ORPHAN_CANDIDATE_DAYS = 7

/** Self-ignoring .gitignore for the PROJECT store dir: gates.json is committable (shared repo gotchas), runtime files are not. */
const STORE_GITIGNORE = "# dejavu: gates.json is committable (shared repo gotchas); runtime files are not.\n*\n!gates.json\n!.gitignore\n"

/** bash pays the base bar; every non-bash tool (probes and generic) pays the probe bar. */
function promotionThreshold(tool: string): number {
  return tool === "bash" ? PROMOTE_COUNT : PROMOTE_COUNT_PROBE
}

/** Literal-output verb families: their "failure" is echoed text, not a failing call. */
const LITERAL_OUTPUT_VERBS = new Set(["echo", "printf", "type", "write-output", "write-host"])

/** True when every chain segment of a bash signature is a bare literal-output
 * command (echo/printf/type/write-output/write-host) — the signature has no
 * residual identity beyond echoing text. Powers migrate's legacy text-channel
 * demotion and doctor's TEXT-CHANNEL-BLOCKING tripwire. */
export function isLiteralOutputSignature(signature: string): boolean {
  const body = signature.startsWith("bash:") ? signature.slice("bash:".length) : signature
  const segments = body.split(/\s*(?:\|\||&&|[|;&])\s*|\n+/).filter((s) => s.trim() !== "")
  return segments.length > 0 && segments.every((segment) => LITERAL_OUTPUT_VERBS.has((segment.trim().split(/\s+/)[0] ?? "").toLowerCase()))
}

/** A machine correction that restates the failing line or shares no content token with the signature teaches nothing — advisory review flag, never a block. */
export function correctionEvidencePoor(signature: string, snippet: string, correction: string): boolean {
  // dequote: parameterizeError eats quoted spans into <str>
  const dequoted = (s: string): string => s.replace(/["']/g, "")
  const snippetParam = parameterizeError(dequoted(snippet))
  if (snippetParam !== "" && parameterizeError(dequoted(correction)).includes(snippetParam)) return true
  const contentTokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/^[a-z-]+:/, "")
        .split(/\s+/)
        .filter((t) => t !== "" && !t.startsWith("-") && !(t.startsWith("<") && t.endsWith(">"))),
    )
  const sigTokens = contentTokens(signature)
  const correctionTokens = contentTokens(correction)
  return correctionTokens.size > 0 && [...correctionTokens].every((t) => !sigTokens.has(t))
}

/** Shared expiry rule — expire() and the expireAll unlocked peek must never diverge. */
function gateExpirable(gate: Gate, ttlDays: number, noiseTtlDays: number, now: number): boolean {
  // noise TTL is for TRUE one-offs; a twice-seen pattern earns the full TTL so slow recurrences still promote
  const ttl = gate.status !== "watching" || gate.count >= 2 ? ttlDays : noiseTtlDays
  return Date.parse(gate.lastSeen) < now - ttl * DAY_MS
}

/** Posthumous FP forensics: the override/correction history vanishes with the expired gate — the tombstone keeps it auditable. */
function expiryTombstone(gate: Gate): Pick<LogEvent, "status" | "overrideCount" | "recurredAfterGate" | "machineDefaultCorrection" | "correction"> {
  return {
    status: gate.status,
    overrideCount: gate.overrideCount,
    recurredAfterGate: gate.recurredAfterGate,
    machineDefaultCorrection: gate.correctionOrigin === "machine" || gate.correction === undefined,
    correction: gate.correction?.slice(0, 200),
  }
}

// --- Windows-safe fs helpers -------------------------------------------------

const LOCK_STALE_MS = 5000
const LOCK_WAIT_MS = 3000

/** Same-process critical sections serialize here FIRST: the file lock is
 * cross-process only — two async contexts of one process (parallel tool calls)
 * contending on it would burn LOCK_WAIT_MS polling and then degrade to
 * unlocked, losing updates. The in-process queue is unbounded on purpose:
 * our own sections always complete, unlike a foreign process we cannot trust. */
const processQueues = new Map<string, Promise<unknown>>()

async function withLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
  onDegrade?: () => void,
  onSteal?: (heldMs: number, previousPid: string) => void,
): Promise<T> {
  const prev = processQueues.get(lockTarget) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = prev.then(() => turn)
  processQueues.set(lockTarget, chained)
  await prev
  try {
    return await withFileLock(lockTarget, fn, onDegrade, onSteal)
  } finally {
    release()
    if (processQueues.get(lockTarget) === chained) processQueues.delete(lockTarget)
  }
}

/**
 * Exclusive lockfile ("wx" create) with stale-lock stealing and graceful
 * degradation: if the lock cannot be acquired within LOCK_WAIT_MS the
 * critical section runs unlocked rather than hanging the tool pipeline.
 * Stealing is pid-liveness-gated and reported via onSteal.
 */
async function withFileLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
  onDegrade?: () => void,
  onSteal?: (heldMs: number, previousPid: string) => void,
): Promise<T> {
  const lock = `${lockTarget}.lock`
  await mkdir(ntPath(dirname(lock)), { recursive: true })
  const started = Date.now()
  let acquired = false
  for (;;) {
    try {
      await writeFile(ntPath(lock), String(process.pid), { flag: "wx" })
      acquired = true
      break
    } catch (error) {
      const code = (error as { code?: string }).code ?? ""
      if (code !== "EEXIST") throw error
      try {
        const info = await stat(ntPath(lock))
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // Steal only if the recorded holder is dead: a live holder may
          // simply be slow (>5s critical section), and stealing from it
          // opens the critical section to concurrent entry — the residual
          // corruption window. ESRCH = dead; EPERM = alive but not ours.
          let holderPid = ""
          try {
            holderPid = ((await readFile(ntPath(lock), "utf8")) ?? "").trim()
          } catch {
            // unreadable lockfile — treat as stealable
          }
          let holderAlive = false
          const holderPidNum = Number(holderPid)
          if (holderPid !== "" && Number.isFinite(holderPidNum) && holderPidNum > 0) {
            if (holderPidNum === process.pid) {
              // Same-process holder (another async context / window in this
              // process) always releases via finally — wait for it, never steal
              // (stealing from ourselves breaks in-process serialization).
              holderAlive = true
            } else {
              try {
                process.kill(holderPidNum, 0)
                holderAlive = true
              } catch (killError) {
                // ESRCH = dead; EPERM/other = alive but not signalable by us
                holderAlive = (killError as { code?: string }).code !== "ESRCH"
              }
            }
          }
          if (!holderAlive) {
            await unlink(ntPath(lock)).catch(() => {})
            if (onSteal) onSteal(Date.now() - info.mtimeMs, holderPid)
            continue
          }
          // live slow holder — fall through to the timeout check
        }
      } catch {
        continue // lock vanished between attempts
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        // The only window where concurrent writes can lose updates — make it visible.
        if (onDegrade) onDegrade()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await fn()
  } finally {
    // A degraded waiter never owned the lock — unlinking it would delete the
    // LIVE holder's lockfile and let a third process enter the critical
    // section concurrently (the corruption seen in production logs).
    // Even a legitimate holder must verify ownership: if a stale-steal gave
    // the lock away mid-hold, unlinking would delete the STEALER's lockfile.
    if (acquired) {
      try {
        const owner = await readFile(ntPath(lock), "utf8").catch(() => "")
        if (owner === String(process.pid)) await unlink(ntPath(lock))
      } catch {
        // best effort
      }
    }
  }
}

/** Disk form of one projects[] entry: absolute dirs become repo-relative ("" → ".") so the committable project gates.json carries no machine paths. */
function toRepoRelative(root: string, p: string): string {
  if (!isAbsolute(p)) return p
  const rel = relative(root, p)
  return rel === "" ? "." : rel
}

/** In-memory form of one persisted projects[] entry: repo-relative paths resolve back against the store's owning root. */
function toAbsoluteDir(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p)
}

export class GateStore {
  private gates: Gate[] | null = null
  private mtimeMs = 0
  /** hot-path caches: valid until LOAD_CACHE_TTL_MS / invalidated on mutation */
  private cacheUntilMs = 0
  private keyIndex: Map<string, Gate> | null = null
  private enforcedCache: Gate[] | null = null
  private index: IndexFile | null = null
  private indexMtimeMs = 0
  /** PLUGIN_VERSION that last ran migrate() — persisted in gates.json so the
   * 2nd..Nth start of the same version skips the full per-gate scan */
  private migratedStamp: string | null = null
  /** events queued inside the gates lock, flushed on the next log() — logging
   * under the gates lock extends the critical section into degrade storms */
  private deferredEvents: LogEvent[] = []
  /** lastSeen-only index refreshes deferred by recordFailure; flushed under the index lock by flushDeferred */
  private pendingIndexTouches: Map<string, string> = new Map()
  /** df-index cache over ALL gates of this scope; rebuilt when the revision moves */
  private dfCache: DfIndex | null = null
  private dfCacheRevision = -1
  /** monotonic gate-set revision — bumped whenever gates are replaced or mutated */
  private revision = 0
  /** Set by Stores on the PROJECT store → the global store. Deferred events
   * bypass logAll's routing, so a salient event deferred on the project store
   * (demoted in migrate, retired-healed in expireAll) would never reach the
   * global forensics; on flush/log the salient subset of the drained batch is
   * mirrored here. Direct (non-deferred) events are NOT mirrored — logAll
   * already routes those, so mirroring them would double-write. */
  routeSalientTo: GateStore | null = null

  constructor(public readonly dir: string) {}

  /** The repo root owning this store when dir has the production project shape (<root>/.opencode/dejavu); null for the global store and ad-hoc dirs. */
  private get repoRoot(): string | null {
    const suffix = join(".opencode", "dejavu")
    return this.dir.endsWith(suffix) && this.dir.length > suffix.length ? dirname(dirname(this.dir)) : null
  }

  /** PLUGIN_VERSION that last ran migrate() on this store (null = never). */
  get migratedVersion(): string | null {
    return this.migratedStamp
  }

  /** Set the migration stamp (persisted by the next save()). */
  set migratedVersion(version: string | null) {
    this.migratedStamp = version
  }

  /** Queue an event while holding the gates lock; the next log() flushes it. */
  deferEvent(event: LogEvent): void {
    this.deferredEvents.push(event)
  }

  /**
   * Flush queued deferred events now. Scripts (doctor, migrate) repair stores
   * and then exit without any further log() call — without this, the deferred
   * repaired/quarantined/demoted/expired events are silently lost, breaking
   * the "every repair is logged" invariant. No-op when the queue is empty.
   */
  async flushDeferred(): Promise<void> {
    if (this.deferredEvents.length !== 0) {
      let salient: LogEvent[] = []
      await this.withLogLock(async () => {
        if (this.deferredEvents.length === 0) return
        const batch = this.deferredEvents
        this.deferredEvents = []
        if (this.routeSalientTo !== null) salient = batch.filter((e) => GLOBAL_LOG_EVENTS.has(e.type))
        await mkdir(ntPath(this.dir), { recursive: true })
        for (const e of batch) {
          const line = `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`
          await appendFile(ntPath(this.logPath), line, "utf8")
        }
      })
      if (salient.length > 0 && this.routeSalientTo !== null) await this.routeSalientTo.appendBatch(salient)
    }
    // sequenced after the log drain: the index lock is taken alone, never nested with the log lock
    await this.flushPendingIndexTouches()
  }

  /** Queue a lastSeen-only index refresh; persisted by the next flushDeferred. */
  deferIndexTouch(key: string, lastSeen: string): void {
    this.pendingIndexTouches.set(key, lastSeen)
  }

  private async flushPendingIndexTouches(): Promise<void> {
    if (this.pendingIndexTouches.size === 0) return
    await this.runLockedIndex(async () => {
      const index = await this.loadIndexForMutation()
      let changed = false
      for (const [key, ts] of this.pendingIndexTouches) {
        const entry = index.keys[key]
        // absent entry: pruned or never structural — the next failure/reconcile rebuilds it
        if (entry === undefined || ts <= entry.lastSeen) continue
        entry.lastSeen = ts
        changed = true
      }
      if (changed) await this.saveIndex()
      this.pendingIndexTouches.clear()
    })
  }

  /** Append an already-formed batch of events under the log lock. Used by a peer
   * store mirroring its salient deferred events into the global forensics — the
   * batch is fully captured before this runs, so nothing here can be lost. */
  async appendBatch(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.withLogLock(async () => {
      await mkdir(ntPath(this.dir), { recursive: true })
      for (const e of events) {
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`
        await appendFile(ntPath(this.logPath), line, "utf8")
      }
    })
  }

  private get gatesPath(): string {
    return join(this.dir, "gates.json")
  }

  private get logPath(): string {
    return join(this.dir, "log.jsonl")
  }

  private get indexPath(): string {
    return join(this.dir, "index.json")
  }

  /** Run a load→mutate→save section under the store's exclusive lock. */
  async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(
      this.gatesPath,
      fn,
      () => {
        this.deferEvent({ type: "degraded", key: "gates.lock", snippet: `lock contention exceeded ${LOCK_WAIT_MS}ms; critical section ran unlocked` })
      },
      (heldMs, previousPid) => {
        this.deferEvent({ type: "repaired", key: "gates.lock", snippet: `stale lock stolen (held ${heldMs}ms, previous pid ${previousPid || "?"})` })
      },
    )
  }

  /**
   * Read-only load (hot path). Never writes — an unparseable file is treated
   * as an empty in-memory view, quarantine happens only in loadForMutation().
   */
  async load(): Promise<Gate[]> {
    return this.loadGates(false)
  }

  /**
   * Mutation load — call ONLY while holding the store lock. Bypasses the mtime
   * cache and quarantines an unparseable file (a WRITE). Every record crosses
   * the validation boundary: hopeless records are dropped, repairable ones
   * coerced — enforcement never sees raw state.
   */
  async loadForMutation(): Promise<Gate[]> {
    return this.loadGates(true)
  }

  private async loadGates(force: boolean): Promise<Gate[]> {
    // TTL fast path: the hot path (every tool call) must not pay a stat per
    // call. Gates change rarely (promotion, manual edit); 1s staleness is
    // invisible to enforcement and our own saves refresh the cache directly.
    if (!force && this.gates !== null && Date.now() < this.cacheUntilMs) {
      return this.gates
    }
    let info: Awaited<ReturnType<typeof stat>>
    let raw: string
    try {
      info = await stat(ntPath(this.gatesPath))
      if (!force && this.gates !== null && info.mtimeMs === this.mtimeMs) {
        this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
        return this.gates
      }
      raw = await readFile(ntPath(this.gatesPath), "utf8")
    } catch (error) {
      const code = (error as { code?: string }).code ?? ""
      if (code !== "ENOENT") {
        // A transient read failure (AV/indexer lock, EISDIR, EPERM) is NOT an
        // empty store: proceeding with [] would let the next save() clobber
        // the real gates.json. Fail loud; hook-level catches stay fail-open.
        throw new Error(`dejavu: gates store unreadable (${code || "unknown error"}): ${this.gatesPath}`)
      }
      // missing gates.json — legitimately an empty store
      if (this.gates === null) {
        this.gates = []
        this.keyIndex = new Map()
        this.enforcedCache = []
      }
      this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
      return this.gates
    }
    let records: unknown[] | null = null
    try {
      const parsed = JSON.parse(raw) as Partial<GatesFile>
      if (Array.isArray(parsed.gates)) {
        records = parsed.gates
        this.migratedStamp = typeof parsed.migrated === "string" ? parsed.migrated : null
      }
    } catch {
      // fall through to the corruption branch
    }
    if (records === null) {
      // Corruption ≠ absence: an unparseable file quarantines (bytes kept,
      // fresh store started) instead of silently emptying — the silent path
      // let the next save() overwrite recoverable gates with a blank store.
      // Only under the lock (force): unlocked reads never write.
      if (force) await this.quarantineGatesFile(raw)
      if (this.gates === null) {
        this.gates = []
        this.keyIndex = new Map()
        this.enforcedCache = []
      }
      this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
      return this.gates
    }
    const gates: Gate[] = []
    const repoRoot = this.repoRoot
    for (const record of records) {
      const gate = coerceGateShape(record)
      if (gate === null) continue
      repairGate(gate)
      // committable gates.json holds repo-relative dirs; the engine only ever sees absolute ones
      if (repoRoot !== null) gate.projects = gate.projects.map((p) => toAbsoluteDir(repoRoot, p))
      gates.push(gate)
    }
    this.gates = gates
    this.keyIndex = new Map(gates.map((g) => [g.key, g]))
    this.enforcedCache = gates.filter((g) => g.status !== "watching")
    this.mtimeMs = info.mtimeMs
    this.revision++
    this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
    return this.gates
  }

  /** O(1) exact lookup over the cached gates (call load() first to refresh). */
  byKey(key: string): Gate | undefined {
    if (this.keyIndex === null) {
      this.keyIndex = new Map((this.gates ?? []).map((g) => [g.key, g]))
    }
    return this.keyIndex.get(key)
  }

  /** Cached enforced subset (blocking + reminding) — the fuzzy scan iterates this, not all gates. */
  enforcedOnly(): Gate[] {
    if (this.enforcedCache === null) {
      this.enforcedCache = (this.gates ?? []).filter((g) => g.status !== "watching")
    }
    return this.enforcedCache
  }

  /** Token document-frequency over ALL gates of this scope (watching included);
   * cached until the gate-set revision moves. Reads the cached gate view —
   * call load() first for freshness. */
  dfIndex(): DfIndex {
    if (this.dfCache === null || this.dfCacheRevision !== this.revision) {
      const df = new Map<string, number>()
      const gates = this.gates ?? []
      for (const gate of gates) {
        const seen = new Set<string>()
        for (const token of gate.signature.split(/\s+/)) {
          if (token === "" || seen.has(token)) continue
          seen.add(token)
          df.set(token, (df.get(token) ?? 0) + 1)
        }
      }
      this.dfCache = { df, total: gates.length }
      this.dfCacheRevision = this.revision
    }
    return this.dfCache
  }

  /** Disk view of the gates: a project store persists projects[] repo-relative; the in-memory view stays absolute (escalation, index and merge logic count distinct dirs). */
  private persistedGates(): Gate[] {
    const root = this.repoRoot
    const gates = this.gates ?? []
    if (root === null) return gates
    return gates.map((g) => (g.projects.length === 0 ? g : { ...g, projects: g.projects.map((p) => toRepoRelative(root, p)) }))
  }

  async save(): Promise<void> {
    if (this.gates === null) return
    this.revision++
    await mkdir(ntPath(this.dir), { recursive: true })
    const payload: GatesFile = { version: 1, gates: this.persistedGates() }
    if (this.migratedStamp !== null) payload.migrated = this.migratedStamp
    // The WRITER's own version, stamped on every save — a stale plugin session
    // leaves its old version here (durable drift signal; log inits rotate away).
    payload.lastInitVersion = PLUGIN_VERSION
    await atomicWrite(this.gatesPath, `${JSON.stringify(payload, null, 2)}\n`)
    try {
      this.mtimeMs = (await stat(ntPath(this.gatesPath))).mtimeMs
    } catch {
      // mtime refresh is best-effort
    }
    // We know the content we just wrote — refresh the TTL cache directly.
    // (keyIndex/enforcedCache hold references into this.gates, still valid.)
    this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
  }

  /** Write the self-ignoring .gitignore into this store dir (project scope
   * only — the global dir is not inside a repo). Best-effort: never clobbers
   * an existing file, never throws — init must not fail on hygiene. */
  async ensureGitignore(): Promise<void> {
    try {
      const target = join(this.dir, ".gitignore")
      if (existsSync(ntPath(target))) return
      await mkdir(ntPath(this.dir), { recursive: true })
      await atomicWrite(target, STORE_GITIGNORE)
    } catch {
      // best-effort hygiene: a read-only store dir must never fail init
    }
  }

  /** Cross-project pattern index; meaningful only on the global store. Read-only. */
  async loadIndex(): Promise<IndexFile> {
    return this.loadIndexFile(false)
  }

  /** Mutation load of the index — call ONLY while holding the index lock. */
  async loadIndexForMutation(): Promise<IndexFile> {
    return this.loadIndexFile(true)
  }

  private async loadIndexFile(force: boolean): Promise<IndexFile> {
    let raw = ""
    try {
      const info = await stat(ntPath(this.indexPath))
      if (!force && this.index !== null && info.mtimeMs === this.indexMtimeMs) {
        return this.index
      }
      raw = await readFile(ntPath(this.indexPath), "utf8")
      const parsed = JSON.parse(raw) as Partial<IndexFile>
      const keys = parsed.keys
      this.index = { version: 1, keys: keys !== null && typeof keys === "object" ? keys : {} }
      this.indexMtimeMs = info.mtimeMs
      return this.index
    } catch (error) {
      const code = (error as { code?: string }).code ?? ""
      // index corruption quarantines under the lock, never silently rebuilds
      if (error instanceof SyntaxError) {
        if (force) await this.quarantineIndexFile(raw)
        if (this.index === null) this.index = { version: 1, keys: {} }
        return this.index
      }
      if (code !== "ENOENT") {
        // warm cache only for peeks; mutation reads fail loud
        if (!force && this.index !== null) return this.index
        throw new Error(`dejavu: index unreadable (${code || "unknown error"}): ${this.indexPath}`)
      }
      if (this.index === null) this.index = { version: 1, keys: {} }
      return this.index
    }
  }

  /** Quarantine twin of quarantineGatesFile for index.json — caller must hold the index lock. */
  private async quarantineIndexFile(raw: string): Promise<void> {
    const quarantine = `${this.indexPath}.corrupt-${Date.now()}`
    try {
      await writeFile(ntPath(quarantine), scrubSecrets(raw), "utf8")
      await unlink(ntPath(this.indexPath))
      this.index = { version: 1, keys: {} }
      this.indexMtimeMs = 0
      await this.saveIndex()
      this.deferEvent({ type: "quarantined", key: "index.json", snippet: `unparseable index file quarantined (scrubbed) to ${quarantine}` })
    } catch {
      // quarantine failure retries on the next force load
    }
  }

  async saveIndex(): Promise<void> {
    if (this.index === null) return
    await mkdir(ntPath(this.dir), { recursive: true })
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`)
    try {
      this.indexMtimeMs = (await stat(ntPath(this.indexPath))).mtimeMs
    } catch {
      // mtime refresh is best-effort
    }
  }

  /** Run an index load→mutate→save section under the index's own lock. */
  async runLockedIndex<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(
      this.indexPath,
      fn,
      () => {
        this.deferEvent({ type: "degraded", key: "index.lock", snippet: `lock contention exceeded ${LOCK_WAIT_MS}ms; critical section ran unlocked` })
      },
      (heldMs, previousPid) => {
        this.deferEvent({ type: "repaired", key: "index.lock", snippet: `stale lock stolen (held ${heldMs}ms, previous pid ${previousPid || "?"})` })
      },
    )
  }

  /** Log critical section under the log lock, reporting degradation. The log
   * lock is a leaf (never held while holding gates/index), shared by every
   * window on the global log — contention here must be as visible as the gates
   * lock's, or unlocked interleaving (broken JSON lines) goes unexplained. The
   * degrade event is deferred and flushed by the next log()/flushDeferred(). */
  private async withLogLock<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(this.logPath, fn, () => {
      this.deferEvent({ type: "degraded", key: "log.lock", snippet: `log lock contention exceeded ${LOCK_WAIT_MS}ms; append ran unlocked` })
    })
  }

  /**
   * Append under the log lock: every OpenCode window shares the global log,
   * and unlocked concurrent appends interleave into broken JSON lines.
   * Also flushes events deferred from inside the gates lock — logging there
   * extends the critical section into degrade storms. The drain happens INSIDE
   * the log lock so events deferred between the call and lock acquisition are
   * included in this flush (draining before the lock dropped them).
   */
  async log(event: LogEvent): Promise<void> {
    let salientDeferred: LogEvent[] = []
    await this.withLogLock(async () => {
      const batch = this.deferredEvents
      this.deferredEvents = []
      // Route only the deferred batch — it bypassed logAll. The direct `event`
      // is routed by the caller (logAll); mirroring it here too would write it
      // to the global log twice.
      if (this.routeSalientTo !== null) salientDeferred = batch.filter((e) => GLOBAL_LOG_EVENTS.has(e.type))
      batch.push(event)
      await mkdir(ntPath(this.dir), { recursive: true })
      for (const e of batch) {
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`
        await appendFile(ntPath(this.logPath), line, "utf8")
      }
    })
    // Mirror runs after our own log lock releases — leaf locks, one at a time.
    if (salientDeferred.length > 0 && this.routeSalientTo !== null) await this.routeSalientTo.appendBatch(salientDeferred)
  }

  /**
   * Caller must hold the lock. Weak one-off patterns (below the promotion
   * threshold, never enforced) rot faster than proven ones — a pattern that
   * never recurred enough to matter is noise, not memory.
   */
  async expire(ttlDays: number, noiseTtlDays: number): Promise<Gate[]> {
    const gates = await this.loadForMutation()
    const now = Date.now()
    const expired = gates.filter((g) => gateExpirable(g, ttlDays, noiseTtlDays, now))
    if (expired.length === 0) return []
    const expiredKeys = new Set(expired.map((g) => g.key))
    this.gates = gates.filter((g) => !expiredKeys.has(g.key))
    this.keyIndex = null
    this.enforcedCache = null
    this.revision++
    await this.save()
    return expired
  }

  /** Remove gates by key; caller must hold the lock. Returns the removed gates. */
  extract(keys: Set<string>): Gate[] {
    if (this.gates === null) return []
    const removed = this.gates.filter((g) => keys.has(g.key))
    if (removed.length > 0) {
      this.gates = this.gates.filter((g) => !keys.has(g.key))
      this.keyIndex = null
      this.enforcedCache = null
      this.revision++
    }
    return removed
  }

  async rotateLog(rotateBytes: number = LOG_ROTATE_BYTES): Promise<void> {
    await this.withLogLock(async () => {
      try {
        const info = await stat(ntPath(this.logPath))
        if (info.size < rotateBytes) return
        const raw = await readFile(ntPath(this.logPath), "utf8")
        const lines = raw.split("\n").filter((l) => l.trim() !== "")
        const kept = lines.slice(-LOG_ROTATE_KEEP_LINES)
        await atomicWrite(this.logPath, `${kept.join("\n")}\n`)
      } catch {
        // missing or unreadable log is fine
      }
    })
  }

  /** Scrub historical log lines in place (sanitizeForStore: secrets + control
   * chars). Under the log lock, atomic write; a missing or unreadable log is a no-op. */
  async scrubLog(): Promise<void> {
    await this.withLogLock(async () => {
      let raw: string
      try {
        raw = await readFile(ntPath(this.logPath), "utf8")
      } catch {
        // missing or unreadable log — nothing to scrub
        return
      }
      const scrubbed = raw.split("\n").map((line) => sanitizeForStore(line)).join("\n")
      if (scrubbed !== raw) await atomicWrite(this.logPath, scrubbed)
    })
  }

  /**
   * Structural self-healing (idempotent): unparseable gates.json is
   * quarantined with its bytes preserved; parseable records are coerced,
   * repaired and deduped; unparseable log lines are excised to
   * log.jsonl.corrupt. Every repair is logged — healing must be visible.
   */
  async reconcile(): Promise<void> {
    // runLocked (not bare withLock) so stale-steal/degrade are reported.
    await this.runLocked(async () => {
      let raw: string | null = null
      let mtimeMs = 0
      try {
        const info = await stat(ntPath(this.gatesPath))
        mtimeMs = info.mtimeMs
        raw = await readFile(ntPath(this.gatesPath), "utf8")
      } catch {
        // no gates file yet — nothing structural to heal
      }
      if (raw !== null && raw.trim() !== "") {
        let parsed: Partial<GatesFile> | null = null
        try {
          parsed = JSON.parse(raw) as Partial<GatesFile>
        } catch {
          parsed = null
        }
        if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.gates)) {
          await this.quarantineGatesFile(raw)
        } else {
          // Preserve the migration stamp: reconcile parses the file directly
          // (bypassing load()) and save() only writes the stamp it knows — if
          // we dropped it here, the next migrate() would re-run its full scan
          // on every startup, killing the init-storm optimization.
          this.migratedStamp = typeof parsed.migrated === "string" ? parsed.migrated : null
          let dropped = 0
          let repaired = 0
          const byKey = new Map<string, Gate>()
          for (const record of parsed.gates) {
            const gate = coerceGateShape(record)
            if (gate === null) {
              dropped += 1
              continue
            }
            if (repairGate(gate)) repaired += 1
            const existing = byKey.get(gate.key)
            if (existing) {
              mergeGate(existing, gate)
            } else {
              byKey.set(gate.key, gate)
            }
          }
          const merged = parsed.gates.length - dropped - byKey.size
          // reconcile parses past load(), so the persisted relative dirs need the same absolutize step
          const repoRoot = this.repoRoot
          if (repoRoot !== null) {
            for (const gate of byKey.values()) gate.projects = gate.projects.map((p) => toAbsoluteDir(repoRoot, p))
          }
          if (dropped === 0 && repaired === 0 && merged === 0) {
            // no-op heal skips the rewrite; the parsed view refreshes the cache like save() would
            this.gates = [...byKey.values()]
            this.keyIndex = new Map(this.gates.map((g) => [g.key, g]))
            this.enforcedCache = this.gates.filter((g) => g.status !== "watching")
            this.mtimeMs = mtimeMs
            this.revision++
            this.cacheUntilMs = Date.now() + LOAD_CACHE_TTL_MS
            // a version bump is a real change even on a quiet store — stamp once
            if (parsed.lastInitVersion !== PLUGIN_VERSION) await this.save()
            return
          }
          this.gates = [...byKey.values()]
          this.mtimeMs = 0
          await this.save()
          this.deferEvent({
            type: "repaired",
            key: "gates.json",
            snippet: `dropped ${dropped} hopeless record(s), repaired ${repaired}, merged ${merged} duplicate key(s)`,
          })
        }
      }
    })
    // Log hygiene runs OUTSIDE the gates lock: the log lock is a leaf, and
    // holding the gates lock across a full log read+parse+rewrite extends the
    // critical section exactly at init-storm time (round-4 lesson).
    await this.exciseCorruptLogLines()
  }

  /**
   * SQLite-style quarantine: unparseable gates bytes move aside (scrubbed —
   * they may carry unredacted secrets), a clean empty store starts. Caller
   * must hold the store lock. Never destroys the bytes.
   */
  private async quarantineGatesFile(raw: string): Promise<void> {
    const quarantine = `${this.gatesPath}.corrupt-${Date.now()}`
    try {
      await writeFile(ntPath(quarantine), scrubSecrets(raw), "utf8")
      await unlink(ntPath(this.gatesPath))
      this.gates = []
      this.keyIndex = new Map()
      this.enforcedCache = []
      this.mtimeMs = 0
      this.migratedStamp = null
      await this.save()
      this.deferEvent({ type: "quarantined", key: "gates.json", snippet: `unparseable gates file quarantined (scrubbed) to ${quarantine}` })
    } catch {
      // quarantine failed — next reconcile retries; never destroy the file
    }
  }

  /** Move unparseable JSONL lines to log.jsonl.corrupt; good lines stay.
   * The read happens INSIDE the log lock: reading outside and rewriting
   * inside dropped every line another window appended between the two
   * (concurrent OpenCode startups all reconcile at once). */
  private async exciseCorruptLogLines(): Promise<void> {
    let excised = 0
    await this.withLogLock(async () => {
      let raw: string
      try {
        raw = await readFile(ntPath(this.logPath), "utf8")
      } catch {
        return // no log yet
      }
      const good: string[] = []
      const bad: string[] = []
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (trimmed === "") continue
        // glued objects ({a}{b}) keep the envelope — the glue check routes them to a full parse
        if (trimmed.startsWith("{") && trimmed.endsWith("}") && !/\}\s*\{/.test(trimmed)) {
          good.push(line)
          continue
        }
        try {
          JSON.parse(line)
          good.push(line)
        } catch {
          bad.push(line)
        }
      }
      if (bad.length === 0) return
      // Scrub: excised raw lines may carry unredacted secrets.
      await appendFile(ntPath(`${this.logPath}.corrupt`), `${scrubSecrets(bad.join("\n"))}\n`, "utf8")
      await atomicWrite(this.logPath, good.length > 0 ? `${good.join("\n")}\n` : "")
      excised = bad.length
    })
    if (excised > 0) {
      this.deferEvent({ type: "repaired", key: "log.jsonl", snippet: `excised ${excised} corrupt line(s) to log.jsonl.corrupt` })
    }
  }
}

/** Merge a gate's accumulated evidence into an existing gate with the same key. */
export function mergeGate(target: Gate, source: Gate): void {
  // Rank-preserving: blocking > reminding > watching — a merge never demotes
  // (a reminding source merged into a watching target used to lose its tier).
  if (source.status === "blocking" || (source.status === "reminding" && target.status === "watching")) {
    target.status = source.status
  }
  target.count += source.count
  for (const session of source.sessions) {
    if (!target.sessions.includes(session)) target.sessions.push(session)
  }
  if (target.sessions.length > MAX_SESSIONS) target.sessions = target.sessions.slice(-MAX_SESSIONS)
  for (const project of source.projects) {
    if (!target.projects.includes(project)) target.projects.push(project)
  }
  if (target.projects.length > MAX_PROJECTS) target.projects = target.projects.slice(-MAX_PROJECTS)
  if (source.firstSeen < target.firstSeen) target.firstSeen = source.firstSeen
  if (source.lastSeen > target.lastSeen) {
    target.lastSeen = source.lastSeen
    target.snippet = source.snippet
  }
  target.remindedCount += source.remindedCount
  target.blockedCount += source.blockedCount
  target.recurredAfterReminder += source.recurredAfterReminder
  target.recurredAfterGate += source.recurredAfterGate
  target.overrideCount += source.overrideCount
  if (source.promotionCount !== undefined) {
    target.promotionCount = (target.promotionCount ?? 0) + source.promotionCount
  }
  if (source.movedOn !== undefined) target.movedOn = (target.movedOn ?? 0) + source.movedOn
  if (source.iteratedVersion !== undefined) target.iteratedVersion = Math.max(target.iteratedVersion ?? 0, source.iteratedVersion)
  // owner beats agent beats machine; equal ranks pick the newer correctionAt
  const originRank = (origin: Gate["correctionOrigin"]): number => (origin === "owner" ? 2 : origin === "agent" ? 1 : 0)
  if (
    source.correction !== undefined &&
    (target.correction === undefined ||
      originRank(source.correctionOrigin) > originRank(target.correctionOrigin) ||
      (originRank(source.correctionOrigin) === originRank(target.correctionOrigin) &&
        (source.correctionAt ?? Number.NEGATIVE_INFINITY) > (target.correctionAt ?? Number.NEGATIVE_INFINITY)))
  ) {
    target.correction = source.correction
    target.correctionOrigin = source.correctionOrigin
    target.correctionAt = source.correctionAt
    target.correctionBaseline = source.correctionBaseline
  }
  if (source.correctionsProven !== undefined) target.correctionsProven = (target.correctionsProven ?? 0) + source.correctionsProven
  if (source.review === true) target.review = true
  // A demotion is earned behavior — merging must never launder it away.
  if (source.feedbackDemoted === true) target.feedbackDemoted = true
  // Baselines track the counters' scale: counters sum across merges, so the
  // baseline sums too (the grace-window delta is preserved).
  if (source.feedbackBaseline !== undefined) {
    if (target.feedbackBaseline === undefined) {
      target.feedbackBaseline = { recurred: source.feedbackBaseline.recurred, overrides: source.feedbackBaseline.overrides }
    } else {
      target.feedbackBaseline.recurred += source.feedbackBaseline.recurred
      target.feedbackBaseline.overrides += source.feedbackBaseline.overrides
    }
  }
  // Retirement damping baseline: keep the target's if present (its count already
  // anchors it); otherwise adopt the source's. Never fabricate one — merging
  // retired gates is rare (dedupe/escalation) and a wrong baseline would either
  // re-open the oscillation or lock the gate out of re-promotion.
  if (target.retireBaseline === undefined && source.retireBaseline !== undefined) {
    target.retireBaseline = { count: source.retireBaseline.count, ...(source.retireBaseline.movedOn !== undefined ? { movedOn: source.retireBaseline.movedOn } : {}) }
  }
  // Session enforcement state must survive merges — dropping it silently
  // resets the remind→block chain on every escalation/dedupe.
  if (source.remindedSessions !== undefined) {
    if (target.remindedSessions === undefined) target.remindedSessions = {}
    for (const session of Object.keys(source.remindedSessions)) {
      const at = source.remindedSessions[session] ?? 0
      const existing = target.remindedSessions[session]
      if (existing === undefined || at > existing) target.remindedSessions[session] = at
    }
  }
  if (source.failedSessions !== undefined) {
    if (target.failedSessions === undefined) target.failedSessions = {}
    for (const session of Object.keys(source.failedSessions)) {
      const entry = source.failedSessions[session]
      if (entry === undefined) continue
      const existing = target.failedSessions[session]
      if (existing === undefined || failedAtMs(entry) > failedAtMs(existing)) target.failedSessions[session] = entry
    }
  }
  if (source.reoffenseSessions !== undefined) {
    if (target.reoffenseSessions === undefined) target.reoffenseSessions = []
    for (const session of source.reoffenseSessions) {
      if (!target.reoffenseSessions.includes(session)) target.reoffenseSessions.push(session)
    }
    if (target.reoffenseSessions.length > MAX_SESSIONS) target.reoffenseSessions = target.reoffenseSessions.slice(-MAX_SESSIONS)
  }
  if (source.overrideSessions !== undefined) {
    if (target.overrideSessions === undefined) target.overrideSessions = []
    for (const session of source.overrideSessions) {
      if (!target.overrideSessions.includes(session)) target.overrideSessions.push(session)
    }
    if (target.overrideSessions.length > MAX_SESSIONS) target.overrideSessions = target.overrideSessions.slice(-MAX_SESSIONS)
  }
}

/**
 * Enforcement feedback (the negative twin of `healed`): a gate that keeps
 * failing after promotion, or keeps getting explicitly bypassed, is friction
 * — it does not teach. Demote to watching and mark `feedbackDemoted` so the
 * promotion logic never re-enforces it mechanically. The baseline records
 * WHERE the counters stood at demotion: a human re-enforcement starts a fresh
 * grace window instead of re-demoting on the next failure.
 *
 * Recurrence demotion additionally requires DISTINCT reoffense sessions
 * (failures after a reminder — failures the gate had a chance to prevent):
 * first-encounter failures never saw a reminder and must not demote, and one
 * bad session/model in a shared store must not demote a gate for everyone.
 * Returns true when the gate changed; the caller saves and logs.
 */
export function checkFeedbackDemotion(gate: Gate): boolean {
  if (gate.status === "watching") return false
  const baseRecurred = gate.feedbackBaseline?.recurred ?? 0
  const baseOverrides = gate.feedbackBaseline?.overrides ?? 0
  const recurredEnough = gate.recurredAfterGate - baseRecurred >= DEMOTE_RECURRENCES
  const reoffenseVotes = gate.reoffenseSessions?.length ?? 0
  // Legacy fallback: the override hook ALWAYS records overrideSessions alongside
  // the count, so a missing array means the overrides predate session tracking —
  // their distinct-session vote can never reach the bar, and the raw count is
  // the best available evidence. (reoffenseSessions legitimately stays absent
  // on current data — first-encounter failures never vote — so recurrence keeps
  // the strict session requirement.)
  const overrideVotes = gate.overrideSessions === undefined ? DEMOTE_OVERRIDE_SESSIONS : gate.overrideSessions.length
  const overridesEnough =
    gate.status === "reminding"
      ? (gate.overrideSessions?.length ?? 0) >= DEMOTE_OVERRIDES_REMINDING
      : gate.overrideCount - baseOverrides >= DEMOTE_OVERRIDES && overrideVotes >= DEMOTE_OVERRIDE_SESSIONS
  if ((recurredEnough && reoffenseVotes >= DEMOTE_REOFFENSE_SESSIONS) || overridesEnough) {
    gate.status = "watching"
    gate.feedbackDemoted = true
    gate.feedbackBaseline = { recurred: gate.recurredAfterGate, overrides: gate.overrideCount }
    return true
  }
  return false
}

/**
 * Soft retirement (taught): the reminder works, so the agent changed behavior
 * and no success will ever heal the gate. Demote to watching and capture a
 * re-promotion damping baseline. No feedbackDemoted mark — re-promotion on a
 * fresh bar of failures stays possible. Caller saves and logs.
 */
export function retireTaught(gate: Gate): void {
  gate.status = "watching"
  gate.retireBaseline = { count: gate.count, ...(gate.movedOn !== undefined ? { movedOn: gate.movedOn } : {}) }
}

/**
 * Anti-nag retirement (the negative twin of taught): reminders are consistently
 * ignored, so the gate nags instead of teaching. Demote to watching, mark
 * feedbackDemoted (no mechanical re-promotion — behavior already voted against
 * it), capture the feedback baseline, and reset the reminder counters so a
 * manual re-enforce gets a genuinely fresh start. Returns the pre-reset counts
 * for the caller's log snippet. Caller saves and logs.
 */
export function retireAntiNag(gate: Gate): { reminded: number; reoffended: number } {
  const reminded = gate.remindedCount
  const reoffended = gate.recurredAfterReminder
  gate.status = "watching"
  gate.feedbackDemoted = true
  gate.feedbackBaseline = { recurred: gate.recurredAfterGate, overrides: gate.overrideCount }
  gate.remindedCount = 0
  gate.recurredAfterReminder = 0
  return { reminded, reoffended }
}

/**
 * Lesson lifecycle verdict for a gate's correction (report-only signal):
 * proven — a success followed the authored correction; repromoted — the gate
 * re-enforced since the correction was written, so the text may predate the
 * current failure mode; stale — recurrences continued despite it; dormant —
 * watching, quiet and past STALE_LESSON_DAYS; else fresh.
 */
export function lessonStaleness(gate: Gate, now: number): "fresh" | "proven" | "repromoted" | "stale" | "dormant" {
  if ((gate.correctionsProven ?? 0) > 0) return "proven"
  if (gate.correction !== undefined && !isAutoCorrection(gate)) {
    if ((gate.promotionCount ?? 0) - (gate.correctionBaseline?.promoted ?? gate.promotionCount ?? 0) >= 1) return "repromoted"
    if (Math.max(0, gate.recurredAfterGate - (gate.correctionBaseline?.recurred ?? 0)) >= DEMOTE_RECURRENCES) return "stale"
  }
  if (gate.status === "watching" && gate.recurredAfterGate === 0 && gate.correctionAt !== undefined && now - gate.correctionAt > STALE_LESSON_DAYS * DAY_MS) {
    return "dormant"
  }
  return "fresh"
}

/**
 * Two-scope gate management: project-local gates live in the repo
 * (`.opencode/dejavu/`), cross-project agent habits are promoted to the
 * global store (`~/.config/opencode/dejavu/`).
 */
export class Stores {
  constructor(
    public readonly globalStore: GateStore,
    public readonly projectStore: GateStore | null,
  ) {
    // Deferred events bypass logAll's routing, so wire the project store to
    // mirror its salient deferred events (demoted in migrate, retired-healed in
    // expireAll) into the global forensics. The global store gets no peer — it
    // must never route to itself.
    if (this.projectStore !== null && this.projectStore !== this.globalStore) {
      this.projectStore.routeSalientTo = this.globalStore
    }
  }

  private scopes(): GateStore[] {
    return this.projectStore ? [this.projectStore, this.globalStore] : [this.globalStore]
  }

  /** Combined token df over every visible scope (maps and totals summed) —
   * the corpus the rare-token veto measures rarity against. */
  private combinedDfIndex(): DfIndex {
    const df = new Map<string, number>()
    let total = 0
    for (const store of this.scopes()) {
      const scope = store.dfIndex()
      for (const [token, count] of scope.df) df.set(token, (df.get(token) ?? 0) + count)
      total += scope.total
    }
    return { df, total }
  }

  /** True if a pattern with this key exists in any scope (chain attribution). */
  async hasKey(key: string): Promise<boolean> {
    for (const store of this.scopes()) {
      await store.load()
      if (store.byKey(key) !== undefined) return true
    }
    return false
  }

  /** Exact key match first (any status), then fuzzy near-duplicate over blocking gates. */
  async findGate(
    key: string,
    signature: string,
  ): Promise<{ gate: Gate; store: GateStore; via: "exact" | "fuzzy" } | null> {
    for (const store of this.scopes()) {
      await store.load()
      const exact = store.byKey(key)
      if (exact) return { gate: exact, store, via: "exact" }
    }
    // Over-long signatures match exactly only — see FUZZY_MAX_LEN.
    if (signature.length > FUZZY_MAX_LEN) return null
    // Over-generic bash shapes match exactly only: fuzzy-matching them onto
    // concrete gates would enforce/pollute unrelated calls (family noise).
    if (signature.startsWith("bash:") && !hasResidualIdentity(signature)) return null
    if (isGenericSignature(signature) && !hasGenericResidualIdentity(signature)) return null
    let best: { gate: Gate; store: GateStore; score: number } | null = null
    const df = this.combinedDfIndex()
    for (const store of this.scopes()) {
      for (const gate of store.enforcedOnly()) {
        if (!fuzzySimilar(signature, gate.signature, df)) continue
        const score = Math.abs(signature.length - gate.signature.length)
        if (best === null || score < best.score) best = { gate, store, score }
      }
    }
    return best === null ? null : { gate: best.gate, store: best.store, via: "fuzzy" }
  }

  /** All currently enforced gates (blocking + reminding), project scope first, highest-count first. */
  async enforcedGates(): Promise<Gate[]> {
    const result: Gate[] = []
    for (const store of this.scopes()) {
      await store.load()
      for (const gate of store.enforcedOnly()) result.push(gate)
    }
    return result.sort((a, b) => b.count - a.count)
  }

  async logAll(event: LogEvent): Promise<void> {
    if (this.projectStore) {
      // Project log keeps the complete forensics (low contention). The global
      // log is shared by every window of every project — the most-contended
      // lock — so it only gets the events that change what the machine
      // remembers. Detected/reminded/blocked are high-volume and stay local.
      await this.projectStore.log(event)
      if (GLOBAL_LOG_EVENTS.has(event.type)) await this.globalStore.log(event)
    } else {
      // Sole store: it is the only forensics — keep everything.
      await this.globalStore.log(event)
    }
  }

  async expireAll(ttlDays: number, noiseTtlDays: number): Promise<void> {
    let anyExpired = false
    const peekedKeys = new Set<string>()
    const now = Date.now()
    for (const store of this.scopes()) {
      // day-scale TTLs: an unlocked load() peek skips the locked pass when nothing is expirable
      const gates = await store.load()
      for (const gate of gates) peekedKeys.add(gate.key)
      if (!gates.some((g) => gateExpirable(g, ttlDays, noiseTtlDays, now))) continue
      await store.runLocked(async () => {
        const expired = await store.expire(ttlDays, noiseTtlDays)
        if (expired.length === 0) return
        anyExpired = true
        for (const gate of expired) {
          // Correction lifecycle: a corrected gate that never recurred after
          // promotion means the pattern died out — the mechanical signal that
          // the teaching worked. Deferred: logging under the gates lock
          // extends the critical section (a big sweep = N log-lock takes).
          if (gate.correction !== undefined && gate.recurredAfterGate === 0 && (gate.promotionCount ?? 0) > 0) {
            store.deferEvent({ type: "retired-healed", key: gate.key, tool: gate.tool, snippet: gate.correction.slice(0, 200) })
          } else {
            store.deferEvent({ type: "expired", key: gate.key, tool: gate.tool, ...expiryTombstone(gate) })
          }
        }
      })
    }
    if (!anyExpired && !(await this.indexSweepPending(peekedKeys, ttlDays, now))) return
    // Keys this process can see (own project + global). A key absent here may
    // still live in another project's store — orphan pruning is therefore a
    // time-decayed candidacy, not an immediate delete.
    const visibleKeys = new Set<string>()
    for (const store of this.scopes()) {
      for (const gate of await store.load()) visibleKeys.add(gate.key)
    }
    // The cross-project index rots on the same schedule as the gates.
    await this.globalStore.runLockedIndex(async () => {
      const index = await this.globalStore.loadIndexForMutation()
      const now = Date.now()
      const cutoff = now - ttlDays * DAY_MS
      let changed = false
      for (const key of Object.keys(index.keys)) {
        const entry = index.keys[key]
        if (!entry) continue
        if (Date.parse(entry.lastSeen) < cutoff) {
          delete index.keys[key]
          changed = true
          continue
        }
        if (visibleKeys.has(key)) {
          if (entry.orphanCandidateSince !== undefined) {
            delete entry.orphanCandidateSince
            changed = true
          }
          continue
        }
        if (entry.orphanCandidateSince === undefined) {
          entry.orphanCandidateSince = now
          changed = true
        } else if (now - entry.orphanCandidateSince > ORPHAN_CANDIDATE_DAYS * DAY_MS) {
          delete index.keys[key]
          changed = true
        }
      }
      if (changed) await this.globalStore.saveIndex()
    })
  }

  /** Routing-hint peek: true when the locked index sweep has TTL rot or a candidacy flip to act on. */
  private async indexSweepPending(visibleKeys: Set<string>, ttlDays: number, now: number): Promise<boolean> {
    const index = await this.globalStore.loadIndex()
    const cutoff = now - ttlDays * DAY_MS
    for (const key of Object.keys(index.keys)) {
      const entry = index.keys[key]
      if (!entry) continue
      if (Date.parse(entry.lastSeen) < cutoff) return true
      if (visibleKeys.has(key)) {
        if (entry.orphanCandidateSince !== undefined) return true
        continue
      }
      if (entry.orphanCandidateSince === undefined || now - entry.orphanCandidateSince > ORPHAN_CANDIDATE_DAYS * DAY_MS) return true
    }
    return false
  }

  async rotateLogs(): Promise<void> {
    for (const store of this.scopes()) {
      // The global log aggregates every project — give it more room.
      await store.rotateLog(store === this.globalStore ? GLOBAL_LOG_ROTATE_BYTES : LOG_ROTATE_BYTES)
    }
  }

  /** Flush deferred events on every scope (timer sweeps defer expired/
   * retired-healed events that would otherwise wait for the next hook log,
   * and are lost if the process exits first). */
  async flushDeferredAll(): Promise<void> {
    for (const store of this.scopes()) {
      await store.flushDeferred()
    }
  }

  /** Forget per-session enforcement state when a session dies. */
  async forgetSession(sessionID: string): Promise<void> {
    for (const store of this.scopes()) {
      await store.runLocked(async () => {
        const gates = await store.loadForMutation()
        let changed = false
        for (const gate of gates) {
          if (gate.remindedSessions && gate.remindedSessions[sessionID] !== undefined) {
            delete gate.remindedSessions[sessionID]
            if (Object.keys(gate.remindedSessions).length === 0) delete gate.remindedSessions
            changed = true
          }
          if (gate.failedSessions !== undefined && gate.failedSessions[sessionID] !== undefined) {
            delete gate.failedSessions[sessionID]
            if (Object.keys(gate.failedSessions).length === 0) delete gate.failedSessions
            changed = true
          }
        }
        if (changed) await store.save()
      })
    }
  }

  /**
   * Idempotent schema/behavior migration:
   *  - probe-tool gates never block (they were learned under the old policy)
   *  - signatures and snippets are secret-scrubbed (cleans historical leaks)
   *  - project copies of already-global keys merge into the global gate
   * `force` re-runs the full per-gate scan even when the version stamp already
   * matches — doctor --repair and the migrate script must apply ALL healing
   * regardless of the stamp; only normal startup uses the init-storm skip.
   */
  async migrate(force = false): Promise<void> {
    for (const store of this.scopes()) {
      await store.runLocked(async () => {
        // Init-storm killer: the 2nd..Nth start of the same version skips the
        // full per-gate scan. Policy re-checks still run on every load via
        // repairGate, and new gates are created compliant, so the stamp is safe.
        if (!force && store.migratedVersion === PLUGIN_VERSION) return
        const gates = await store.loadForMutation()
        let changed = false
        for (const gate of gates) {
          // text-only evidence never blocks — demote to the highest tier the shape still earns
          if (gate.status === "blocking" && gate.textOnly === true) {
            gate.status = canRemind(gate.tool, gate.signature) ? "reminding" : "watching"
            changed = true
            store.deferEvent({
              type: "demoted",
              key: gate.key,
              tool: gate.tool,
              snippet: "text-only evidence demotion (no exit code, no structural signal — the text channel may remind at most)",
            })
          }
          // legacy pre-field gates: echoed failure text is not a teachable failure
          if (gate.status === "blocking" && gate.textOnly === undefined && isLiteralOutputSignature(gate.signature)) {
            gate.status = "watching"
            changed = true
            store.deferEvent({
              type: "demoted",
              key: gate.key,
              tool: gate.tool,
              snippet: "literal-output demotion (echo/printf family — echoed failure text is not a teachable failure)",
            })
          }
          if (gate.status === "blocking" && !canBlock(gate.tool, gate.signature)) {
            // Over-blocking learned under an older policy: keep the signal if
            // the shape can at least remind (diagnostics), else drop to watching.
            gate.status = canRemind(gate.tool, gate.signature) ? "reminding" : "watching"
            changed = true
          }
          if (gate.status === "reminding" && !canRemind(gate.tool, gate.signature)) {
            gate.status = "watching"
            changed = true
          }
          if (
            gate.status === "watching" &&
            gate.feedbackDemoted !== true &&
            gate.retireBaseline === undefined &&
            canRemind(gate.tool, gate.signature) &&
            gate.count >= promotionThreshold(gate.tool) &&
            gate.sessions.length >= PROMOTE_SESSIONS
          ) {
            // Recurring diagnostics already proven under the old policy start
            // reminding immediately instead of waiting for the next failure.
            // feedbackDemoted gates are exempt: the agent's behavior already
            // voted against enforcement — re-enforcing on every restart would
            // violate "never re-promotes mechanically".
            // retireBaseline gates are exempt for the same reason: they RETIRED
            // on evidence (healed/taught) — the lifetime count that clears this
            // bar is the pre-retirement evidence the damping baseline exists to
            // discount. Re-promoting them here on every migrate would re-open the
            // promote→heal→promote oscillation the baseline was added to kill;
            // their re-promotion must earn a fresh bar via recordFailure.
            gate.status = "reminding"
            changed = true
          }
          const signature = sanitizeForStore(gate.signature)
          const snippet = sanitizeForStore(gate.snippet)
          if (signature !== gate.signature) {
            gate.signature = signature
            changed = true
          }
          if (snippet !== gate.snippet) {
            gate.snippet = snippet
            changed = true
          }
          if (gate.correction !== undefined) {
            const correction = sanitizeForStore(gate.correction)
            if (correction !== gate.correction) {
              gate.correction = correction
              changed = true
            }
          }
          // Backfill: an enforced gate with no correction gets a mechanical
          // default so it teaches immediately instead of sitting "NOT TEACHING".
          if (gate.status !== "watching" && gate.correction === undefined) {
            gate.correction = suggestCorrection(gate.signature, gate.snippet)
            gate.correctionOrigin = "machine"
            changed = true
          }
          // Feedback catch-up: gates that already crossed the demotion
          // thresholds before the counters existed are demoted on the spot —
          // enforcement must reflect the agent's actual behavior.
          if (checkFeedbackDemotion(gate)) {
            changed = true
            store.deferEvent({
              type: "demoted",
              key: gate.key,
              tool: gate.tool,
              snippet: `feedback demotion (recurred ${gate.recurredAfterGate}, overridden ${gate.overrideCount})`,
            })
          }
        }
        // Retroactive noise cleanup: patterns the current policy classifies as
        // infrastructure noise (lsp daemon, mcp transport, non-2xx) were
        // recorded as failures by older versions and bloat the store/index.
        // Backdate them to the epoch so this init's TTL sweep expires them
        // (both dates, or repairGate's inverted-date swap would undo it).
        const epoch = new Date(0).toISOString()
        for (const gate of gates) {
          if (isNoiseError(gate.signature) || isNoiseError(gate.snippet)) {
            gate.firstSeen = epoch
            gate.lastSeen = epoch
            changed = true
          }
        }
        // Stamp the migration and persist repairs (save is idempotent when
        // nothing changed beyond the stamp itself).
        store.migratedVersion = PLUGIN_VERSION
        changed = true
        if (changed) await store.save()
      })
    }

    // A key that reached the global store is global everywhere: merge any
    // leftover project-local copy into the global gate so evidence does not
    // fragment across scopes (stale local copies kept enforcing from the old
    // scope while the global gate starved).
    const projectStore = this.projectStore
    if (projectStore) {
      await projectStore.runLocked(async () => {
        const projGates = await projectStore.loadForMutation()
        const globalKeys = new Set((await this.globalStore.load()).map((g) => g.key))
        const dupes = projGates.filter((g) => globalKeys.has(g.key))
        if (dupes.length === 0) return
        await this.globalStore.runLocked(async () => {
          const globalGates = await this.globalStore.loadForMutation()
          for (const dupe of dupes) {
            const target = globalGates.find((g) => g.key === dupe.key)
            if (target) {
              mergeGate(target, dupe)
            } else {
              globalGates.push(dupe)
            }
          }
          await this.globalStore.save()
        })
        projectStore.extract(new Set(dupes.map((g) => g.key)))
        await projectStore.save()
      })
    }
  }

  /**
   * Structural self-healing across both scopes plus index reconciliation.
   * Idempotent; runs at plugin init and via `doctor --repair`.
   */
  async reconcileAll(globalProjects = GLOBAL_PROJECTS): Promise<void> {
    for (const store of this.scopes()) {
      await store.reconcile()
    }
    if (this.projectStore) await this.projectStore.ensureGitignore()

    // Index-driven escalation healing: a key proven in enough project dirs
    // belongs in the global store even if recordFailure never moved it
    // (racing instances, or stores that predate the index).
    const projectStore = this.projectStore
    if (projectStore) {
      const index = await this.globalStore.loadIndex()
      // Non-force load: this is a routing-hint read (the authoritative
      // loadForMutation() happens under the locks below). The force path would
      // quarantine an unparseable file WITHOUT the gates lock — the very
      // write-without-lock class round 3 fixed in doctor.
      const toEscalate = (await projectStore.load()).filter((g) => {
        const entry = index.keys[g.key]
        // Count only project dirs that still exist on disk (ghost dirs from
        // renamed/moved repos must not strengthen escalation).
        return (
          entry !== undefined &&
          entry.projects.filter((p) => existsSync(p)).length >= globalProjects &&
          !isRepoLocal(g.signature)
        )
      })
      if (toEscalate.length > 0) {
        const escalateKeys = new Set(toEscalate.map((g) => g.key))
        let escalated = 0
        await projectStore.runLocked(async () => {
          // re-resolve from a mutation read under the lock — an unlocked peek must never feed a locked save()
          const freshEscalate = (await projectStore.loadForMutation()).filter((g) => escalateKeys.has(g.key))
          if (freshEscalate.length === 0) return
          escalated = freshEscalate.length
          await this.globalStore.runLocked(async () => {
            const globalGates = await this.globalStore.loadForMutation()
            for (const gate of freshEscalate) {
              const target = globalGates.find((g) => g.key === gate.key)
              if (target) {
                mergeGate(target, gate)
              } else {
                globalGates.push(gate)
              }
            }
            await this.globalStore.save()
          })
          projectStore.extract(new Set(freshEscalate.map((g) => g.key)))
          await projectStore.save()
        })
        if (escalated > 0) {
          await this.globalStore.log({
            type: "repaired",
            key: "index.json",
            snippet: `escalated ${escalated} gate(s) proven in ${globalProjects}+ project dirs`,
          })
        }
      }
    }

    // The index must mirror reality: a global gate missing from the index
    // loses cross-project history — rebuild it. No orphan pruning here: this
    // process sees ONE project store + global, so an index key whose gate
    // lives in ANOTHER project is invisible, not dead — pruning it would
    // destroy cross-project escalation evidence. Genuine rot is handled by
    // the TTL sweep in expireAll; doctor reports true orphans across ALL
    // scopes (it discovers them from the index itself).
    // Log OUTSIDE the index lock (the log lock is the most-contended lock;
    // acquiring it while holding the index lock extends the index critical
    // section at exactly init-storm time).
    let rebuilt = 0
    await this.globalStore.runLockedIndex(async () => {
      const index = await this.globalStore.loadIndexForMutation()
      // Non-force load: we hold the INDEX lock, not the gates lock — the force
      // path could quarantine global gates.json without its lock. reconcile()
      // refreshed this cache moments ago, so the peek is fresh.
      for (const gate of await this.globalStore.load()) {
        if (!index.keys[gate.key]) {
          index.keys[gate.key] = { projects: [...gate.projects], lastSeen: gate.lastSeen }
          rebuilt += 1
        }
      }
      if (rebuilt > 0) await this.globalStore.saveIndex()
    })
    if (rebuilt > 0) {
      await this.globalStore.log({
        type: "repaired",
        key: "index.json",
        snippet: `rebuilt ${rebuilt} missing index entr(y/ies)`,
      })
    }
  }

  async recordFailure(input: {
    key: string
    signature: string
    tool: string
    sessionID: string
    projectDir: string
    snippet: string
    globalProjects: number
    /** the failure's only evidence is output text — no exit code, no structural errored signal */
    textOnly?: boolean
    /** process-local workspace version (landed edit/write count) — iteration evidence */
    workspaceVersion?: number
  }): Promise<{ gate: Gate; store: GateStore; promoted: boolean; wentGlobal: boolean; iterated: boolean }> {
    const now = new Date().toISOString()
    // Route to the store that already knows this key (cheap unlocked peek).
    let store = this.projectStore ?? this.globalStore
    await store.load()
    if (store.byKey(input.key) === undefined) {
      await this.globalStore.load()
      if (this.globalStore.byKey(input.key) !== undefined) {
        store = this.globalStore
      }
    }

    // FLAT lock phases — the previous implementation held the project gates
    // lock across the index lock + the global gates lock + two saves: the
    // longest critical section in the system, and every other window's waiter
    // degraded to unlocked after LOCK_WAIT_MS (the lost-update window the
    // `degraded` event documents). Each phase now holds exactly one lock.
    // Race windows introduced are benign/self-healing:
    //  (a) a failure landing between the Phase-1 save and the Phase-3 extract
    //      adds at most one concurrent failure's evidence delta to a gate that
    //      is about to move — the pattern re-converges from its next failure;
    //  (b) a concurrent escalation of the same key just merges (mergeGate);
    //  (c) if the gate vanishes between phases (flood eviction / migrate), the
    //      escalation aborts — a duplicate heals, never a hole.
    // Phase 1 — this store's gates lock (short): find/create/mutate the gate,
    // promotion, save. Returns the mutated gate (or an ephemeral gate that is
    // never persisted when the flood guard leaves no eviction candidate).
    const phase1 = await store.runLocked(async (): Promise<{ moved: Gate | null; ephemeral: Gate | null; promoted: boolean; iterated: boolean }> => {
      let promoted = false
      let iterated = false
      let evictedGate: Gate | null = null
      let ephemeral: Gate | null = null
      const gates = await store.loadForMutation()
      let gate = gates.find((g) => g.key === input.key)
      let fuzzyConsolidated = false
      // Consolidation: same tool + near-duplicate signature merges into the
      // existing pattern instead of fragmenting ("gradlew :x:compiletestjava").
      if (!gate) {
        // Prefer the gate this session was already reminded about: the
        // before-hook enforced from it, so the failure must land there too —
        // otherwise the remind→block chain desyncs between the hooks.
        // Over-generic bash shapes never consolidate into concrete gates:
        // family noise must not inflate a specific call's evidence.
        const fuzzyAllowed = input.tool === "bash" ? hasResidualIdentity(input.signature) : !isGenericSignature(input.signature) || hasGenericResidualIdentity(input.signature)
        const df = fuzzyAllowed ? this.combinedDfIndex() : undefined
        const fuzzyMatches = fuzzyAllowed ? gates.filter((g) => g.tool === input.tool && fuzzySimilar(input.signature, g.signature, df)) : []
        gate = fuzzyMatches.find((g) => g.remindedSessions?.[input.sessionID] !== undefined) ?? fuzzyMatches[0]
        if (gate !== undefined) fuzzyConsolidated = true
      }
      if (!gate) {
        // Flood guard: unique-failure spam must not grow the store unbounded.
        if (gates.length >= MAX_GATES) {
          let victimIdx = -1
          for (let i = 0; i < gates.length; i++) {
            const candidate = gates[i]
            if (candidate === undefined || candidate.status !== "watching") continue
            const victim = victimIdx >= 0 ? gates[victimIdx] : undefined
            if (victim === undefined) {
              victimIdx = i
              continue
            }
            // Feedback-demoted gates already proved unteachable — evict them
            // before evidence still trying to teach (under the old
            // lowest-count rule they were the STICKIEST residents: high
            // count, demoted, never enforcing).
            const candidateDemoted = candidate.feedbackDemoted === true
            const victimDemoted = victim.feedbackDemoted === true
            if (candidateDemoted !== victimDemoted) {
              if (candidateDemoted) victimIdx = i
              continue
            }
            if (candidate.count < victim.count || (candidate.count === victim.count && candidate.lastSeen < victim.lastSeen)) {
              victimIdx = i
            }
          }
          if (victimIdx < 0) {
            // Every gate is enforced — do not create; degrade gracefully with
            // an ephemeral gate that is never persisted.
            ephemeral = {
              key: input.key,
              signature: sanitizeForStore(input.signature),
              tool: input.tool,
              status: "watching",
              count: 1,
              sessions: [input.sessionID],
              projects: input.projectDir !== "" ? [input.projectDir] : [],
              firstSeen: now,
              lastSeen: now,
              snippet: sanitizeForStore(input.snippet),
              remindedCount: 0,
              blockedCount: 0,
              recurredAfterReminder: 0,
              recurredAfterGate: 0,
              overrideCount: 0,
            }
            return { moved: null, ephemeral, promoted: false, iterated: false }
          }
          evictedGate = gates[victimIdx] ?? null
        }
        gate = {
          key: input.key,
          signature: sanitizeForStore(input.signature),
          tool: input.tool,
          status: "watching",
          count: 0,
          sessions: [],
          projects: [],
          firstSeen: now,
          lastSeen: now,
          snippet: sanitizeForStore(input.snippet),
          remindedCount: 0,
          blockedCount: 0,
          recurredAfterReminder: 0,
          recurredAfterGate: 0,
          overrideCount: 0,
        }
        gates.push(gate)
        // extract AFTER the push: extract() reassigns the store's live gate
        // array — removing before the push would orphan this local array and
        // lose the new gate. extract (not a bare splice) also drops the key
        // index and the enforced cache — a bare splice left byKey() returning
        // the removed gate, and the pattern's next failure re-landed on a
        // detached duplicate (lost evidence).
        if (evictedGate !== null) {
          store.extract(new Set([evictedGate.key]))
          store.deferEvent({
            type: "expired",
            key: evictedGate.key,
            tool: evictedGate.tool,
            snippet: `flood guard evicted this watching gate to stay at ${MAX_GATES}`,
            ...expiryTombstone(evictedGate),
          })
        }
      }

      gate.count += 1
      if (!gate.sessions.includes(input.sessionID)) gate.sessions.push(input.sessionID)
      if (gate.sessions.length > MAX_SESSIONS) gate.sessions = gate.sessions.slice(-MAX_SESSIONS)
      if (input.projectDir !== "" && !gate.projects.includes(input.projectDir)) {
        gate.projects.push(input.projectDir)
        if (gate.projects.length > MAX_PROJECTS) gate.projects = gate.projects.slice(-MAX_PROJECTS)
      }
      gate.lastSeen = now
      // Iteration detection: the workspace moved since the last recorded failure
      // (a landed edit/write) or the error form changed — the call is being
      // debugged, not blindly retried; iteration must not build stuck pressure.
      // The version counter is process-local: after a restart the stored version
      // exceeds the fresh one (reads as "no movement" once), then self-heals.
      const newSnippet = sanitizeForStore(input.snippet)
      const versionMoved = input.workspaceVersion !== undefined && gate.iteratedVersion !== undefined && input.workspaceVersion > gate.iteratedVersion
      const errorMoved =
        looksLikeFailure(newSnippet) &&
        looksLikeFailure(gate.snippet) &&
        !isBareExitSnippet(newSnippet) &&
        !isBareExitSnippet(gate.snippet) &&
        parameterizeError(newSnippet) !== parameterizeError(gate.snippet)
      iterated = versionMoved || errorMoved
      if (iterated) gate.movedOn = (gate.movedOn ?? 0) + 1
      if (input.workspaceVersion !== undefined) gate.iteratedVersion = input.workspaceVersion
      // Only an exact-key failure updates the evidence: a crafted near-duplicate
      // must not overwrite a legitimate gate's snippet via fuzzy consolidation.
      // Evidence monotonicity: a failure-shaped snippet is never displaced by a
      // success-shaped one (a pass summary must not push out the real error);
      // between two failure-shaped snippets the latest wins (freshness).
      if (!fuzzyConsolidated) {
        if (looksLikeFailure(newSnippet) || !looksLikeFailure(gate.snippet)) gate.snippet = newSnippet
      }
      // the latest failure's channel wins — a structural failure clears the flag (self-correcting)
      if (input.textOnly) gate.textOnly = true
      else delete gate.textOnly
      // A failure breaks any heal streak — the command is still broken.
      gate.succeededAfterGate = 0

      const threshold = promotionThreshold(input.tool)
      // Oscillation damping: a retired gate (healed/taught) keeps its lifetime
      // count/sessions, which already clear the promotion bar — so it would
      // re-promote on the VERY NEXT single failure (promote→heal→promote).
      // Require a full fresh bar of failures SINCE retirement instead.
      const effectiveCount = gate.retireBaseline !== undefined ? Math.max(0, gate.count - gate.retireBaseline.count) : gate.count
      // Pure-iteration evidence never enforces: every failure moved (edits or a
      // changing error form) — the call is being debugged, not blindly retried.
      // One stuck failure keeps promotion alive.
      const stuckEvidence = effectiveCount - ((gate.movedOn ?? 0) - (gate.retireBaseline?.movedOn ?? 0))
      // only bash blocks; diagnostics + identity-bearing generic tools remind; the rest watch
      if (gate.status === "watching" && gate.feedbackDemoted !== true && effectiveCount >= threshold && gate.sessions.length >= PROMOTE_SESSIONS && stuckEvidence > 1) {
        if (canBlock(gate.tool, gate.signature)) {
          // text-only evidence never blocks — output text alone cannot prove the call failed
          gate.status = gate.textOnly === true ? "reminding" : "blocking"
          promoted = true
        } else if (canRemind(gate.tool, gate.signature)) {
          gate.status = "reminding"
          promoted = true
        }
        // A promoted gate always ships with SOME teaching text (mechanical
        // default, overridable) so it never sits "NOT TEACHING" awaiting a human.
        if (promoted && (gate.correction === undefined || gate.correctionOrigin === "machine")) {
          gate.correction = suggestCorrection(gate.signature, gate.snippet)
          gate.correctionOrigin = "machine"
          if (correctionEvidencePoor(gate.signature, gate.snippet, gate.correction)) gate.review = true
        }
        // Fresh enforcement round resets round counters + chains; override friction is lifetime like promotionCount.
        if (promoted) {
          gate.promotionCount = (gate.promotionCount ?? 0) + 1
          gate.remindedCount = 0
          gate.recurredAfterReminder = 0
          gate.recurredAfterGate = 0
          gate.succeededAfterGate = 0
          delete gate.feedbackBaseline
          delete gate.reoffenseSessions
          delete gate.remindedSessions
          delete gate.failedSessions
          // Advance the damper to this promotion — re-promotion needs a full fresh bar.
          gate.retireBaseline = { ...gate.retireBaseline, count: gate.count }
        }
      }

      await store.save()
      return { moved: gate ?? null, ephemeral, promoted, iterated }
    })
    if (phase1.ephemeral !== null) return { gate: phase1.ephemeral, store, promoted: false, wentGlobal: false, iterated: false }
    if (phase1.moved === null) {
      // Unreachable: Phase 1 always yields a gate unless the ephemeral
      // early-return fired. Degrade to an ephemeral record rather than throw.
      return {
        gate: {
          key: input.key,
          signature: sanitizeForStore(input.signature),
          tool: input.tool,
          status: "watching",
          count: 1,
          sessions: [input.sessionID],
          projects: input.projectDir !== "" ? [input.projectDir] : [],
          firstSeen: now,
          lastSeen: now,
          snippet: sanitizeForStore(input.snippet),
          remindedCount: 0,
          blockedCount: 0,
          recurredAfterReminder: 0,
          recurredAfterGate: 0,
          overrideCount: 0,
        },
        store,
        promoted: false,
        wentGlobal: false,
        iterated: false,
      }
    }
    const movedGate = phase1.moved
    const promoted = phase1.promoted
    const iterated = phase1.iterated

    // Phase 2 — index lock (no gates lock held): cross-project evidence.
    // gate.projects only ever sees its own store's directory, so alone it can
    // never reach two projects. A pattern seen in enough distinct project dirs
    // is an agent-level habit, not a repo quirk — move it to the global store.
    // Keyed by the gate's OWN key (post fuzzy-consolidation), not the raw
    // failure key — otherwise consolidated failures index a key that has no
    // gate, orphaning the entry and starving the gate's escalation.
    let indexProjects = 0
    await this.globalStore.runLockedIndex(async () => {
      const index = await this.globalStore.loadIndexForMutation()
      let entry = index.keys[movedGate.key]
      // structural (new key/project) saves now — first evidence must survive a crash; lastSeen-only repeats defer
      const structural = entry === undefined || (input.projectDir !== "" && !entry.projects.includes(input.projectDir))
      if (!entry) {
        entry = { projects: [], lastSeen: now }
        index.keys[movedGate.key] = entry
      }
      if (input.projectDir !== "" && !entry.projects.includes(input.projectDir)) {
        entry.projects.push(input.projectDir)
        if (entry.projects.length > MAX_PROJECTS) entry.projects = entry.projects.slice(-MAX_PROJECTS)
      }
      entry.lastSeen = now
      if (structural) await this.globalStore.saveIndex()
      else this.globalStore.deferIndexTouch(movedGate.key, now)
      // escalation counts only dirs that still exist — ghost dirs (moved repos) must not strengthen it
      indexProjects = entry.projects.filter((p) => existsSync(p)).length
    })

    // Phase 3 — escalation (only if warranted): three short locked phases.
    let wentGlobal = false
    // Repo-local verbs (npm/git/gradle/...) never escalate: their failures are
    // repo quirks, not agent habits — escalating them would let a broken
    // `npm install` in one project block every other project.
    if (
      store !== this.globalStore &&
      this.projectStore &&
      indexProjects >= input.globalProjects &&
      !isRepoLocal(movedGate.signature)
    ) {
      // 3a — project gates lock: copy the gate fresh. If it is gone, someone
      // else escalated/expired it — abort (a duplicate heals, never a hole).
      let gateCopy: Gate | null = null
      await store.runLocked(async () => {
        const fresh = (await store.loadForMutation()).find((g) => g.key === movedGate.key)
        if (fresh !== undefined) gateCopy = JSON.parse(JSON.stringify(fresh)) as Gate
      })
      if (gateCopy !== null) {
        const copy = gateCopy
        // 3b — global gates lock FIRST: write the global copy before removing
        // the local one, so a crash between the two writes leaves a duplicate
        // (healed by migrate), never a hole.
        await this.globalStore.runLocked(async () => {
          const globalGates = await this.globalStore.loadForMutation()
          const existing = globalGates.find((g) => g.key === movedGate.key)
          if (existing) {
            mergeGate(existing, copy)
          } else {
            globalGates.push(copy)
          }
          await this.globalStore.save()
        })
        // 3c — project gates lock: remove the now-escalated local copy.
        await store.runLocked(async () => {
          await store.loadForMutation()
          // extract(), not a raw splice: it also drops the key index and the
          // enforced cache — a bare splice left byKey() returning the removed
          // gate, and the next failure re-landed on the project store as a
          // fresh duplicate (evidence fragmented across the two copies).
          store.extract(new Set([movedGate.key]))
          await store.save()
        })
        wentGlobal = true
      }
    }

    return { gate: movedGate, store, promoted, wentGlobal, iterated }
  }

  /**
   * A SUCCESS matching an enforced gate is evidence the underlying command got
   * fixed. Track a streak; once it reaches HEAL_SUCCESSES the gate retires to
   * watching so it stops reminding on a now-healthy command (the
   * `ruff check .` false-positive case). Only enforced (blocking/reminding)
   * gates heal; a failure resets the streak in recordFailure.
   *
   * A success ALSO clears the succeeding session from the remind→block chain.
   * Without this, a session that proved the fix (often via `dejavu:proceed`)
   * stayed permanently blocked and could only keep overriding — the override
   * count then demoted the very gate the agent had just vindicated. Success is
   * the proof; the chain for that session must reset.
   *
   * EXACT matches only: healing and chain-clearing are state mutations, and a
   * fuzzy-similar success is evidence about a DIFFERENT command — proxy
   * successes would heal a gate that still fails and unblock sessions that
   * never proved the gated call.
   */
  async recordSuccess(input: { key: string; signature: string; tool: string; sessionID: string }): Promise<void> {
    // Exact matches only — healing and chain-clearing are state mutations,
    // and a fuzzy-similar success is evidence about a DIFFERENT command.
    // Exact-only also lets us skip findGate's fuzzy scan entirely: this runs
    // on EVERY successful bash call, and fuzzy matches are rejected anyway.
    let owner: GateStore | null = null
    for (const scope of this.scopes()) {
      await scope.load()
      if (scope.byKey(input.key) !== undefined) {
        owner = scope
        break
      }
    }
    if (owner === null) return
    const store = owner
    const gateKey = input.key
    let healedEvent: LogEvent | null = null
    await store.runLocked(async () => {
      const fresh = (await store.loadForMutation()).find((g) => g.key === gateKey)
      if (fresh === undefined || fresh.status === "watching") return
      fresh.succeededAfterGate = (fresh.succeededAfterGate ?? 0) + 1
      if (fresh.correctionOrigin === "agent" || fresh.correctionOrigin === "owner") fresh.correctionsProven = (fresh.correctionsProven ?? 0) + 1
      if (fresh.remindedSessions !== undefined && fresh.remindedSessions[input.sessionID] !== undefined) {
        delete fresh.remindedSessions[input.sessionID]
        if (Object.keys(fresh.remindedSessions).length === 0) delete fresh.remindedSessions
      }
      if (fresh.failedSessions !== undefined && fresh.failedSessions[input.sessionID] !== undefined) {
        delete fresh.failedSessions[input.sessionID]
        if (Object.keys(fresh.failedSessions).length === 0) delete fresh.failedSessions
      }
      const healed = fresh.succeededAfterGate >= HEAL_SUCCESSES
      if (healed) {
        fresh.status = "watching"
        // Oscillation damping: capture the count at retirement so re-promotion
        // needs a full fresh bar of failures, not the very next single one.
        fresh.retireBaseline = { count: fresh.count, ...(fresh.movedOn !== undefined ? { movedOn: fresh.movedOn } : {}) }
      }
      await store.save()
      if (healed) {
        healedEvent = {
          type: "healed",
          key: fresh.key,
          tool: fresh.tool,
          snippet: `succeeded ${fresh.succeededAfterGate}x in a row after the gate — retired to watching`,
        }
      }
    })
    // Log OUTSIDE the gates lock (heals are rare but can land on a hot gate
    // while other windows wait — logging under the lock cascades contention).
    // Routed via logAll so the heal reaches the global log too (healed is
    // machine-memory-salient).
    if (healedEvent !== null) await this.logAll(healedEvent)
  }
}
