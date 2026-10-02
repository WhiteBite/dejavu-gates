/**
 * One-command pathology report for dejavu stores. Checks every invariant the
 * data model implies, so debugging starts from facts, not guesses.
 *
 * Usage: bun scripts/doctor.ts [--repair] [--prune-corrupt[=<days>]] [projectDir ...]
 *   --repair  heal first (reconcile + migrate), then report
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { CORRUPT_DEFAULT_DAYS, sweepStoreArtifacts, TMP_ORPHAN_MS } from "../src/fs"
import { canBlock, canRemind, fuzzySimilar, isRepoLocal, sanitizeForStore } from "../src/patterns"
import { createStores, DEMOTE_RECURRENCES, GateStore, GLOBAL_PROJECTS, lessonStaleness, MAX_GATES, NOISE_TTL_DAYS, resolveGlobalDir, retireTaught, PLUGIN_VERSION, PROMOTE_SESSIONS, TTL_DAYS, type Gate } from "../src/store"
import { coerceGateShape, hasNestedTokens } from "../src/validate"

const repair = process.argv.includes("--repair")
const globalDir = resolveGlobalDir()
const DAY_MS = 24 * 60 * 60 * 1000
const pruneArg = process.argv.find((a) => a === "--prune-corrupt" || a.startsWith("--prune-corrupt="))
const pruneCorrupt = pruneArg !== undefined
const pruneDaysRaw = pruneArg !== undefined ? Number(pruneArg.split("=")[1]) : Number.NaN
const pruneDays = Number.isFinite(pruneDaysRaw) && pruneDaysRaw >= 0 ? pruneDaysRaw : CORRUPT_DEFAULT_DAYS

const FILE_NOT_FOUND_CORRECTION = /can't open file|cannot find path|no such file|cannot find the (?:file|path)|ENOENT/i

/** Enforced gate whose correction teaches a file-not-found error while the
 * quoted path EXISTS again — the taught error cannot recur; the correction is
 * stale (file moved back/renamed) and the gate keeps nagging about a dead error. */
function staleCorrectionPath(gate: Gate): string | null {
  if (gate.correctionOrigin === "owner") return null
  const correction = gate.correction
  if (correction === undefined || !FILE_NOT_FOUND_CORRECTION.test(correction)) return null
  const quoted = /'([^']+)'/.exec(correction)?.[1]
  if (quoted === undefined) return null
  // Snippets persist JSON-escaped: Windows paths arrive with doubled backslashes.
  const candidate = quoted.replace(/\\\\/g, "\\")
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(candidate)) return null
  return existsSync(candidate) ? candidate : null
}

// --repair only: authored-correction claims — missing paths, malformed URLs. Flag-only.
function correctionClaims(gate: Gate, roots: readonly string[]): string[] {
  if ((gate.correctionOrigin !== "agent" && gate.correctionOrigin !== "owner") || gate.correction === undefined) return []
  const claims: string[] = []
  for (const match of gate.correction.matchAll(/['"]([^'"]+)['"]/g)) {
    const quoted = match[1]
    if (quoted === undefined) continue
    const candidate = quoted.replace(/\\\\/g, "\\")
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(candidate)) {
      if (!existsSync(candidate)) claims.push(`quoted path not found: ${candidate}`)
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.includes(" ") || !/[\\/]/.test(candidate)) continue
    if (roots.length === 0) continue
    if (!roots.some((root) => existsSync(join(root, candidate)))) claims.push(`quoted path not found: ${candidate}`)
  }
  for (const match of gate.correction.matchAll(/\bhttps?:\S+/gi)) {
    const trimmed = (match[0] ?? "").replace(/[.,;:!?)\]}'"]+$/, "")
    try {
      new URL(trimmed)
    } catch {
      claims.push(`malformed URL: ${trimmed}`)
    }
  }
  return claims
}

/** Numeric lower triple of a semver-ish range: leading ^~>=< stripped,
 * prerelease dropped. `*`/`latest`/workspace protocols are unparseable. */
function versionTriple(range: string): [number, number, number] | null {
  const cleaned = (range.trim().replace(/^[\s^~>=<]+/, "").split("-")[0] ?? "").trim()
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(cleaned)
  if (match === null) return null
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function tripleGte(declared: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const d = declared[i] ?? 0
    const m = min[i] ?? 0
    if (d !== m) return d > m
  }
  return true
}

/** True when the gate's retire_when condition holds at projectRoot. Global
 * scope (root null): met when ANY existing dir in gate.projects satisfies. */
