/**
 * `dejavu lesson` end-to-end: spawns `bun src/main.ts lesson ...` over a temp
 * store and asserts stdout/stderr/exit-code plus the persisted correction.
 * Run: bun test/lesson.ts
 */
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { callSignature, patternKey } from "../src/patterns"
import { createStores, GLOBAL_PROJECTS } from "../src/store"
import { makeChecker } from "./helpers"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const mainPath = join(repoRoot, "src", "main.ts")

const { check, report } = makeChecker()

const root = await mkdtemp(join(tmpdir(), "dejavu-lesson-test-"))
const home = join(root, "home")
const projectDir = join(root, "proj")
process.env.DEJAVU_HOME = home
await mkdir(join(projectDir, ".opencode", "dejavu"), { recursive: true })
await mkdir(home, { recursive: true })

const command = "boom-tool --do-thing"
const signature = callSignature("bash", { command })
if (signature === null) throw new Error(`no signature for ${command}`)
const key = patternKey(signature)

const familyCommand = "npm test"
const familySignature = callSignature("bash", { command: familyCommand })
if (familySignature === null) throw new Error(`no signature for ${familyCommand}`)
const familyKey = patternKey(familySignature)

const stores = createStores(projectDir)
for (const [gateKey, sig, snippet] of [
  [key, signature, "Error: boom"],
  [familyKey, familySignature, "Error: assertion failed"],
] as [string, string, string][]) {
  for (const [sessionID, times] of [["s1", 2], ["s2", 1]] as [string, number][]) {
    for (let i = 0; i < times; i++) {
      await stores.recordFailure({ key: gateKey, signature: sig, tool: "bash", sessionID, projectDir, snippet, globalProjects: GLOBAL_PROJECTS })
    }
  }
}

interface LessonResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runLesson(args: string[], cwd: string = repoRoot): LessonResult {
  const proc = spawnSync("bun", [mainPath, "lesson", ...args], {
    env: { ...process.env, DEJAVU_HOME: home },
    cwd,
    encoding: "utf8",
  })
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 }
}

const gatesPath = join(projectDir, ".opencode", "dejavu", "gates.json")
const globalGatesPath = join(home, "gates.json")

async function correctionIn(file: string, gateKey: string): Promise<string | undefined> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { gates: Array<{ key: string; correction?: string }> }
  return parsed.gates.find((g) => g.key === gateKey)?.correction
}

async function persistedCorrection(): Promise<string | undefined> {
  return correctionIn(gatesPath, key)
}

interface LessonGateRow {
  key: string
  correctionAt?: number
  correctionBaseline?: { recurred: number; reminded: number; overrides: number; promoted?: number }
  retireWhen?: { kind: string; name?: string; min?: string; mode?: string; path?: string; tag?: string }
  recurredAfterGate: number
  remindedCount: number
  overrideCount: number
}

async function gateRow(file: string, gateKey: string): Promise<LessonGateRow | undefined> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { gates: LessonGateRow[] }
  return parsed.gates.find((g) => g.key === gateKey)
}

function lineFor(stdout: string, gateKey: string): string | undefined {
  return stdout.split("\n").find((l) => l.includes(gateKey))
}

const machineList = runLesson(["--store", projectDir, "list"])
check("list before any set → exit 0", machineList.exitCode === 0)
check("list shows the promoted gate with correction=machine", lineFor(machineList.stdout, key)?.includes("correction=machine") === true)
check("family-correction gate (npm test) lists as correction=machine", lineFor(machineList.stdout, familyKey)?.includes("correction=machine") === true)
check("family gate persisted a non-template machine correction", (await correctionIn(gatesPath, familyKey))?.startsWith("Last error:") === false)

const written = runLesson(["--store", projectDir, "set", key, "Use npm ci in CI"])
check("set writes the correction → exit 0", written.exitCode === 0)
check("set without --author prints the agent-default hint", written.stderr.includes(`author defaulted to "agent"`))
check("persisted correction equals the text", (await persistedCorrection()) === "Use npm ci in CI")
const stamped = await gateRow(gatesPath, key)
check("set persists correctionAt as epoch ms", typeof stamped?.correctionAt === "number" && stamped.correctionAt > 0)
check(
  "set persists correctionBaseline snapshotting the counters",
  stamped?.correctionBaseline !== undefined &&
    stamped.correctionBaseline.recurred === stamped.recurredAfterGate &&
    stamped.correctionBaseline.reminded === stamped.remindedCount &&
    stamped.correctionBaseline.overrides === stamped.overrideCount,
)
check("set emits a corrected event in the project log", (await readFile(join(projectDir, ".opencode", "dejavu", "log.jsonl"), "utf8")).includes('"corrected"'))

const agentList = runLesson([`--store=${projectDir}`, "list"])
check("list after a default set shows correction=agent (--store= form)", agentList.exitCode === 0 && lineFor(agentList.stdout, key)?.includes("correction=agent") === true)

