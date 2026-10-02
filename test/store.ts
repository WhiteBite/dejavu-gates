/**
 * Store-layer characterization: reconcile no-op rewrite skip, log excise
 * prefilter, expireAll peek gating, index structural-vs-deferred writes, and
 * the shared atomicWrite (long-path). Run: bun test/store.ts (BENCH=1 adds
 * the CLI-init benchmark over a 300-gate + 2x3000-line store).
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { atomicWrite, ntPath } from "../src/fs"
import { callSignature, patternKey } from "../src/patterns"
import { GateStore, GLOBAL_PROJECTS, NOISE_TTL_DAYS, PLUGIN_VERSION, Stores, TTL_DAYS } from "../src/store"
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