function retireWhenMet(gate: Gate, projectRoot: string | null): boolean {
  const cond = gate.retireWhen
  if (cond === undefined) return false
  if (projectRoot === null) {
    return gate.projects.some((p) => existsSync(p) && retireWhenMet(gate, p))
  }
  if (cond.kind === "dep") {
    let raw: string
    try {
      raw = readFileSync(join(projectRoot, "package.json"), "utf8")
    } catch {
      return false
    }
    let declared: string | undefined
    try {
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
      declared = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]
        .map((deps) => deps?.[cond.name])
        .find((v): v is string => typeof v === "string")
    } catch {
      return false
    }
    if (declared === undefined) return false
    const declaredTriple = versionTriple(declared)
    const minTriple = versionTriple(cond.min)
    if (declaredTriple === null || minTriple === null) return false
    return tripleGte(declaredTriple, minTriple)
  }
  if (cond.kind === "path") {
    const present = existsSync(join(projectRoot, cond.path))
    return cond.mode === "present" ? present : !present
  }
  return spawnSync("git", ["-C", projectRoot, "rev-parse", "-q", "--verify", `refs/tags/${cond.tag}`]).status === 0
}

// Cross-store invariants need every scope visible. Without explicit args,
// discover project dirs from the global index — it is the only registry of
// which projects dejavu has seen. (Running global-only produced hundreds of
// false "index orphans": keys whose gates live in project stores.)
let projectDirs = process.argv
  .slice(2)
  .filter((a) => a !== "--repair" && a !== "--prune-corrupt" && !a.startsWith("--prune-corrupt="))
if (projectDirs.length === 0) {
  const discovered = new Set<string>()
  const index = await new GateStore(globalDir).loadIndex()
  for (const entry of Object.values(index.keys)) {
    if (!entry || !Array.isArray(entry.projects)) continue
    for (const project of entry.projects) {
      if (typeof project === "string" && existsSync(join(project, ".opencode", "dejavu"))) discovered.add(project)
    }
  }
  projectDirs = [...discovered].sort()
  if (projectDirs.length > 0) console.log(`discovered ${projectDirs.length} project store(s) from the global index`)
}

// --- repair pass (idempotent): heal structure, then policy ---
if (repair) {
  const targets = projectDirs.length > 0 ? projectDirs : [""]
  for (const dir of targets) {
    const stores = createStores(dir)
    await stores.reconcileAll()
    await stores.migrate(true)
    // Sweep expired gates too, otherwise the report shows gates that should
    // already be gone (reconcile+migrate alone don't expire).
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
    // Stale file-not-found corrections: the quoted path EXISTS again — the
    // taught error cannot recur; retire the gate softly (damped re-promotion
    // stays possible if the pattern earns a fresh bar).
    for (const store of stores.projectStore ? [stores.projectStore, stores.globalStore] : [stores.globalStore]) {
      await store.runLocked(async () => {
        const scopeGates = await store.loadForMutation()
        let staleFixed = false
        for (const gate of scopeGates) {
          if (gate.status === "watching") continue
          const stalePath = staleCorrectionPath(gate)
          if (stalePath === null) continue
          retireTaught(gate)
          staleFixed = true
          store.deferEvent({ type: "repaired", key: gate.key, tool: gate.tool, snippet: `stale correction retired (quoted missing-file error; ${stalePath} exists now)` })
        }
        if (staleFixed) await store.save()
      })
    }
    // retire_when met means the taught error is obsolete — retire softly, damped re-promotion stays possible
    for (const store of stores.projectStore ? [stores.projectStore, stores.globalStore] : [stores.globalStore]) {
      const root = store === stores.projectStore ? dir : null
      await store.runLocked(async () => {
        const scopeGates = await store.loadForMutation()
        let retired = false
        for (const gate of scopeGates) {
          if (gate.status === "watching" || gate.retireWhen === undefined) continue
          if (!retireWhenMet(gate, root)) continue
          retireTaught(gate)
          retired = true
          store.deferEvent({ type: "repaired", key: gate.key, tool: gate.tool, snippet: "retire_when met" })
        }
        if (retired) await store.save()
      })
    }
    // quarantine artifacts are forensic bytes — prune them only with --prune-corrupt
    for (const store of stores.projectStore ? [stores.projectStore, stores.globalStore] : [stores.globalStore]) {
      const swept = await sweepStoreArtifacts(store.dir, { tmpOrphanMs: TMP_ORPHAN_MS, corruptMaxAgeMs: pruneDays * DAY_MS, pruneCorrupt })
      if (swept.tmp + swept.locks + swept.corrupt > 0) {
        store.deferEvent({ type: "repaired", key: "sweep", snippet: `removed ${swept.tmp} tmp, ${swept.locks} lock, ${swept.corrupt} corrupt artifact(s)` })
      }
    }
    // The script exits after this — flush deferred repair/quarantine/demotion
    // events now, or they are silently lost ("every repair is logged" invariant).
    await stores.globalStore.flushDeferred()
    if (stores.projectStore) await stores.projectStore.flushDeferred()
    console.log(`repaired: ${dir === "" ? "(global only)" : dir}`)
  }
  // True-orphan pruning is safe HERE and only here: doctor sees EVERY
  // discovered scope at once, unlike a single plugin process — which must
  // never prune (the gate may live in another project's store it cannot see).
  // load() is non-force on purpose: loadForMutation() could quarantine an
  // unparseable file WITHOUT the store lock while the live plugin is running.
  const knownKeys = new Set<string>()
  for (const g of await new GateStore(globalDir).load()) knownKeys.add(g.key)
  for (const dir of projectDirs) {
    for (const g of await new GateStore(join(dir, ".opencode", "dejavu")).load()) knownKeys.add(g.key)
  }
  const idxStore = new GateStore(globalDir)
  let pruned = 0
  await idxStore.runLockedIndex(async () => {
    const idx = await idxStore.loadIndexForMutation()
    for (const key of Object.keys(idx.keys)) {
      if (!knownKeys.has(key)) {
        delete idx.keys[key]
        pruned += 1
      }
    }
    if (pruned > 0) await idxStore.saveIndex()
  })
  // Log OUTSIDE the index lock (the log lock is the most-contended lock).
  if (pruned > 0) {
    await idxStore.log({ type: "repaired", key: "index.json", snippet: `doctor pruned ${pruned} true-orphan key(s) across all visible scopes` })
    console.log(`pruned ${pruned} true-orphan index key(s)`)
  }
}