const ownerSet = runLesson(["--store", projectDir, "--author", "owner", "set", key, "owner-written fix"])
check("set --author owner → exit 0 with no default-author hint", ownerSet.exitCode === 0 && !ownerSet.stderr.includes("author defaulted"))
check("list after --author owner shows correction=owner", lineFor(runLesson(["--store", projectDir, "list"]).stdout, key)?.includes("correction=owner") === true)

const badAuthor = runLesson(["--store", projectDir, "--author", "human", "set", key, "x"])
check("an invalid --author value → exit 1 usage error", badAuthor.exitCode === 1 && badAuthor.stderr.includes("usage:"))

const missing = runLesson(["--store", projectDir, "set", "000000000000", "x"])
check("set on an unknown key → exit 1", missing.exitCode === 1)
check("unknown-key stderr explains mechanical promotion", missing.stderr.includes("promotion is mechanical"))
const missingLong = runLesson(["--store", projectDir, "set", "000000000000", "x".repeat(300)])
check("unknown key with over-long text → exit 1, no truncation warning", missingLong.exitCode === 1 && !missingLong.stderr.includes("truncated"))

const badKey = runLesson(["--store", projectDir, "set", "not-a-key", "x"])
check("set with a malformed key → exit 1", badKey.exitCode === 1)

const listExtra = runLesson(["--store", projectDir, "list", "extra-arg"])
check("list with residual args → exit 1 usage error", listExtra.exitCode === 1 && listExtra.stderr.includes("usage:"))
const showExtra = runLesson(["--store", projectDir, "show", key, "extra-arg"])
check("show with residual args → exit 1 usage error", showExtra.exitCode === 1 && showExtra.stderr.includes("usage:"))

const capped = runLesson(["--store", projectDir, "set", key, "x".repeat(300)])
check("set over the 200-char cap → exit 0 with a truncation warning", capped.exitCode === 0 && capped.stderr.includes("truncated"))
check("persisted correction is capped at 200 chars", (await persistedCorrection())?.length === 200)

const dirty = runLesson(["--store", projectDir, "set", key, "red \u001b[31mtext\u001b[0m with secret sk-ant-api03-abcdefghijklmnopqrst"])
const persistedDirty = await persistedCorrection()
check("set with ANSI + secret → exit 0", dirty.exitCode === 0)
check("persisted correction carries no ESC char and scrubs the secret", persistedDirty !== undefined && !persistedDirty.includes("\u001b") && !persistedDirty.includes("sk-ant") && persistedDirty.includes("red text"))

const storeTokenText = "pass --store and --store=x through to the wrapper verbatim"
const storeToken = runLesson(["--store", projectDir, "set", key, storeTokenText])
check("correction containing --store tokens survives verbatim", storeToken.exitCode === 0 && (await persistedCorrection()) === storeTokenText)
check("a --store token in the correction text draws a stderr note", storeToken.stderr.includes("must precede"))

const dashDash = runLesson(["--store", projectDir, "--", "set", key, "dash-dash text"])
check("-- ends the option region", dashDash.exitCode === 0 && (await persistedCorrection()) === "dash-dash text")

const emptyEq = runLesson(["--store=", "list"])
check("--store= with an empty value → exit 1", emptyEq.exitCode === 1 && emptyEq.stderr.includes("--store requires a directory"))

const emptySp = runLesson(["--store", "", "list"])
check("--store with an empty value → exit 1", emptySp.exitCode === 1)

await copyFile(gatesPath, globalGatesPath)
const dupList = runLesson(["--store", projectDir, "list"])
const dupLines = dupList.stdout.split("\n").filter((l) => l.includes(key))
check("dual-scope duplicate lists one line", dupList.exitCode === 0 && dupLines.length === 1)
check("dual-scope list line names the project scope", dupLines[0]?.includes("scope=project") === true)
const dupSet = runLesson(["--store", projectDir, "set", key, "shared across scopes"])
check("dual-scope set → exit 0", dupSet.exitCode === 0)
check("dual-scope set reports both store files", dupSet.stdout.includes(gatesPath) && dupSet.stdout.includes(globalGatesPath))
check("dual-scope set updates both copies", (await correctionIn(gatesPath, key)) === "shared across scopes" && (await correctionIn(globalGatesPath, key)) === "shared across scopes")

const templateText = `Last error: "Error: boom" — address that specific error before retrying this exact call.`
const templateSet = runLesson(["--store", projectDir, "set", key, templateText])
check("agent correction matching the machine template → exit 0", templateSet.exitCode === 0)
const templateList = runLesson(["--store", projectDir, "list"])
check("template-matching agent correction re-derives to machine after load()", templateList.exitCode === 0 && lineFor(templateList.stdout, key)?.includes("correction=machine") === true)
const templateOwnerSet = runLesson(["--store", projectDir, "--author=owner", "set", key, templateText])
const templateOwnerList = runLesson(["--store", projectDir, "list"])
check("template-matching owner correction stays owner after load()", templateOwnerSet.exitCode === 0 && templateOwnerList.exitCode === 0 && lineFor(templateOwnerList.stdout, key)?.includes("correction=owner") === true)

