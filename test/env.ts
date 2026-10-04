/**
 * DEJAVU_* env overrides: the constants resolve from the environment once at
 * module load, so probes run in a child process. Run: bun test/env.ts
 */
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeChecker } from "./helpers"

interface Probe {
  resolved: Record<string, number>
  status: string | null
  count: number
}

async function runProbe(): Promise<void> {
  const { mkdir, readFile } = await import("node:fs/promises")
  const { createStores, GLOBAL_PROJECTS, PROMOTE_COUNT, PROMOTE_COUNT_PROBE, PROMOTE_SESSIONS, TTL_DAYS, NOISE_TTL_DAYS, HEAL_SUCCESSES, DEMOTE_RECURRENCES, DEMOTE_OVERRIDES } = await import("../src/store")
  const { TAUGHT_REMINDERS } = await import("../src/context")
  const { callSignature, patternKey } = await import("../src/patterns")

  const probeTmp = await mkdtemp(join(tmpdir(), "dejavu-env-probe-"))
  const projectDir = join(probeTmp, "proj")
  await mkdir(join(projectDir, ".opencode", "dejavu"), { recursive: true })
  await mkdir(process.env.DEJAVU_HOME ?? join(probeTmp, "home"), { recursive: true })

  const stores = createStores(projectDir)
  const command = "boom-tool --do-thing"
  const signature = callSignature("bash", { command })
  if (signature === null) throw new Error(`no signature for ${command}`)
  const key = patternKey(signature)
  for (const [sessionID, times] of [["s1", 2], ["s2", 1]] as [string, number][]) {
    for (let i = 0; i < times; i++) {
      await stores.recordFailure({ key, signature, tool: "bash", sessionID, projectDir, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
    }
  }

  const file = JSON.parse(await readFile(join(projectDir, ".opencode", "dejavu", "gates.json"), "utf8")) as { gates: Array<{ key: string; status: string; count: number }> }
  const gate = file.gates.find((g) => g.key === key)
  console.log(JSON.stringify({
    resolved: { PROMOTE_COUNT, PROMOTE_COUNT_PROBE, PROMOTE_SESSIONS, TTL_DAYS, NOISE_TTL_DAYS, HEAL_SUCCESSES, DEMOTE_RECURRENCES, DEMOTE_OVERRIDES, TAUGHT_REMINDERS },
    status: gate?.status ?? null,
    count: gate?.count ?? 0,
  }))
}

async function runChecks(): Promise<void> {
  const { check, report } = makeChecker()
  const testPath = fileURLToPath(import.meta.url)
  const root = await mkdtemp(join(tmpdir(), "dejavu-env-test-"))
  let seq = 0

  function probe(extra: Record<string, string>): Probe {
    seq += 1
    const proc = spawnSync("bun", [testPath], {
      env: { ...process.env, DEJAVU_ENV_PROBE: "1", DEJAVU_HOME: join(root, `home-${seq}`), ...extra },
      encoding: "utf8",
    })
    const out = (proc.stdout ?? "").trim().split("\n").filter((line) => line.startsWith("{"))
    if (proc.status !== 0 || out.length === 0) {
      throw new Error(`probe failed (exit ${proc.status}): ${proc.stderr ?? ""}`)
    }
    return JSON.parse(out[out.length - 1] ?? "{}") as Probe
  }

  const defaults = probe({})
  check("defaults resolve the documented constants", defaults.resolved.PROMOTE_COUNT === 3 && defaults.resolved.PROMOTE_COUNT_PROBE === 5 && defaults.resolved.PROMOTE_SESSIONS === 2 && defaults.resolved.HEAL_SUCCESSES === 3 && defaults.resolved.DEMOTE_RECURRENCES === 3 && defaults.resolved.DEMOTE_OVERRIDES === 3 && defaults.resolved.TAUGHT_REMINDERS === 5 && defaults.resolved.TTL_DAYS === 60 && defaults.resolved.NOISE_TTL_DAYS === 7)
  check("default promotion fires at 3 failures across 2 sessions", defaults.status === "blocking" && defaults.count === 3)

  const overridden = probe({ DEJAVU_PROMOTE_COUNT: "99", DEJAVU_PROMOTE_COUNT_PROBE: "88", DEJAVU_PROMOTE_SESSIONS: "77", DEJAVU_TTL_DAYS: "120", DEJAVU_NOISE_TTL_DAYS: "30", DEJAVU_HEAL_SUCCESSES: "9", DEJAVU_DEMOTE_RECURRENCES: "8", DEJAVU_DEMOTE_OVERRIDES: "7", DEJAVU_TAUGHT_REMINDERS: "6" })
  check("every DEJAVU_* override replaces its constant", overridden.resolved.PROMOTE_COUNT === 99 && overridden.resolved.PROMOTE_COUNT_PROBE === 88 && overridden.resolved.PROMOTE_SESSIONS === 77 && overridden.resolved.TTL_DAYS === 120 && overridden.resolved.NOISE_TTL_DAYS === 30 && overridden.resolved.HEAL_SUCCESSES === 9 && overridden.resolved.DEMOTE_RECURRENCES === 8 && overridden.resolved.DEMOTE_OVERRIDES === 7 && overridden.resolved.TAUGHT_REMINDERS === 6)
  check("PROMOTE_COUNT=99 stops promotion at 3 failures", overridden.status === "watching" && overridden.count === 3)

  const nonInteger = probe({ DEJAVU_PROMOTE_COUNT: "abc", DEJAVU_TAUGHT_REMINDERS: "abc" })
  check("a non-integer override falls back to the default", nonInteger.resolved.PROMOTE_COUNT === 3 && nonInteger.resolved.TAUGHT_REMINDERS === 5 && nonInteger.status === "blocking")
  const fractional = probe({ DEJAVU_PROMOTE_COUNT: "3.5" })
  check("a fractional override falls back to the default", fractional.resolved.PROMOTE_COUNT === 3)
  const belowMin = probe({ DEJAVU_PROMOTE_COUNT: "0" })
  check("a below-min override falls back to the default", belowMin.resolved.PROMOTE_COUNT === 3 && belowMin.status === "blocking")
  const aboveMax = probe({ DEJAVU_PROMOTE_COUNT: "100000" })
  check("an above-max override falls back to the default", aboveMax.resolved.PROMOTE_COUNT === 3 && aboveMax.status === "blocking")

  report()
}

if (process.env.DEJAVU_ENV_PROBE === "1") await runProbe()
else await runChecks()