// --- report pass ---
interface Scope {
  dir: string
  isGlobal: boolean
  gates: Gate[]
  /** raw records from disk, for strict-parse checks */
  records: unknown[]
  rawState: "missing" | "unparseable" | "ok"
  corruptLogLines: number
  degradedEvents: number
  floodEvictions: number
  doubleCounts: number
  quarantineBytes: number
  quarantineFiles: number
  /** keys promoted ≥2 AND resolved (healed/retired-*) ≥2 times — oscillation */
  flappy: Array<{ key: string; promoted: number; resolved: number }>
  /** version of the process that last SAVED gates.json — durable drift signal */
  lastInitVersion: string | null
}

async function loadScope(dir: string, isGlobal: boolean): Promise<Scope> {
  let rawState: Scope["rawState"] = "missing"
  let records: unknown[] = []
  let lastInitVersion: string | null = null
  try {
    const raw = await readFile(join(dir, "gates.json"), "utf8")
    if (raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw) as { gates?: unknown; lastInitVersion?: unknown }
        rawState = "ok"
        records = Array.isArray(parsed.gates) ? parsed.gates : []
        if (typeof parsed.lastInitVersion === "string") lastInitVersion = parsed.lastInitVersion
      } catch {
        rawState = "unparseable"
      }
    }
  } catch {
    rawState = "missing"
  }
  let corruptLogLines = 0
  let degradedEvents = 0
  let floodEvictions = 0
  // Cross-channel double-count monitor: the same failure recorded by two
  // channels (exit/text AND event) within a short window inflates counts and
  // demotion math. Latent today (channels are disjoint by construction); if
  // upstream ever emits both, this surfaces it.
  const recentDetections = new Map<string, { ts: number; channel: string }>()
  let doubleCounts = 0
  // FLAPPY monitor: promote→heal/retire oscillation. `count`/`sessions` are
  // lifetime-cumulative (not in the lifecycle-reset list), so a healed or
  // retired gate would re-promote on the very next single failure — in flaky
  // environments that is promote→heal→promote forever. `retireBaseline` now
  // damps it (re-promotion needs a full fresh bar of failures); this log-based
  // count still surfaces gates that oscillated before damping, or that flap
  // despite it. Report-only — review, delete, or rewrite the correction.
  const transitions = new Map<string, { promoted: number; resolved: number }>()
  try {
    const raw = await readFile(join(dir, "log.jsonl"), "utf8")
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      if (line.includes('"type":"degraded"')) degradedEvents++
      if (line.includes("flood guard evicted")) floodEvictions++
      if (
        line.includes('"type":"promoted"') ||
        line.includes('"type":"healed"') ||
        line.includes('"type":"retired-healed"') ||
        line.includes('"type":"retired-taught"')
      ) {
        try {
          const e = JSON.parse(line) as { type?: string; key?: string }
          if (e.key !== undefined && typeof e.type === "string") {
            const t = transitions.get(e.key) ?? { promoted: 0, resolved: 0 }
            if (e.type === "promoted") t.promoted += 1
            else t.resolved += 1
            transitions.set(e.key, t)
          }
        } catch {
          // counted as corrupt below if unparseable
        }
      }
      if (line.includes('"type":"detected"') && line.includes('"channel"')) {
        try {
          const e = JSON.parse(line) as { ts?: string; key?: string; session?: string; channel?: string }
          if (e.key !== undefined && e.channel !== undefined && e.ts !== undefined) {
            const ts = Date.parse(e.ts)
            const k = `${e.key}|${e.session ?? ""}`
            const prev = recentDetections.get(k)
            if (prev !== undefined && prev.channel !== e.channel && Math.abs(ts - prev.ts) <= 2000) {
              doubleCounts++
            } else {
              recentDetections.set(k, { ts, channel: e.channel })
            }
          }
        } catch {
          // counted as corrupt below if unparseable
        }
      }
      try {
        JSON.parse(line)
      } catch {
        corruptLogLines++
      }
    }
  } catch {
    // no log yet
  }
  // Quarantine artifacts: append-only, never rotated — surface their size so
  // repeated corruption (the pathology this system exists for) is visible.
  let quarantineBytes = 0
  let quarantineFiles = 0
  try {
    for (const name of await readdir(dir)) {
      if (!name.includes(".corrupt")) continue
      try {
        quarantineBytes += (await stat(join(dir, name))).size
        quarantineFiles++
      } catch {
        // vanished between readdir and stat
      }
    }
  } catch {
    // dir unreadable
  }
  const flappy = [...transitions.entries()]
    .filter(([, t]) => t.promoted >= 2 && t.resolved >= 2)
    .map(([key, t]) => ({ key, promoted: t.promoted, resolved: t.resolved }))
  const store = new GateStore(dir)
  return {
    dir,
    isGlobal,
    gates: await store.load(),
    records,
    rawState,
    corruptLogLines,
    degradedEvents,
    floodEvictions,
    doubleCounts,
    quarantineBytes,
    quarantineFiles,
    flappy,
    lastInitVersion,
  }
}