const emojiSet = runLesson(["--store", projectDir, "set", key, "a".repeat(199) + "\u{1F600}"])
check("surrogate-boundary set → exit 0 with a truncation warning", emojiSet.exitCode === 0 && emojiSet.stderr.includes("truncated"))
check("truncated correction never ends on a lone surrogate", (await persistedCorrection()) === "a".repeat(199))

const final = runLesson(["--store", projectDir, "set", key, "Prefer the locked toolchain"])
check("final set before show → exit 0", final.exitCode === 0)
const shown = runLesson(["show", key], projectDir)
check("show with the cwd store default → exit 0", shown.exitCode === 0)
check("show prints the correction and the signature", shown.stdout.includes("Prefer the locked toolchain") && shown.stdout.includes(signature))

const watchCommand = "watch-probe --quiet"
const watchSignature = callSignature("bash", { command: watchCommand })
if (watchSignature === null) throw new Error(`no signature for ${watchCommand}`)
const watchKey = patternKey(watchSignature)
await stores.recordFailure({ key: watchKey, signature: watchSignature, tool: "bash", sessionID: "s1", projectDir, snippet: "Error: watch", globalProjects: GLOBAL_PROJECTS })
const watchSet = runLesson(["--store", projectDir, "set", watchKey, "fix the watch probe"])
check("set on a watching gate → exit 0 with a not-enforced warning", watchSet.exitCode === 0 && watchSet.stderr.includes("not currently enforced"))

const defaultList = runLesson(["--store", projectDir, "list"])
check("default list hides the watching gate", defaultList.exitCode === 0 && lineFor(defaultList.stdout, watchKey) === undefined)
const allList = runLesson(["--store", projectDir, "--all", "list"])
const watchRow = lineFor(allList.stdout, watchKey)
check("list --all shows the watching gate marked enforced=no", allList.exitCode === 0 && watchRow?.includes("watching") === true && watchRow?.includes("enforced=no") === true)
check("list --all keeps enforced rows unmarked", lineFor(allList.stdout, key)?.includes("enforced=no") === false)
const allAfterSub = runLesson(["--store", projectDir, "list", "--all"])
check("--all after the subcommand stays a usage error", allAfterSub.exitCode === 1 && allAfterSub.stderr.includes("usage:"))

// --- retire-when: set, show round-trip, clear ---
const rwSet = runLesson(["--store", projectDir, "retire-when", key, "dep:typescript@>=5.0.0"])
check("retire-when set → exit 0", rwSet.exitCode === 0)
check("retire-when persists the dep condition in the project store", (await gateRow(gatesPath, key))?.retireWhen?.name === "typescript")
check("retire-when writes every owning scope", (await gateRow(globalGatesPath, key))?.retireWhen?.min === "5.0.0")
const rwShown = runLesson(["--store", projectDir, "show", key])
check("show re-renders the retire-when spec", rwShown.exitCode === 0 && rwShown.stdout.includes("retire-when: dep:typescript@>=5.0.0"))
check("show prints the lesson verdict line", rwShown.stdout.includes("lesson:"))
const rwClear = runLesson(["--store", projectDir, "retire-when", key, "--clear"])
check("retire-when --clear → exit 0", rwClear.exitCode === 0)
check("retire-when --clear removes the condition from every scope", (await gateRow(gatesPath, key))?.retireWhen === undefined && (await gateRow(globalGatesPath, key))?.retireWhen === undefined)
const rwClearedShow = runLesson(["--store", projectDir, "show", key])
check("show omits the retire-when line after clear", rwClearedShow.exitCode === 0 && !rwClearedShow.stdout.includes("retire-when:"))
const rwBadSpec = runLesson(["--store", projectDir, "retire-when", key, "bogus:spec"])
check("an unknown retire-when spec → exit 1 usage error", rwBadSpec.exitCode === 1 && rwBadSpec.stderr.includes("usage:"))
const rwMissingKey = runLesson(["--store", projectDir, "retire-when", "000000000000", "tag:v1"])
check("retire-when on an unknown key → exit 1", rwMissingKey.exitCode === 1)

// --- list appends stale= for a gate whose lesson went stale ---
const staleFile = JSON.parse(await readFile(gatesPath, "utf8")) as { gates: LessonGateRow[] }
const staleGate = staleFile.gates.find((g) => g.key === key)
if (staleGate !== undefined) staleGate.recurredAfterGate = 3
await writeFile(gatesPath, JSON.stringify(staleFile), "utf8")
const staleList = runLesson(["--store", projectDir, "list"])
check("list appends stale=stale for a stale gate", lineFor(staleList.stdout, key)?.includes("stale=stale") === true)

report()
