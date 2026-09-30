/**
 * Recurrence-after-gate report characterization: seeds a store with known gate
 * states, runs scripts/analyze.ts, and asserts each gate's verdict.
 * Run: bun test/recurrence.ts
 */
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Gate } from "../src/store"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), "dejavu-recurrence-test-"))
const globalDir = join(tmp, "global")
const projectDir = join(tmp, "project")
const storeDir = join(projectDir, ".opencode", "dejavu")
await mkdir(storeDir, { recursive: true })
await mkdir(globalDir, { recursive: true })

const now = Date.now()

function gate(overrides: Partial<Gate> & Pick<Gate, "key" | "signature" | "status">): Gate {
  return {
    tool: "bash",
    count: 5,
    sessions: ["seed-1", "seed-2"],
    projects: [projectDir],
    firstSeen: new Date(now - 60_000).toISOString(),
    lastSeen: new Date(now).toISOString(),
    snippet: "Error: boom",
    remindedCount: 0,
    blockedCount: 0,
    recurredAfterReminder: 0,
    recurredAfterGate: 0,
    overrideCount: 0,
    promotionCount: 1,
    ...overrides,
  }
}

const gates: Gate[] = [
  gate({ key: "aaaa00000001", signature: "bash:some-tool --teach-thing", status: "blocking", succeededAfterGate: 2, remindedSessions: { "s-live": now } }),
  gate({ key: "aaaa00000002", signature: "bash:some-tool --work-thing", status: "blocking", recurredAfterGate: 1 }),
  gate({ key: "aaaa00000003", signature: "bash:some-tool --friction-thing", status: "blocking", recurredAfterGate: 4 }),
  gate({ key: "aaaa00000004", signature: "bash:some-tool --override-thing", status: "blocking", overrideCount: 3, overrideSessions: ["o1", "o2"] }),
  gate({ key: "aaaa00000005", signature: "bash:some-tool --demoted-thing", status: "watching", recurredAfterGate: 5, feedbackDemoted: true, feedbackBaseline: { recurred: 5, overrides: 0 } }),
  gate({ key: "aaaa00000006", signature: "bash:some-tool --fresh-thing", status: "watching", count: 1, promotionCount: undefined }),
  gate({ key: "aaaa00000007", signature: `bash:some-tool --${"z".repeat(100)}`, status: "blocking", recurredAfterGate: 1 }),
  gate({ key: "aaaa00000008", signature: "bash:grep needle src/haystack.ts", status: "reminding", recurredAfterGate: 1 }),
  gate({ key: "aaaa00000009", signature: "bash:some-tool --retired-thing", status: "watching", count: 8, retireBaseline: { count: 5 } }),
]

const gatesPath = join(storeDir, "gates.json")
const seedRaw = JSON.stringify({ version: 1, gates }, null, 2)
await writeFile(gatesPath, seedRaw, "utf8")

const analyzePath = join(repoRoot, "scripts", "analyze.ts")

function run(args: string[]): string {
  const proc = spawnSync(process.execPath, [analyzePath, ...args], {
    env: { ...process.env, DEJAVU_HOME: globalDir },
    encoding: "utf8",
  })
  if (proc.status !== 0) throw new Error(`analyze exited ${proc.status}: ${proc.stderr}`)
  return proc.stdout
}

function lineFor(out: string, needle: string): string {
  return out.split("\n").find((l) => l.includes(needle)) ?? ""
}

const recurrenceOut = run(["--recurrence", projectDir])

check("teaching gate renders TEACHING", lineFor(recurrenceOut, "some-tool --teach-thing").includes("TEACHING"))
check("enforced gate status is shown", lineFor(recurrenceOut, "some-tool --teach-thing").includes("blocking"))
check("heal state is shown", lineFor(recurrenceOut, "some-tool --teach-thing").includes("healing:2"))
check("remindedSessions chain count is shown", /\bchain\s+1\b/.test(lineFor(recurrenceOut, "some-tool --teach-thing")))
check("below-bar recurrence renders WORKING", lineFor(recurrenceOut, "some-tool --work-thing").includes("WORKING"))
check("recurrence at the bar renders FRICTION", lineFor(recurrenceOut, "some-tool --friction-thing").includes("FRICTION"))
check("frequent overrides render FRICTION", lineFor(recurrenceOut, "some-tool --override-thing").includes("FRICTION"))
check("feedback-demoted gate renders FRICTION", lineFor(recurrenceOut, "some-tool --demoted-thing").includes("FRICTION"))
check("feedback-demoted gate shows the demoted state", lineFor(recurrenceOut, "some-tool --demoted-thing").includes("demoted"))
check("a retireBaseline watching gate renders RETIRED", lineFor(recurrenceOut, "some-tool --retired-thing").includes("RETIRED"))
check("a retireBaseline gate shows the retired state", lineFor(recurrenceOut, "some-tool --retired-thing").includes("retired"))
check("reminding-tier enforced gate renders", lineFor(recurrenceOut, "grep needle").includes("WORKING"))
check("a watching gate that never promoted is excluded", !recurrenceOut.includes("some-tool --fresh-thing"))
check("long signatures are truncated to 80", lineFor(recurrenceOut, "some-tool --zzzz").includes("...") && !recurrenceOut.includes("z".repeat(90)))
check("aggregate counts every shown gate", recurrenceOut.includes("8 gates | teaching 1 | working 3 | friction 3 | retired 1"))
check("aggregate reports the teaching ratio", recurrenceOut.includes("teaching-ratio 13%"))
check("--recurrence omits the default summary", !recurrenceOut.includes("top by count:") && !recurrenceOut.includes("| tools:"))

const fullOut = run([projectDir])
check("default analyze keeps the recurrence section", fullOut.includes("recurrence report:"))
check("default analyze keeps the summary and top list", fullOut.includes("top by count:") && fullOut.includes("| tools:"))

check("report is read-only (gates.json bytes unchanged)", (await readFile(gatesPath, "utf8")) === seedRaw)

await rm(tmp, { recursive: true, force: true })

report()