const scopes: Scope[] = [await loadScope(globalDir, true)]
for (const p of projectDirs) scopes.push(await loadScope(join(p, ".opencode", "dejavu"), false))
const scopeProject = new Map<string, string | null>([[globalDir, null]])
for (const p of projectDirs) scopeProject.set(join(p, ".opencode", "dejavu"), p)

const allKeys = new Set(scopes.flatMap((s) => s.gates.map((g) => g.key)))
const keySignature = new Map(scopes.flatMap((s) => s.gates.map((g) => [g.key, g.signature] as const)))
const globalScope = scopes[0] as Scope
const globalKeys = new Set(globalScope.gates.map((g) => g.key))
const index = await new GateStore(globalDir).loadIndex()

let issues = 0
for (const scope of scopes) {
  console.log(`\n== ${scope.dir}`)

  if (scope.rawState === "unparseable") {
    issues++
    console.log("   UNPARSEABLE gates.json — run doctor --repair (file is quarantined, bytes kept)")
  }
  const badRecords = scope.records.filter((r) => coerceGateShape(r) === null).length
  if (badRecords > 0) {
    issues++
    console.log(`   BAD GATE RECORDS (${badRecords}) — fail strict parse; doctor --repair drops them`)
  }

  const gates = scope.gates
  if (gates.length === 0 && scope.rawState !== "unparseable" && badRecords === 0) console.log("   (empty)")
  if (gates.length > 0) {
    console.log(`   gates: ${gates.length}/${MAX_GATES}${gates.length >= MAX_GATES * 0.8 ? ` — NEAR CAPACITY (flood guard will start evicting watching gates)` : ""}`)
    if (gates.length >= MAX_GATES * 0.8) issues++
  }
  if (scope.floodEvictions > 0) {
    console.log(`   note: FLOOD EVICTIONS (${scope.floodEvictions}) — watching gates evicted to stay at the cap (evidence lost)`)
  }
  if (scope.quarantineFiles > 0) {
    console.log(`   note: QUARANTINE ARTIFACTS (${scope.quarantineFiles} file(s), ${(scope.quarantineBytes / 1024).toFixed(1)} KB) — inspect, then safe to delete`)
  }
  if (scope.doubleCounts > 0) {
    issues++
    console.log(`   CROSS-CHANNEL DOUBLE-COUNT (${scope.doubleCounts}) — the same failure recorded by two channels within 2s; upstream changed, dedup needed`)
  }

  if (scope.flappy.length > 0) {
    console.log(`   note: FLAPPY (${scope.flappy.length}) — promoted 2+ AND resolved 2+ times; promote→heal oscillation (retireBaseline damps re-promotion; these flapped before or despite it):`)
    for (const f of scope.flappy.slice(0, 10)) console.log(`     - promoted ${f.promoted} | resolved ${f.resolved} | ${keySignature.get(f.key) ?? f.key}`)
  }

  // FLAPPY escalation: the log-based FLAPPY above rots with rotation, but
  // promotionCount is lifetime (never reset) — 3+ promotions means the gate
  // retired and re-promoted at least twice. That is proven oscillation:
  // report-only (no mechanical auto-demotion) — review, delete, or correct it.
  const flappyLifetime = gates.filter((g) => (g.promotionCount ?? 0) >= 3)
  if (flappyLifetime.length > 0) {
    issues += flappyLifetime.length
    console.log(`   FLAPPY promotionCount>=3 (${flappyLifetime.length}) — promoted 3+ times over the gate's lifetime (promote→retire→promote oscillation); review, delete, or rewrite the correction:`)
    for (const g of flappyLifetime.slice(0, 10)) console.log(`     - promoted ${g.promotionCount}x | ${g.signature}`)
  }

  const seen = new Set<string>()
  let dupes = 0
  for (const g of gates) {
    if (seen.has(g.key)) dupes++
    seen.add(g.key)
  }
  if (dupes > 0) {
    issues++
    console.log(`   DUPLICATE KEYS (${dupes}) — doctor --repair merges them`)
  }

  const inverted = gates.filter((g) => g.firstSeen > g.lastSeen)
  if (inverted.length > 0) {
    issues++
    console.log(`   TEMPORAL INVERSION firstSeen>lastSeen (${inverted.length}) — doctor --repair swaps them`)
  }

  const nested = gates.filter((g) => hasNestedTokens(g.signature))
  if (nested.length > 0) {
    issues += nested.length
    console.log(`   NESTED TOKEN corruption (${nested.length}) — a placeholder re-parameterized another token; delete these gates:`)
    for (const g of nested.slice(0, 10)) console.log(`     - ${g.signature}`)
  }

  const blockingNoEvidence = gates.filter((g) => g.status !== "watching" && g.sessions.length < PROMOTE_SESSIONS)
  if (blockingNoEvidence.length > 0) {
    issues += blockingNoEvidence.length
    console.log(`   ENFORCED WITHOUT EVIDENCE sessions<${PROMOTE_SESSIONS} (${blockingNoEvidence.length}) — promoted outside policy (hand-edited?):`)
    for (const g of blockingNoEvidence.slice(0, 10)) console.log(`     - ${g.signature}`)
  }

  const staleBlocking = gates.filter((g) => g.status === "blocking" && !canBlock(g.tool, g.signature))
  if (staleBlocking.length > 0) {
    issues += staleBlocking.length
    console.log(`   STALE BLOCKING outside policy (${staleBlocking.length}) — doctor --repair demotes:`)
    for (const g of staleBlocking.slice(0, 10)) console.log(`     - ${g.signature}`)
  }

  const staleReminding = gates.filter((g) => g.status === "reminding" && !canRemind(g.tool, g.signature))
  if (staleReminding.length > 0) {
    issues += staleReminding.length
    console.log(`   STALE REMINDING outside policy (${staleReminding.length}) — doctor --repair demotes to watching:`)
    for (const g of staleReminding.slice(0, 10)) console.log(`     - ${g.signature}`)
  }

  // Gates that could never teach — enforced gates whose error recurs despite
  // enforcement. Relative to feedbackBaseline: a human re-enforcement gets a
  // fresh grace window, stale pre-demotion recurrences must not re-flag it.
  // Flag only blocking gates: a recurring reminding/diagnostic gate is normal iteration (tests fail while the agent works); a recurring BLOCKING gate means the correction isn't working. Watching gates already surrendered to feedback demotion.
  const notTeaching = gates.filter(
    (g) =>
      g.status === "blocking" &&
      g.recurredAfterGate - (g.feedbackBaseline?.recurred ?? 0) >= DEMOTE_RECURRENCES &&
      canBlock(g.tool, g.signature),
  )
  if (notTeaching.length > 0) {
    issues += notTeaching.length
    console.log(`   NOT TEACHING recurredAfterGate>=${DEMOTE_RECURRENCES} (${notTeaching.length}) — gate fires but error recurs; write a correction or delete:`)
    for (const g of notTeaching.slice(0, 10)) console.log(`     - recurred ${g.recurredAfterGate - (g.feedbackBaseline?.recurred ?? 0)} | ${g.signature}`)
  }

  const feedbackDemoted = gates.filter((g) => g.feedbackDemoted === true)
  if (feedbackDemoted.length > 0) {
    console.log(`   note: FEEDBACK-DEMOTED (${feedbackDemoted.length}) — agent behavior (recurrences/overrides) retired these; re-enforce by setting status back to blocking/reminding AND clearing feedbackDemoted in gates.json`)
  }

  // False-positive votes: every override is the agent explicitly saying "this
  // gate is wrong / friction, let me through" (dejavu:proceed). A gate that is
  // STILL enforced while accumulating overrides is a live false positive — the
  // strongest signal that dejavu is nagging on something that isn't a mistake.
  const overridden = gates.filter((g) => (g.overrideCount ?? 0) > 0)
  if (overridden.length > 0) {
    const live = overridden.filter((g) => g.status !== "watching")
    if (live.length > 0) issues += live.length
    console.log(`   OVERRIDDEN (${overridden.length}, of which ${live.length} still enforced) — agent voted these false-positive via dejavu:proceed; still-enforced ones are live friction:`)
    for (const g of [...overridden].sort((a, b) => (b.overrideCount ?? 0) - (a.overrideCount ?? 0)).slice(0, 10))
      console.log(`     - override x${g.overrideCount} [${g.status}] ${g.signature}`)
  }

  // Positive signal: correction exists and the pattern never recurred after promotion
  const teaching = gates.filter((g) => g.correction !== undefined && g.recurredAfterGate === 0 && g.count >= 3)
  if (teaching.length > 0) {
    console.log(`   note: TEACHING (${teaching.length}) — corrected gates with zero recurrences after promotion`)
  }

  const proven = gates.filter((g) => (g.correctionsProven ?? 0) > 0)
  if (proven.length > 0) {
    console.log(`   note: PROVEN LESSONS (${proven.length}) — authored corrections followed by success:`)
    for (const g of [...proven].sort((a, b) => (b.correctionsProven ?? 0) - (a.correctionsProven ?? 0)).slice(0, 10))
      console.log(`     - ${g.key} proven ${g.correctionsProven} | ${g.signature}`)
  }

  const annoying = gates.filter((g) => g.remindedCount >= 10 && (canBlock(g.tool, g.signature) || canRemind(g.tool, g.signature)))
  if (annoying.length > 0) {
    issues += annoying.length
    console.log(`   ANNOYING reminded>=10 (${annoying.length}):`)
    for (const g of annoying.slice(0, 10)) console.log(`     - reminded ${g.remindedCount} | ${g.signature}`)
  }

  const staleCorrections = gates.filter((g) => g.status !== "watching" && staleCorrectionPath(g) !== null)
  if (staleCorrections.length > 0) {
    issues += staleCorrections.length
    console.log(`   STALE-CORRECTION (${staleCorrections.length}) — correction teaches a file-not-found error but the quoted path EXISTS now; doctor --repair retires:`)
    for (const g of staleCorrections.slice(0, 10)) console.log(`     - reminded ${g.remindedCount} | ${g.signature}`)
  }

  const retireMet = gates.filter((g) => g.status !== "watching" && retireWhenMet(g, scopeProject.get(scope.dir) ?? null))
  if (retireMet.length > 0) {
    issues += retireMet.length
    console.log(`   RETIRE-WHEN MET (${retireMet.length}) — retire_when condition satisfied; doctor --repair retires:`)
    for (const g of retireMet.slice(0, 10)) console.log(`     - ${g.key} | ${g.signature}`)
  }

  const lessonVerdicts = gates.map((g) => ({ gate: g, verdict: lessonStaleness(g, Date.now()) }))
  const staleLessons = lessonVerdicts.filter((v) => v.verdict === "stale").map((v) => v.gate)
  if (staleLessons.length > 0) {
    issues += staleLessons.length
    console.log(`   STALE-LESSON (${staleLessons.length}) — authored correction not stopping recurrences since it was written; rewrite or clear it (report-only):`)
    for (const g of staleLessons.slice(0, 10)) console.log(`     - ${g.key} | ${g.signature}`)
  }
  const repromotedLessons = lessonVerdicts.filter((v) => v.verdict === "repromoted").map((v) => v.gate)
  if (repromotedLessons.length > 0) {
    issues += repromotedLessons.length
    console.log(`   REPROMOTED-LESSON (${repromotedLessons.length}) — gate re-promoted since the authored correction was written; the lesson may predate the current failure mode (report-only):`)
    for (const g of repromotedLessons.slice(0, 10)) console.log(`     - ${g.key} | ${g.signature}`)
  }

  if (repair) {
    const project = scopeProject.get(scope.dir) ?? null
    const roots = project !== null ? [project] : projectDirs
    const staleClaims = gates.flatMap((g) => correctionClaims(g, roots).map((claim) => `${g.key}: ${claim}`))
    if (staleClaims.length > 0) {
      issues += staleClaims.length
      console.log(`   STALE CLAIM (${staleClaims.length}) — authored correction quotes a missing path or a malformed URL; flag-only, fix via \`dejavu lesson set\`:`)
      for (const claim of staleClaims.slice(0, 10)) console.log(`     - ${claim}`)
    }
  }

  // review:true is set mechanically (blocked >= REVIEW_FIRES) but consumed
  // nowhere else — surface it, otherwise the flag is dead weight. Enforced
  // gates only: on healed/demoted gates the flag is history, not a defect
  // (nothing clears it, so it would flag forever).
  const reviewFlagged = gates.filter((g) => g.review === true && g.status !== "watching")
  if (reviewFlagged.length > 0) {
    issues += reviewFlagged.length
    console.log(`   REVIEW-FLAGGED (${reviewFlagged.length}) — blocked repeatedly without killing the error; inspect and rewrite the correction:`)
    for (const g of reviewFlagged.slice(0, 10)) console.log(`     - blocked ${g.blockedCount} | ${g.signature}`)
  }

  // Correction-quality signal from the in-session metric: reminders the agent
  // immediately re-offends against are not teaching — the correction is weak.
  const remindersIgnored = gates.filter((g) => g.status !== "watching" && g.recurredAfterReminder >= 3)
  if (remindersIgnored.length > 0) {
    issues += remindersIgnored.length
    console.log(`   REMINDERS IGNORED recurredAfterReminder>=3 (${remindersIgnored.length}) — agents retry right after the reminder; the correction teaches nothing:`)
    for (const g of remindersIgnored.slice(0, 10)) console.log(`     - reoffended ${g.recurredAfterReminder}/${g.remindedCount} | ${g.signature}`)
  }
  const teachingWell = gates.filter((g) => g.remindedCount >= 3 && g.recurredAfterReminder === 0)
  if (teachingWell.length > 0) {
    console.log(`   note: TEACHING-WELL (${teachingWell.length}) — reminded 3+ times, never reoffended in-session`)
  }

  const leaky = gates.filter(
    (g) =>
      sanitizeForStore(g.signature) !== g.signature ||
      sanitizeForStore(g.snippet) !== g.snippet ||
      (g.correction !== undefined && sanitizeForStore(g.correction) !== g.correction),
  )
  if (leaky.length > 0) {
    issues += leaky.length
    console.log(`   UNSANITIZED ON DISK (${leaky.length}) — secrets or terminal control chars; doctor --repair sanitizes`)
  }

  if (!scope.isGlobal) {
    const staleCopies = gates.filter((g) => globalKeys.has(g.key))
    if (staleCopies.length > 0) {
      issues += staleCopies.length
      console.log(`   STALE PROJECT COPIES (${staleCopies.length}) — key already global; doctor --repair merges into the global gate`)
    }
  }

  if (scope.corruptLogLines > 0) {
    issues++
    console.log(`   CORRUPT LOG LINES (${scope.corruptLogLines}) — doctor --repair excises them to log.jsonl.corrupt`)
  }

  if (scope.degradedEvents > 0) {
    // Observability, not a defect: the degrade-to-unlocked design trades rare
    // lost updates for never hanging the tool pipeline. Watch the trend — a
    // growing count is the signal to revisit the storage backend.
    console.log(`   note: LOCK DEGRADATIONS (${scope.degradedEvents}) — contention exceeded the wait window; updates may have been lost there`)
  }

  // Version drift: gates.json's lastInitVersion (the version of the process
  // that last SAVED) is the durable signal — log init events rotate away on a
  // busy log. Fall back to the last init event for stores not yet saved by a
  // versioned writer.
  if (scope.lastInitVersion !== null) {
    if (scope.lastInitVersion !== PLUGIN_VERSION) {
      issues++
      console.log(`   VERSION DRIFT: last writer = ${scope.lastInitVersion}, current = ${PLUGIN_VERSION} — stale plugin sessions were writing here; restart OpenCode`)
    } else {
      console.log(`   version ok (${scope.lastInitVersion})`)
    }
  } else {
    try {
      const raw = await readFile(join(scope.dir, "log.jsonl"), "utf8")
      const inits = raw.split("\n").filter((l) => l.includes('"type":"init"'))
      const last = inits[inits.length - 1]
      let version = "none"
      if (last) {
        try {
          version = (JSON.parse(last) as { version?: string }).version ?? "unknown"
        } catch {
          // a corrupt init line must not crash the diagnostic tool itself
          version = "unknown"
        }
      }
      if (version === "none") {
        // Indeterminate, not drift: on a busy log the init event rotates away
        // while a long-lived session keeps running — no init in the kept window
        // says nothing about which version is writing.
        console.log("   version indeterminate (no init event in the kept log window)")
      } else if (version !== PLUGIN_VERSION) {
        issues++
        console.log(`   VERSION DRIFT: last init in log = ${version}, current = ${PLUGIN_VERSION} — stale plugin sessions were writing here; restart OpenCode`)
      } else {
        console.log(`   version ok (${version})`)
      }
    } catch {
      console.log("   (no log yet)")
    }
  }
}

