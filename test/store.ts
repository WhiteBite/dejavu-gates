/**
 * Store-layer characterization: reconcile no-op rewrite skip, log excise
 * prefilter, expireAll peek gating, index structural-vs-deferred writes, and
 * the shared atomicWrite (long-path). Run: bun test/store.ts (BENCH=1 adds
 * the CLI-init benchmark over a 300-gate + 2x3000-line store).
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { atomicWrite, CORRUPT_DEFAULT_DAYS, ntPath, sweepStoreArtifacts, TMP_ORPHAN_MS } from "../src/fs"
import { callSignature, fuzzySimilar, patternKey, suggestCorrection } from "../src/patterns"
import { createStores, GateStore, GLOBAL_PROJECTS, lessonStaleness, mergeGate, NOISE_TTL_DAYS, PLUGIN_VERSION, STALE_LESSON_DAYS, Stores, TTL_DAYS, type Gate } from "../src/store"
import { coerceGateShape, isAutoCorrection, repairGate } from "../src/validate"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

const tmp = await mkdtemp(join(tmpdir(), "dejavu-store-test-"))
process.env.DEJAVU_HOME = join(tmp, "dejavu-home")
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

type GateRow = Record<string, unknown>

async function readGates(dir: string): Promise<GateRow[]> {
  return (JSON.parse(await readFile(join(dir, "gates.json"), "utf8")) as { gates: GateRow[] }).gates
}

function seedGate(overrides: Partial<GateRow>): GateRow {
  return {
    key: "aaaa00000001",
    signature: "bash:seed cmd",
    tool: "bash",
    status: "watching",
    count: 2,
    sessions: ["s1", "s2"],
    projects: [tmp],
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-09-20T00:00:00.000Z",
    snippet: "Error: boom",
    remindedCount: 0,
    blockedCount: 0,
    recurredAfterReminder: 0,
    recurredAfterGate: 0,
    overrideCount: 0,
    ...overrides,
  }
}

// --- 1. reconcile no-op: a clean gates.json is not rewritten ---
const noopDir = join(tmp, "reconcile-noop")
await mkdir(noopDir, { recursive: true })
const noopPath = join(noopDir, "gates.json")
await writeFile(noopPath, `${JSON.stringify({ version: 1, gates: [seedGate({})], migrated: PLUGIN_VERSION, lastInitVersion: PLUGIN_VERSION }, null, 2)}\n`, "utf8")
const noopBefore = await readFile(noopPath, "utf8")
const noopMtime = (await stat(noopPath)).mtimeMs
const noopStore = new GateStore(noopDir)
await noopStore.reconcile()
check("reconcile no-op leaves gates.json bytes unchanged", (await readFile(noopPath, "utf8")) === noopBefore)
check("reconcile no-op leaves gates.json mtime unchanged (no rewrite)", (await stat(noopPath)).mtimeMs === noopMtime)
check("reconcile no-op still serves the gate from the refreshed cache", (await noopStore.load()).some((g) => g.key === "aaaa00000001") && noopStore.byKey("aaaa00000001") !== undefined)
await noopStore.reconcile()
check("reconcile no-op is idempotent (second pass also rewrite-free)", (await readFile(noopPath, "utf8")) === noopBefore && (await stat(noopPath)).mtimeMs === noopMtime)

// --- 2. reconcile still repairs + rewrites a corrupted record ---
const fixDir = join(tmp, "reconcile-fix")
await mkdir(fixDir, { recursive: true })
const fixPath = join(fixDir, "gates.json")
const fixRow = seedGate({ key: "bbbb00000001", signature: "bash:fix heal cmd", firstSeen: "2026-09-20T00:00:00.000Z", lastSeen: "2026-09-01T00:00:00.000Z" })
await writeFile(fixPath, JSON.stringify({ version: 1, gates: [fixRow] }), "utf8")
const fixStore = new GateStore(fixDir)
await fixStore.reconcile()
const fixed = (await readGates(fixDir)).find((g) => g.key === "bbbb00000001")
check("inverted dates are repaired and persisted", fixed !== undefined && (fixed.firstSeen as string) < (fixed.lastSeen as string))
check("a real repair rewrites gates.json", (await readFile(fixPath, "utf8")) !== JSON.stringify({ version: 1, gates: [fixRow] }))
await fixStore.flushDeferred()
check("repair defers a repaired event that flushDeferred persists", (await readFile(join(fixDir, "log.jsonl"), "utf8")).includes('"repaired"'))

// --- 3. excise: truncated/garbage lines out, valid lines stay ---
const exciseDir = join(tmp, "excise")
await mkdir(exciseDir, { recursive: true })
const logPath = join(exciseDir, "log.jsonl")
const valid1 = JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", type: "detected", key: "k1" })
const valid2 = JSON.stringify({ ts: "2026-09-02T00:00:00.000Z", type: "detected", key: "k2" })
const truncated = '{"ts":"2026-09-03T00:00:00.000Z","type":"detected","key":"k3'
const garbage = "interleaved debris without braces"
await writeFile(logPath, `${valid1}\n${truncated}\n${garbage}\n${valid2}\n`, "utf8")
const exciseStore = new GateStore(exciseDir)
await exciseStore.reconcile()
const excisedLog = await readFile(logPath, "utf8")
check("valid log lines survive the excise", excisedLog.includes(valid1) && excisedLog.includes(valid2))
check("truncated and garbage lines are excised", !excisedLog.includes(truncated) && !excisedLog.includes(garbage))
const corruptBytes = await readFile(join(exciseDir, "log.jsonl.corrupt"), "utf8")
check("excised lines are preserved in log.jsonl.corrupt", corruptBytes.includes(truncated) && corruptBytes.includes(garbage))
await exciseStore.flushDeferred()
check("excise defers a repaired event that flushDeferred persists", (await readFile(logPath, "utf8")).includes('"repaired"'))

// --- 4. expireAll: nothing expirable and no index rot → no writes at all ---
const expGlobal = join(tmp, "expire-global")
const expProjectStore = join(tmp, "expire-project", ".opencode", "dejavu")
await mkdir(expGlobal, { recursive: true })
await mkdir(expProjectStore, { recursive: true })
const expGatesPath = join(expProjectStore, "gates.json")
const expIdxPath = join(expGlobal, "index.json")
await writeFile(expGatesPath, JSON.stringify({ version: 1, gates: [seedGate({ key: "cccc00000001", signature: "bash:fresh cmd", lastSeen: new Date().toISOString() })] }), "utf8")
await writeFile(expIdxPath, JSON.stringify({ version: 1, keys: { cccc00000001: { projects: [tmp], lastSeen: new Date().toISOString() } } }), "utf8")
const expGatesBefore = await readFile(expGatesPath, "utf8")
const expIdxBefore = await readFile(expIdxPath, "utf8")
const expGatesMtime = (await stat(expGatesPath)).mtimeMs
const expIdxMtime = (await stat(expIdxPath)).mtimeMs
await new Stores(new GateStore(expGlobal), new GateStore(expProjectStore)).expireAll(TTL_DAYS, NOISE_TTL_DAYS)
check("nothing expirable: gates.json untouched", (await readFile(expGatesPath, "utf8")) === expGatesBefore && (await stat(expGatesPath)).mtimeMs === expGatesMtime)
check("no index rot: index.json untouched", (await readFile(expIdxPath, "utf8")) === expIdxBefore && (await stat(expIdxPath)).mtimeMs === expIdxMtime)

// --- 5. expireAll: something expirable → expired, rewritten, event deferred ---
await writeFile(expGatesPath, JSON.stringify({ version: 1, gates: [seedGate({ key: "cccc00000001", signature: "bash:fresh cmd", lastSeen: new Date().toISOString() }), seedGate({ key: "dddd00000001", signature: "bash:stale cmd", count: 3, firstSeen: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), lastSeen: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() })] }), "utf8")
const expStores = new Stores(new GateStore(expGlobal), new GateStore(expProjectStore))
await expStores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
const afterExpiry = await readGates(expProjectStore)
check("stale gate is expired (removed from gates.json)", !afterExpiry.some((g) => g.key === "dddd00000001") && afterExpiry.some((g) => g.key === "cccc00000001"))
await expStores.flushDeferredAll()
check("expiry defers an expired event that flushDeferredAll persists", (await readFile(join(expProjectStore, "log.jsonl"), "utf8")).includes('"expired"'))

// --- 6. expireAll: index rot alone still triggers the sweep ---
const rotGlobal = join(tmp, "rot-global")
const rotProjectStore = join(tmp, "rot-project", ".opencode", "dejavu")
await mkdir(rotGlobal, { recursive: true })
await mkdir(rotProjectStore, { recursive: true })
await writeFile(join(rotProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: [seedGate({ key: "eeee00000001", signature: "bash:rot cmd", lastSeen: new Date().toISOString() })] }), "utf8")
const rotIdxPath = join(rotGlobal, "index.json")
await writeFile(rotIdxPath, JSON.stringify({ version: 1, keys: { deadkey: { projects: [tmp], lastSeen: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() } } }), "utf8")
await new Stores(new GateStore(rotGlobal), new GateStore(rotProjectStore)).expireAll(TTL_DAYS, NOISE_TTL_DAYS)
const rotIdx = JSON.parse(await readFile(rotIdxPath, "utf8")) as { keys: Record<string, unknown> }
check("index entry past the TTL is pruned even with nothing expirable", rotIdx.keys["deadkey"] === undefined)

// --- 7. index writes: structural immediate, lastSeen-only deferred ---
const idxGlobal = join(tmp, "index-global")
const idxProject = join(tmp, "index-project")
const idxProjectStore = join(idxProject, ".opencode", "dejavu")
await mkdir(idxGlobal, { recursive: true })
await mkdir(idxProjectStore, { recursive: true })
const idxSig = callSignature("bash", { command: "index probe cmd" }) ?? ""
const idxKey = patternKey(idxSig)
const idxStores = new Stores(new GateStore(idxGlobal), new GateStore(idxProjectStore))
const fail = (sessionID: string): Promise<unknown> =>
  idxStores.recordFailure({ key: idxKey, signature: idxSig, tool: "bash", sessionID, projectDir: idxProject, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
await fail("i1")
const idxPath = join(idxGlobal, "index.json")
const idxAfterFirst = JSON.parse(await readFile(idxPath, "utf8")) as { keys: Record<string, { projects: string[]; lastSeen: string }> }
check("first failure in a project writes index.json immediately", idxAfterFirst.keys[idxKey] !== undefined && (idxAfterFirst.keys[idxKey]?.projects.includes(idxProject) ?? false))
await new Promise((resolve) => setTimeout(resolve, 20))
const idxBytesBefore = await readFile(idxPath, "utf8")
const idxMtimeBefore = (await stat(idxPath)).mtimeMs
await fail("i1")
check("same-key same-project failure does not rewrite index.json", (await readFile(idxPath, "utf8")) === idxBytesBefore && (await stat(idxPath)).mtimeMs === idxMtimeBefore)
const idxGateLastSeen = ((await readGates(idxProjectStore)).find((g) => g.key === idxKey)?.lastSeen ?? "") as string
await idxStores.flushDeferredAll()
const idxAfterFlush = JSON.parse(await readFile(idxPath, "utf8")) as { keys: Record<string, { projects: string[]; lastSeen: string }> }
check("flushDeferredAll persists the deferred lastSeen bump", idxAfterFlush.keys[idxKey]?.lastSeen === idxGateLastSeen && idxGateLastSeen > (idxAfterFirst.keys[idxKey]?.lastSeen ?? ""))

// --- 8. escalation across 2 project dirs still promotes to global ---
const escGlobal = join(tmp, "esc-global")
const escProjA = join(tmp, "esc-a")
const escProjB = join(tmp, "esc-b")
const escStoreA = join(escProjA, ".opencode", "dejavu")
const escStoreB = join(escProjB, ".opencode", "dejavu")
await mkdir(escGlobal, { recursive: true })
await mkdir(escStoreA, { recursive: true })
await mkdir(escStoreB, { recursive: true })
const escSig = callSignature("bash", { command: "escalate-probe --cross-project" }) ?? ""
const escKey = patternKey(escSig)
await new Stores(new GateStore(escGlobal), new GateStore(escStoreA)).recordFailure({ key: escKey, signature: escSig, tool: "bash", sessionID: "e1", projectDir: escProjA, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
const escResult = await new Stores(new GateStore(escGlobal), new GateStore(escStoreB)).recordFailure({ key: escKey, signature: escSig, tool: "bash", sessionID: "e2", projectDir: escProjB, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
check("second project failure escalates the gate to global", escResult.wentGlobal === true)
check("escalated gate lives in the global store", (await readGates(escGlobal)).some((g) => g.key === escKey))
check("escalating project's copy is removed", !(await readGates(escStoreB)).some((g) => g.key === escKey))

// --- 9. shared atomicWrite: long-path (ntPath) write survives MAX_PATH ---
let deep = join(tmp, "longpath")
while (deep.length < 250) deep = join(deep, "very-deep-directory-name-that-keeps-growing")
await mkdir(ntPath(deep), { recursive: true })
const deepFile = join(deep, "payload.json")
await atomicWrite(deepFile, '{"ok":true}\n')
check("atomicWrite writes through a >260-char path (ntPath)", deepFile.length > 260 && (await readFile(ntPath(deepFile), "utf8")) === '{"ok":true}\n')

// --- 10. installer writes through the shared atomicWrite (rewiring regression) ---
const instCwd = join(tmp, "install-cwd")
const instHome = join(tmp, "install-home")
await mkdir(instCwd, { recursive: true })
await mkdir(instHome, { recursive: true })
const inst = spawnSync("bun", [join(repoRoot, "src", "main.ts"), "install", "--harness", "claude", "--project", "--yes"], {
  cwd: instCwd,
  env: { ...process.env, USERPROFILE: instHome, HOME: instHome },
  encoding: "utf8",
})
const settingsPath = join(instCwd, ".claude", "settings.json")
check("installer exits 0 through the shared atomicWrite", inst.status === 0)
check("installer wrote .claude/settings.json via the shared primitive", existsSync(settingsPath) && (await readFile(settingsPath, "utf8")).includes("src/cli.ts"))

// --- 11. project store writes a self-ignoring .gitignore at init ---
const giProject = join(tmp, "gitignore-project")
const giGlobalDir = join(tmp, "dejavu-home")
const giStores = createStores(giProject)
await giStores.reconcileAll()
const giPath = join(giProject, ".opencode", "dejavu", ".gitignore")
check("reconcileAll writes the project store .gitignore", existsSync(giPath) && (await readFile(giPath, "utf8")).includes("!gates.json"))
check("the global store dir never gets a .gitignore", !existsSync(join(giGlobalDir, ".gitignore")))
const giCustom = "# user edit\n*\n!gates.json\n"
await writeFile(giPath, giCustom, "utf8")
await giStores.reconcileAll()
check("a user-modified .gitignore survives a re-run", (await readFile(giPath, "utf8")) === giCustom)

// --- 12. sweepStoreArtifacts: orphan tmp, stale locks, opt-in corrupt prune ---
const sweepDir = join(tmp, "sweep")
await mkdir(sweepDir, { recursive: true })
const DAY_MS = 24 * 60 * 60 * 1000
const backdate = async (path: string, ageMs: number): Promise<void> => {
  const at = new Date(Date.now() - ageMs)
  await utimes(path, at, at)
}
const sweepTmp = join(sweepDir, "gates.json.999999.tmp")
await writeFile(sweepTmp, "x", "utf8")
await backdate(sweepTmp, TMP_ORPHAN_MS + 60000)
const sweepLiveTmp = join(sweepDir, `gates.json.${process.pid}.tmp`)
await writeFile(sweepLiveTmp, "x", "utf8")
const sweepDeadLock = join(sweepDir, "gates.json.lock")
await writeFile(sweepDeadLock, "99999999", "utf8")
const sweepLiveLock = join(sweepDir, "index.json.lock")
await writeFile(sweepLiveLock, String(process.pid), "utf8")
const sweepCorrupt = join(sweepDir, `gates.json.corrupt-${Date.now()}`)
await writeFile(sweepCorrupt, "x", "utf8")
const sweepOpts = { tmpOrphanMs: TMP_ORPHAN_MS, corruptMaxAgeMs: CORRUPT_DEFAULT_DAYS * DAY_MS, pruneCorrupt: false }
const kept = await sweepStoreArtifacts(sweepDir, sweepOpts)
check("sweep removes an orphaned tmp artifact past the age window", kept.tmp === 1 && !existsSync(sweepTmp))
check("sweep keeps a fresh tmp artifact from a live pid", existsSync(sweepLiveTmp))
check("sweep removes a lock held by a dead pid", kept.locks === 1 && !existsSync(sweepDeadLock))
check("sweep never removes a lock held by a live pid", existsSync(sweepLiveLock))
check("pruneCorrupt=false keeps quarantine artifacts", kept.corrupt === 0 && existsSync(sweepCorrupt))
await backdate(sweepCorrupt, (CORRUPT_DEFAULT_DAYS + 1) * DAY_MS)
const pruned = await sweepStoreArtifacts(sweepDir, { ...sweepOpts, pruneCorrupt: true })
check("pruneCorrupt=true removes quarantine artifacts past the age window", pruned.corrupt === 1 && !existsSync(sweepCorrupt))

// --- 13. audit follow-ups: glued log lines, index quarantine, force-read, version stamp ---
const glueDir = join(tmp, "excise-glue")
await mkdir(glueDir, { recursive: true })
const glueLogPath = join(glueDir, "log.jsonl")
const glueA = JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", type: "detected", key: "g1" })
const glueB = JSON.stringify({ ts: "2026-09-02T00:00:00.000Z", type: "detected", key: "g2" })
await writeFile(glueLogPath, `${glueA}\n${glueA}${glueB}\n${glueB}\n`, "utf8")
const glueStore = new GateStore(glueDir)
await glueStore.reconcile()
const glueLogAfter = await readFile(glueLogPath, "utf8")
check("a glued {a}{b} log line is excised, not passed as good", !glueLogAfter.includes(`${glueA}${glueB}`) && glueLogAfter.includes(glueA) && glueLogAfter.includes(glueB))

const qDir = join(tmp, "index-quarantine")
await mkdir(qDir, { recursive: true })
const qStore = new GateStore(qDir)
await writeFile(join(qDir, "index.json"), "{not json", "utf8")
await qStore.runLockedIndex(async () => {
  await qStore.loadIndexForMutation()
})
const qQuarantine = await readdir(qDir)
check("an unparseable index.json quarantines to a corrupt- twin", (await qQuarantine).some((f) => f.startsWith("index.json.corrupt-")))
await qStore.flushDeferred()
const qLog = await readFile(join(qDir, "log.jsonl"), "utf8")
check("index quarantine defers a quarantined event", qLog.includes('"quarantined"') && qLog.includes("index.json"))

const frDir = join(tmp, "index-force-read")
await mkdir(join(frDir, "index.json"), { recursive: true })
const frStore = new GateStore(frDir)
let frThrew = false
try {
  await frStore.runLockedIndex(async () => {
    await frStore.loadIndexForMutation()
  })
} catch {
  frThrew = true
}
check("a transiently unreadable index throws on the mutation path (no cache clobber)", frThrew)

const stampDir = join(tmp, "version-stamp")
await mkdir(stampDir, { recursive: true })
const stampPath = join(stampDir, "gates.json")
await writeFile(stampPath, `${JSON.stringify({ version: 1, gates: [seedGate({ key: "ffff00000001" })], migrated: PLUGIN_VERSION, lastInitVersion: "2.28.0" }, null, 2)}\n`, "utf8")
const stampStore = new GateStore(stampDir)
await stampStore.reconcile()
const stamped = JSON.parse(await readFile(stampPath, "utf8")) as { lastInitVersion?: string }
check("a quiet store stamps lastInitVersion once on version change", stamped.lastInitVersion === PLUGIN_VERSION)
const stampMtime = (await stat(stampPath)).mtimeMs
await stampStore.reconcile()
check("the stamp write happens once per version, not per init", (await stat(stampPath)).mtimeMs === stampMtime)

// --- 14. correction lifecycle: mergeGate origin awareness, parse boundary, platform-neutral labels ---
function makeGate(overrides: Partial<Gate>): Gate {
  return {
    key: "aaaa00000001",
    signature: "bash:merge cmd",
    tool: "bash",
    status: "watching",
    count: 2,
    sessions: ["s1"],
    projects: [tmp],
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-09-20T00:00:00.000Z",
    snippet: "Error: boom",
    remindedCount: 0,
    blockedCount: 0,
    recurredAfterReminder: 0,
    recurredAfterGate: 0,
    overrideCount: 0,
    ...overrides,
  }
}

const ownerKept = makeGate({ correction: "owner fix", correctionOrigin: "owner", correctionAt: 200, correctionBaseline: { recurred: 4, reminded: 5, overrides: 6 } })
mergeGate(ownerKept, makeGate({ correction: "machine default", correctionOrigin: "machine", correctionAt: 100 }))
check("merge: a machine source never overwrites an owner target", ownerKept.correction === "owner fix" && ownerKept.correctionOrigin === "owner" && ownerKept.correctionAt === 200 && ownerKept.correctionBaseline?.recurred === 4)

const ownerWins = makeGate({ correction: "machine default", correctionOrigin: "machine", correctionAt: 100, correctionBaseline: { recurred: 1, reminded: 2, overrides: 3 } })
mergeGate(ownerWins, makeGate({ correction: "owner fix", correctionOrigin: "owner", correctionAt: 200, correctionBaseline: { recurred: 4, reminded: 5, overrides: 6 } }))
check("merge: an owner source correction beats a machine target", ownerWins.correction === "owner fix" && ownerWins.correctionOrigin === "owner")
check("merge: the owner source's correctionAt and baseline win with it", ownerWins.correctionAt === 200 && ownerWins.correctionBaseline?.recurred === 4 && ownerWins.correctionBaseline?.reminded === 5 && ownerWins.correctionBaseline?.overrides === 6)

const ownerOverAgent = makeGate({ correction: "agent fix", correctionOrigin: "agent", correctionAt: 900 })
mergeGate(ownerOverAgent, makeGate({ correction: "owner fix", correctionOrigin: "owner", correctionAt: 100 }))
check("merge: an owner source beats an agent target", ownerOverAgent.correction === "owner fix" && ownerOverAgent.correctionOrigin === "owner")

const agentOverMachine = makeGate({ correction: "machine default", correctionOrigin: "machine", correctionAt: 900 })
mergeGate(agentOverMachine, makeGate({ correction: "agent fix", correctionOrigin: "agent", correctionAt: 100 }))
check("merge: an agent source beats a machine target", agentOverMachine.correction === "agent fix" && agentOverMachine.correctionOrigin === "agent")

const machineKept = makeGate({ correction: "target machine", correctionOrigin: "machine", correctionAt: 400 })
mergeGate(machineKept, makeGate({ correction: "source machine", correctionOrigin: "machine" }))
check("merge: equal machine origins keep the target correction", machineKept.correction === "target machine" && machineKept.correctionAt === 400)

const machineNewer = makeGate({ correction: "target machine", correctionOrigin: "machine", correctionAt: 400 })
mergeGate(machineNewer, makeGate({ correction: "source machine", correctionOrigin: "machine", correctionAt: 500 }))
check("merge: equal machine origins with a newer source correctionAt adopt it", machineNewer.correction === "source machine" && machineNewer.correctionAt === 500)

const bareAdopt = makeGate({})
mergeGate(bareAdopt, makeGate({ correction: "adopted", correctionOrigin: "machine", correctionAt: 700 }))
check("merge: a target with no correction adopts the source's", bareAdopt.correction === "adopted" && bareAdopt.correctionOrigin === "machine" && bareAdopt.correctionAt === 700)

const legacyAdopt = makeGate({ correction: "legacy text" })
mergeGate(legacyAdopt, makeGate({ correction: "agent fix", correctionOrigin: "agent", correctionAt: 800 }))
check("merge: an absent-origin target adopts a higher-rank source", legacyAdopt.correction === "agent fix" && legacyAdopt.correctionOrigin === "agent" && legacyAdopt.correctionAt === 800)

const agentNewer = makeGate({ correction: "older agent fix", correctionOrigin: "agent", correctionAt: 200, correctionBaseline: { recurred: 4, reminded: 5, overrides: 6 } })
mergeGate(agentNewer, makeGate({ correction: "newer agent fix", correctionOrigin: "agent", correctionAt: 300, correctionBaseline: { recurred: 7, reminded: 8, overrides: 9 } }))
check("merge: two agent corrections pick the newer correctionAt", agentNewer.correction === "newer agent fix" && agentNewer.correctionAt === 300 && agentNewer.correctionBaseline?.recurred === 7 && agentNewer.correctionBaseline?.reminded === 8 && agentNewer.correctionBaseline?.overrides === 9)

const agentOlder = makeGate({ correction: "newer agent fix", correctionOrigin: "agent", correctionAt: 300, correctionBaseline: { recurred: 7, reminded: 8, overrides: 9 } })
mergeGate(agentOlder, makeGate({ correction: "older agent fix", correctionOrigin: "agent", correctionAt: 200, correctionBaseline: { recurred: 4, reminded: 5, overrides: 6 } }))
check("merge: an older agent source correction loses to the newer target", agentOlder.correction === "newer agent fix" && agentOlder.correctionAt === 300 && agentOlder.correctionBaseline?.recurred === 7)

const provenSum = makeGate({ correctionsProven: 2 })
mergeGate(provenSum, makeGate({ correctionsProven: 3 }))
check("merge: correctionsProven sums across records", provenSum.correctionsProven === 5)

const unixSig = "bash:tail -5 missing.log"
const unixSnippet = "exit code 1"
const linuxDerived = suggestCorrection(unixSig, unixSnippet, "linux")
check("the unix-tool shape derives differently per platform", linuxDerived !== suggestCorrection(unixSig, unixSnippet, "win32"))
check("a linux-generated correction is machine-labeled on any host", isAutoCorrection(makeGate({ signature: unixSig, snippet: unixSnippet, correction: linuxDerived })))

const unknownOrigin = coerceGateShape(seedGate({ key: "123400000001", correction: "text", correctionOrigin: "future-origin" }))
check("an unknown correctionOrigin string coerces to agent", unknownOrigin?.correctionOrigin === "agent")
const legacyOrigin = coerceGateShape(seedGate({ key: "123400000006", correction: "text", correctionOrigin: "human" }))
check("a legacy human correctionOrigin coerces to owner", legacyOrigin?.correctionOrigin === "owner")
const absentOrigin = coerceGateShape(seedGate({ key: "123400000002", correction: "text" }))
check("an absent correctionOrigin stays undefined", absentOrigin?.correctionOrigin === undefined && absentOrigin !== null)
const stampedParse = coerceGateShape(seedGate({ key: "123400000003", correction: "text", correctionAt: 123.7, correctionBaseline: { recurred: 1, reminded: 2.9, overrides: 3 } }))
check("correctionAt floors and correctionBaseline parses", stampedParse?.correctionAt === 123 && stampedParse?.correctionBaseline?.reminded === 2)
const provenParse = coerceGateShape(seedGate({ key: "123400000005", correction: "text", correctionOrigin: "human", correctionsProven: 2.7 }))
check("correctionsProven floors at the parse boundary", provenParse?.correctionsProven === 2)
const badBaseline = coerceGateShape(seedGate({ key: "123400000004", correction: "text", correctionBaseline: { recurred: 1, reminded: -2, overrides: 3 } }))
check("an invalid correctionBaseline is dropped at the parse boundary", badBaseline !== null && badBaseline.correctionBaseline === undefined)

const templateGate = makeGate({ correction: `Last error: "Error: boom" — address that specific error before retrying this exact call.` })
repairGate(templateGate)
check("repairGate stamps machine origin on a template correction", templateGate.correctionOrigin === "machine")

const OLD_GENERIC = "This exact call keeps failing — inspect the last output line and change approach before retrying."
const wcSig = "bash:wc -l <str>"
const staleGeneric = makeGate({ signature: wcSig, snippet: "exit code 1", correction: OLD_GENERIC, correctionOrigin: "machine" })
check("repairGate re-derives a stale old-generation generic correction", repairGate(staleGeneric) === true && staleGeneric.correction !== OLD_GENERIC && staleGeneric.correction === suggestCorrection(wcSig, "exit code 1"))

const hyphenGeneric = makeGate({ signature: wcSig, snippet: "exit code 1", correction: "This exact call keeps failing - inspect the last output line and change approach before retrying." })
check("repairGate re-derives a hyphen-dash generic correction and stamps machine origin", repairGate(hyphenGeneric) === true && hyphenGeneric.correction === suggestCorrection(wcSig, "exit code 1") && hyphenGeneric.correctionOrigin === "machine")

const deploySig = "bash:deploy <str>"
const genericText = suggestCorrection(deploySig, "exit code 1")
check("the deploy shape derives the generic correction on both platforms", genericText === suggestCorrection(deploySig, "exit code 1", "win32") && genericText === suggestCorrection(deploySig, "exit code 1", "linux") && genericText.startsWith("This exact call keeps failing"))
const currentGeneric = makeGate({ signature: deploySig, snippet: "exit code 1", correction: genericText, correctionOrigin: "machine" })
check("repairGate leaves the current generic correction untouched", repairGate(currentGeneric) === false && repairGate(currentGeneric) === false)

const ownerGeneric = makeGate({ signature: wcSig, snippet: "exit code 1", correction: OLD_GENERIC, correctionOrigin: "owner" })
check("repairGate never re-derives an owner's generic-shaped correction", repairGate(ownerGeneric) === false && ownerGeneric.correction === OLD_GENERIC && ownerGeneric.correctionOrigin === "owner")

// --- 15. retired-healed requires promotion: a never-enforced corrected gate expires plainly ---
const rhGlobal = join(tmp, "rh-global")
const rhProjectStore = join(tmp, "rh-project", ".opencode", "dejavu")
await mkdir(rhGlobal, { recursive: true })
await mkdir(rhProjectStore, { recursive: true })
const rhStale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
await writeFile(join(rhProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: [
  seedGate({ key: "a1b200000001", signature: "bash:never-promoted cmd", count: 3, correction: "human fix", correctionOrigin: "human", firstSeen: rhStale, lastSeen: rhStale }),
  seedGate({ key: "b2c300000001", signature: "bash:promoted cmd", count: 3, correction: "human fix", correctionOrigin: "human", promotionCount: 1, firstSeen: rhStale, lastSeen: rhStale }),
] }), "utf8")
const rhStores = new Stores(new GateStore(rhGlobal), new GateStore(rhProjectStore))
await rhStores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
await rhStores.flushDeferredAll()
const rhEvents = (await readFile(join(rhProjectStore, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type: string; key: string })
check("a never-promoted corrected gate expires as expired", rhEvents.some((e) => e.key === "a1b200000001" && e.type === "expired"))
check("a never-promoted corrected gate never claims retired-healed", !rhEvents.some((e) => e.key === "a1b200000001" && e.type === "retired-healed"))
check("a promoted corrected gate with zero recurrence still logs retired-healed", rhEvents.some((e) => e.key === "b2c300000001" && e.type === "retired-healed"))

// --- 16. recordSuccess proves authored corrections ---
const rsGlobal = join(tmp, "rs-global")
const rsProjectStore = join(tmp, "rs-project", ".opencode", "dejavu")
await mkdir(rsGlobal, { recursive: true })
await mkdir(rsProjectStore, { recursive: true })
const rsHumanSig = callSignature("bash", { command: "proven-lesson-tool --run" }) ?? ""
const rsAgentSig = callSignature("bash", { command: "agent-lesson-tool --run" }) ?? ""
const rsMachineSig = callSignature("bash", { command: "machine-lesson-tool --run" }) ?? ""
await writeFile(join(rsProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: [
  seedGate({ key: patternKey(rsHumanSig), signature: rsHumanSig, status: "blocking", count: 3, correction: "owner fix", correctionOrigin: "human" }),
  seedGate({ key: patternKey(rsAgentSig), signature: rsAgentSig, status: "blocking", count: 3, correction: "agent fix", correctionOrigin: "agent" }),
  seedGate({ key: patternKey(rsMachineSig), signature: rsMachineSig, status: "blocking", count: 3, correction: "machine default", correctionOrigin: "machine" }),
] }), "utf8")
const rsStores = new Stores(new GateStore(rsGlobal), new GateStore(rsProjectStore))
await rsStores.recordSuccess({ key: patternKey(rsHumanSig), signature: rsHumanSig, tool: "bash", sessionID: "rs1" })
await rsStores.recordSuccess({ key: patternKey(rsAgentSig), signature: rsAgentSig, tool: "bash", sessionID: "rs1" })
await rsStores.recordSuccess({ key: patternKey(rsMachineSig), signature: rsMachineSig, tool: "bash", sessionID: "rs1" })
const rsRows = await readGates(rsProjectStore)
check("a success on a legacy human-corrected gate (coerced to owner) increments correctionsProven", rsRows.find((g) => g.key === patternKey(rsHumanSig))?.correctionsProven === 1)
check("a success on an agent-corrected enforced gate increments correctionsProven", rsRows.find((g) => g.key === patternKey(rsAgentSig))?.correctionsProven === 1)
check("a success on a machine-corrected gate leaves correctionsProven unset", rsRows.find((g) => g.key === patternKey(rsMachineSig))?.correctionsProven === undefined)

// --- 17. retire_when parse boundary + lesson staleness verdicts ---
const rwDep = coerceGateShape(seedGate({ key: "123400000011", retireWhen: { kind: "dep", name: "typescript", min: "5.0.0" } }))
check("retireWhen dep parses at the boundary", rwDep?.retireWhen?.kind === "dep" && rwDep.retireWhen.name === "typescript" && rwDep.retireWhen.min === "5.0.0")
const rwPath = coerceGateShape(seedGate({ key: "123400000012", retireWhen: { kind: "path", mode: "absent", path: "legacy.config" } }))
check("retireWhen path parses at the boundary", rwPath?.retireWhen?.kind === "path" && rwPath.retireWhen.mode === "absent" && rwPath.retireWhen.path === "legacy.config")
const rwTag = coerceGateShape(seedGate({ key: "123400000013", retireWhen: { kind: "tag", tag: "v2.0.0" } }))
check("retireWhen tag parses at the boundary", rwTag?.retireWhen?.kind === "tag" && rwTag.retireWhen.tag === "v2.0.0")
const rwUnknown = coerceGateShape(seedGate({ key: "123400000014", retireWhen: { kind: "env", var: "X" } }))
check("an unknown retireWhen kind drops the field, keeps the gate", rwUnknown !== null && rwUnknown.retireWhen === undefined)
const rwBadMode = coerceGateShape(seedGate({ key: "123400000015", retireWhen: { kind: "path", mode: "sometimes", path: "x" } }))
check("a malformed retireWhen mode drops the field", rwBadMode !== null && rwBadMode.retireWhen === undefined)
const rwMissingField = coerceGateShape(seedGate({ key: "123400000016", retireWhen: { kind: "dep", name: "typescript" } }))
check("a retireWhen missing required fields drops the field", rwMissingField !== null && rwMissingField.retireWhen === undefined)

const rwWinPath = makeGate({ retireWhen: { kind: "path", mode: "present", path: "src\\legacy\\old.ts" } })
repairGate(rwWinPath)
check("repairGate normalizes backslashes in a path condition", rwWinPath.retireWhen?.kind === "path" && rwWinPath.retireWhen.path === "src/legacy/old.ts")

const promotedParse = coerceGateShape(seedGate({ key: "123400000017", correction: "text", correctionBaseline: { recurred: 1, reminded: 2, overrides: 3, promoted: 2.7 } }))
check("correctionBaseline.promoted floors at the parse boundary", promotedParse?.correctionBaseline?.promoted === 2)
const promotedDropped = coerceGateShape(seedGate({ key: "123400000018", correction: "text", correctionBaseline: { recurred: 1, reminded: 2, overrides: 3, promoted: -1 } }))
check("an invalid correctionBaseline.promoted is omitted, the baseline kept", promotedDropped !== null && promotedDropped.correctionBaseline?.promoted === undefined && promotedDropped.correctionBaseline?.recurred === 1)

const now = Date.now()
check(
  "lessonStaleness: correctionsProven wins first",
  lessonStaleness(makeGate({ correctionsProven: 1, recurredAfterGate: 9, promotionCount: 5, correctionBaseline: { recurred: 0, reminded: 0, overrides: 0, promoted: 0 } }), now) === "proven",
)
check(
  "lessonStaleness: repromoted after the owner lesson",
  lessonStaleness(makeGate({ correction: "owner fix", correctionOrigin: "owner", promotionCount: 2, correctionBaseline: { recurred: 0, reminded: 0, overrides: 0, promoted: 1 } }), now) === "repromoted",
)
check(
  "lessonStaleness: stale on post-correction recurrences",
  lessonStaleness(makeGate({ correction: "owner fix", correctionOrigin: "owner", recurredAfterGate: 4, correctionBaseline: { recurred: 1, reminded: 0, overrides: 0 } }), now) === "stale",
)
check(
  "lessonStaleness: dormant past STALE_LESSON_DAYS",
  lessonStaleness(makeGate({ status: "watching", correction: "owner fix", correctionOrigin: "owner", correctionAt: now - (STALE_LESSON_DAYS + 1) * DAY_MS }), now) === "dormant",
)
check("lessonStaleness: fresh otherwise", lessonStaleness(makeGate({ correction: "owner fix", correctionOrigin: "owner", correctionAt: now }), now) === "fresh")
check(
  "lessonStaleness: machine corrections never stale or repromoted",
  lessonStaleness(makeGate({ correction: "machine default", correctionOrigin: "machine", recurredAfterGate: 9, promotionCount: 4 }), now) === "fresh",
)

// --- 18. rare-token (df) veto: a prefix-sharing pair stops merging ---
const dfvGlobal = join(tmp, "dfv-global")
const dfvProject = join(tmp, "dfv-project")
const dfvProjectStore = join(dfvProject, ".opencode", "dejavu")
await mkdir(dfvGlobal, { recursive: true })
await mkdir(dfvProjectStore, { recursive: true })
const dfvAlphaSig = callSignature("bash", { command: "deploy-service --env prod --target alpha-instance" }) ?? ""
const dfvOmegaSig = callSignature("bash", { command: "deploy-service --env prod --target omega-instance" }) ?? ""
check("the prefix-sharing pair fuzzy-merges without a df index", fuzzySimilar(dfvAlphaSig, dfvOmegaSig) === true)
const dfvProjGates = [
  seedGate({ key: patternKey(dfvAlphaSig), signature: dfvAlphaSig, status: "blocking", count: 3 }),
  ...Array.from({ length: 9 }, (_, i) => seedGate({ key: `df0a${String(i).padStart(8, "0")}`, signature: `bash:corpus-cmd-${i} --env prod` })),
]
const dfvGlobalGates = Array.from({ length: 10 }, (_, i) => seedGate({ key: `df1a${String(i).padStart(8, "0")}`, signature: `bash:global-cmd-${i} --env prod` }))
await writeFile(join(dfvProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: dfvProjGates }), "utf8")
await writeFile(join(dfvGlobal, "gates.json"), JSON.stringify({ version: 1, gates: dfvGlobalGates }), "utf8")
const dfvGlobalStore = new GateStore(dfvGlobal)
const dfvProjStore = new GateStore(dfvProjectStore)
await dfvGlobalStore.load()
await dfvProjStore.load()
check("each scope alone stays below the corpus floor", dfvProjStore.dfIndex().total === 10 && dfvGlobalStore.dfIndex().total === 10)
const dfvStores = new Stores(dfvGlobalStore, dfvProjStore)
check("the combined df index vetoes the prefix-sharing fuzzy match", (await dfvStores.findGate(patternKey(dfvOmegaSig), dfvOmegaSig)) === null)
const dfvFail = await dfvStores.recordFailure({ key: patternKey(dfvOmegaSig), signature: dfvOmegaSig, tool: "bash", sessionID: "dfv1", projectDir: dfvProject, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
check("a vetoed failure records under its own key instead of consolidating", dfvFail.gate.key === patternKey(dfvOmegaSig) && dfvFail.gate.count === 1)
check("the alpha gate's evidence is untouched by the vetoed sibling", ((await readGates(dfvProjectStore)).find((g) => g.key === patternKey(dfvAlphaSig))?.count ?? 0) === 3)

// --- 19. promotion re-derives machine corrections, preserves authored ones ---
const prGlobal = join(tmp, "pr-global")
const prProject = join(tmp, "pr-project")
const prProjectStore = join(prProject, ".opencode", "dejavu")
await mkdir(prGlobal, { recursive: true })
await mkdir(prProjectStore, { recursive: true })
const prMachineSig = wcSig
const prMachineKey = patternKey(prMachineSig)
// outside repairGate's load-time heal templates — only promotion can refresh it
const prStaleMachine = "This call has failed repeatedly — try a different approach."
const prAgentSig = "bash:agent-lesson-tool --apply"
const prAgentKey = patternKey(prAgentSig)
const prBareSig = "bash:bare-lesson-tool --apply"
const prBareKey = patternKey(prBareSig)
await writeFile(join(prProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: [
  seedGate({ key: prMachineKey, signature: prMachineSig, snippet: "exit code 1", count: 2, correction: prStaleMachine, correctionOrigin: "machine" }),
  seedGate({ key: prAgentKey, signature: prAgentSig, snippet: "exit code 1", count: 2, correction: "custom agent fix", correctionOrigin: "agent" }),
  seedGate({ key: prBareKey, signature: prBareSig, snippet: "exit code 1", count: 2 }),
] }), "utf8")
const prStores = new Stores(new GateStore(prGlobal), new GateStore(prProjectStore))
const drivePromotion = (key: string, signature: string): Promise<{ promoted: boolean }> =>
  prStores.recordFailure({ key, signature, tool: "bash", sessionID: "s3", projectDir: prProject, snippet: "exit code 1", globalProjects: GLOBAL_PROJECTS })
const prMachineRes = await drivePromotion(prMachineKey, prMachineSig)
const prAgentRes = await drivePromotion(prAgentKey, prAgentSig)
const prBareRes = await drivePromotion(prBareKey, prBareSig)
const prRows = await readGates(prProjectStore)
const prMachine = prRows.find((g) => g.key === prMachineKey)
const prAgent = prRows.find((g) => g.key === prAgentKey)
const prBare = prRows.find((g) => g.key === prBareKey)
check("promotion re-derives a stale machine-origin correction", prMachineRes.promoted === true && prMachine?.correction === suggestCorrection(prMachineSig, "exit code 1") && prMachine?.correctionOrigin === "machine")
check("promotion preserves an agent-authored correction", prAgentRes.promoted === true && prAgent?.correction === "custom agent fix" && prAgent?.correctionOrigin === "agent")
check("promotion derives a correction when none exists", prBareRes.promoted === true && prBare?.correction === suggestCorrection(prBareSig, "exit code 1") && prBare?.correctionOrigin === "machine")

// --- 20. promotion ADVANCES the retirement baseline instead of deleting it ---
const rbGlobal = join(tmp, "rb-global")
const rbProject = join(tmp, "rb-project")
const rbProjectStore = join(rbProject, ".opencode", "dejavu")
await mkdir(rbGlobal, { recursive: true })
await mkdir(rbProjectStore, { recursive: true })
const rbSig = "bash:cycle-tool --run"
const rbKey = patternKey(rbSig)
await writeFile(join(rbProjectStore, "gates.json"), JSON.stringify({ version: 1, gates: [
  seedGate({ key: rbKey, signature: rbSig, count: 0, sessions: [], snippet: "exit code 1" }),
] }), "utf8")
const rbStores = new Stores(new GateStore(rbGlobal), new GateStore(rbProjectStore))
const rbFail = (sessionID: string): Promise<{ promoted: boolean }> =>
  rbStores.recordFailure({ key: rbKey, signature: rbSig, tool: "bash", sessionID, projectDir: rbProject, snippet: "exit code 1", globalProjects: GLOBAL_PROJECTS })
const rbSuccess = (sessionID: string): Promise<void> => rbStores.recordSuccess({ key: rbKey, signature: rbSig, tool: "bash", sessionID })
const rbRow = async (): Promise<GateRow | undefined> => (await readGates(rbProjectStore)).find((g) => g.key === rbKey)
const rbBaseline = (row: GateRow | undefined): number | undefined =>
  row?.retireBaseline === undefined ? undefined : (row.retireBaseline as { count: number }).count

await rbFail("c1")
await rbFail("c2")
const rbPromote1 = await rbFail("c2")
const rbAfter1 = await rbRow()
check("damping cycle: the first promotion fires at the lifetime bar", rbPromote1.promoted === true)
check("damping cycle: promotion advances the baseline to the lifetime count", rbBaseline(rbAfter1) === 3)

await rbSuccess("h1")
await rbSuccess("h1")
await rbSuccess("h1")
check("damping cycle: heal retires to watching", (await rbRow())?.status === "watching")

await rbFail("c3")
await rbFail("c4")
const rbPromote2 = await rbFail("c4")
const rbAfter2 = await rbRow()
check("damping cycle: re-promotion earns a full fresh bar", rbPromote2.promoted === true)
check("damping cycle: re-promotion ADVANCES the baseline instead of deleting it", rbBaseline(rbAfter2) === 6)
check("damping cycle: a failure right after re-promotion does not re-promote again", (await rbFail("c5")).promoted === false)

await rbSuccess("h2")
await rbSuccess("h2")
await rbSuccess("h2")
const rbAfter3 = await rbRow()
check("damping cycle: the second retirement keeps a baseline", rbAfter3?.status === "watching" && rbBaseline(rbAfter3) === 7)

const rbFail6 = await rbFail("c6")
const rbFail7 = await rbFail("c7")
const rbAfter4 = await rbRow()
check("damping cycle: the retired gate does not re-promote before the threshold", rbFail6.promoted === false && rbFail7.promoted === false && rbAfter4?.status === "watching")
const rbPromote3 = await rbFail("c7")
const rbAfter5 = await rbRow()
check("damping cycle: a third promotion fires and advances the baseline again", rbPromote3.promoted === true && rbBaseline(rbAfter5) === 10)

if (process.env.BENCH === "1") {
  const benchProject = join(tmp, "bench-project")
  const benchGlobal = join(tmp, "bench-global")
  const benchProjectStore = join(benchProject, ".opencode", "dejavu")
  await mkdir(benchProjectStore, { recursive: true })
  await mkdir(benchGlobal, { recursive: true })
  const benchGates = Array.from({ length: 300 }, (_, i) => seedGate({ key: `bench${String(i).padStart(8, "0")}`, signature: `bash:bench-cmd-${i} --flag-${i} value-${i}`, status: "watching", count: 3, lastSeen: "2026-09-28T00:00:00.000Z" }))
  const benchFile = { version: 1, gates: benchGates, migrated: PLUGIN_VERSION, lastInitVersion: PLUGIN_VERSION }
  await writeFile(join(benchProjectStore, "gates.json"), JSON.stringify(benchFile, null, 2), "utf8")
  await writeFile(join(benchGlobal, "gates.json"), JSON.stringify(benchFile, null, 2), "utf8")
  const benchLines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ ts: new Date(2026, 8, 1 + (i % 28)).toISOString(), type: "detected", key: `bench${String(i % 300).padStart(8, "0")}` }))
  await writeFile(join(benchProjectStore, "log.jsonl"), `${benchLines.join("\n")}\n`, "utf8")
  await writeFile(join(benchGlobal, "log.jsonl"), `${benchLines.join("\n")}\n`, "utf8")
  const benchGatesPaths = [join(benchProjectStore, "gates.json"), join(benchGlobal, "gates.json")]
  const ITER = 20
  let rewrites = 0
  const t0 = performance.now()
  for (let i = 0; i < ITER; i++) {
    const before = await Promise.all(benchGatesPaths.map((p) => stat(p)))
    const stores = new Stores(new GateStore(benchGlobal), new GateStore(benchProjectStore))
    await stores.reconcileAll()
    await stores.migrate()
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
    const after = await Promise.all(benchGatesPaths.map((p) => stat(p)))
    if (after.some((info, j) => info.mtimeMs !== before[j]?.mtimeMs)) rewrites++
  }
  const elapsed = performance.now() - t0
  console.log(`bench: iterations=${ITER} total=${elapsed.toFixed(1)}ms avg=${(elapsed / ITER).toFixed(2)}ms gatesRewrites=${rewrites}`)
}

report()