// --- discoverability (informational): the project's instruction surface should mention the store contract ---
const DISCOVERABILITY_TOKENS = [".opencode/dejavu/gates.json", "dejavu:proceed", "dejavu lesson"]
const discoverability: string[] = []
for (const project of projectDirs) {
  const surface = ["AGENTS.md", "README.md"].map((name) => join(project, name)).find((p) => existsSync(p))
  if (surface === undefined) continue
  let text: string
  try {
    text = await readFile(surface, "utf8")
  } catch {
    continue
  }
  for (const token of DISCOVERABILITY_TOKENS) {
    if (!text.includes(token)) discoverability.push(`${surface} does not mention ${token}`)
  }
}
if (discoverability.length > 0) {
  console.log(`\n== instruction-surface discoverability (informational)`)
  for (const line of discoverability) console.log(`   DISCOVERABILITY (${line})`)
}

// --- cross-store invariants (need the full scope list) ---
console.log(`\n== ${globalDir} (cross-store)`)
let crossIssues = 0
const indexEntries = Object.entries(index.keys)

const orphans = indexEntries.filter(([key]) => !allKeys.has(key))
if (orphans.length > 0) {
  crossIssues++
  console.log(`   INDEX ORPHANS (${orphans.length}) — keys with no gate in any scope; doctor --repair prunes`)
}

const missing = globalScope.gates.filter((g) => index.keys[g.key] === undefined)
if (missing.length > 0) {
  crossIssues++
  console.log(`   INDEX MISSING (${missing.length}) — global gates without cross-project tracking; doctor --repair rebuilds`)
}

// GLOBAL_PROJECTS (store.ts tunable): 2+ LIVE project dirs = agent-level habit.
// Repo-local verbs (npm/git/gradle/...) are excluded by policy — their failures
// are repo quirks and must stay project-scoped, so they are not "missed".
// Ghost dirs (renamed/moved repos) don't count toward the threshold.
const missed = indexEntries.filter(([key, entry]) => {
  // Orphan keys (no gate in any scope) are reported above — nothing to escalate.
  if (!allKeys.has(key)) return false
  if (entry.projects.filter((p) => existsSync(p)).length < GLOBAL_PROJECTS || globalKeys.has(key)) return false
  const signature = keySignature.get(key)
  return signature === undefined || !isRepoLocal(signature)
})
if (missed.length > 0) {
  crossIssues += missed.length
  console.log(`   MISSED ESCALATION (${missed.length}) — index shows 2+ projects but the gate is not global; doctor --repair escalates:`)
  for (const [key, entry] of missed.slice(0, 10)) console.log(`     - ${key} projects=${entry.projects.length}`)
}

// C10b: a retired human lesson whose fuzzy-similar sibling is enforced without one.
const orphanedLessons: Array<{ gate: Gate; sibling: Gate }> = []
const seenOrphans = new Set<string>()
for (const gate of scopes.flatMap((s) => s.gates)) {
  if (orphanedLessons.length >= 10) break
  if ((gate.correctionOrigin !== "agent" && gate.correctionOrigin !== "owner") || gate.status !== "watching" || seenOrphans.has(gate.key)) continue
  seenOrphans.add(gate.key)
  const sibling = scopes
    .flatMap((s) => s.gates)
    .find((s) => s.key !== gate.key && s.status !== "watching" && s.correctionOrigin !== "agent" && s.correctionOrigin !== "owner" && fuzzySimilar(s.signature, gate.signature))
  if (sibling !== undefined) orphanedLessons.push({ gate, sibling })
}
if (orphanedLessons.length > 0) {
  crossIssues += orphanedLessons.length
  console.log(`   ORPHANED LESSON (${orphanedLessons.length}) — authored-corrected gate retired while a fuzzy-similar enforced gate has no authored correction; copy the correction over (dejavu lesson set <sibling> "<correction>"):`)
  for (const { gate, sibling } of orphanedLessons) console.log(`     - (${gate.key}, ${sibling.key}) ${sibling.signature}`)
}
if (crossIssues === 0) console.log("   ok")
issues += crossIssues

console.log(`\n${issues === 0 ? "OK: no pathologies" : `ISSUES: ${issues}`}`)
