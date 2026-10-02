/**
 * `dejavu lesson` end-to-end: spawns `bun src/main.ts lesson ...` over a temp
 * store and asserts stdout/stderr/exit-code plus the persisted correction.
 * Run: bun test/lesson.ts
 */
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
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

const stores = createStores(projectDir)
for (const [sessionID, times] of [["s1", 2], ["s2", 1]] as [string, number][]) {
  for (let i = 0; i < times; i++) {
    await stores.recordFailure({ key, signature, tool: "bash", sessionID, projectDir, snippet: "Error: boom", globalProjects: GLOBAL_PROJECTS })
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

async function persistedCorrection(): Promise<string | undefined> {
  const file = JSON.parse(await readFile(gatesPath, "utf8")) as { gates: Array<{ key: string; correction?: string }> }
  return file.gates.find((g) => g.key === key)?.correction
}

const machineList = runLesson(["list", "--store", projectDir])
check("list before any set → exit 0", machineList.exitCode === 0)
check("list shows the promoted gate with correction=machine", machineList.stdout.includes(key) && machineList.stdout.includes("correction=machine"))

const written = runLesson(["set", key, "Use npm ci in CI", "--store", projectDir])
check("set writes the correction → exit 0", written.exitCode === 0)
check("persisted correction equals the text", (await persistedCorrection()) === "Use npm ci in CI")

const humanList = runLesson(["list", `--store=${projectDir}`])
check("list after a set shows correction=human (--store= form)", humanList.exitCode === 0 && humanList.stdout.includes("correction=human"))

const missing = runLesson(["set", "000000000000", "x", "--store", projectDir])
check("set on an unknown key → exit 1", missing.exitCode === 1)
check("unknown-key stderr explains mechanical promotion", missing.stderr.includes("promotion is mechanical"))

const badKey = runLesson(["set", "not-a-key", "x", "--store", projectDir])
check("set with a malformed key → exit 1", badKey.exitCode === 1)

const capped = runLesson(["set", key, "x".repeat(300), "--store", projectDir])
check("set over the 200-char cap → exit 0 with a truncation warning", capped.exitCode === 0 && capped.stderr.includes("truncated"))
check("persisted correction is capped at 200 chars", (await persistedCorrection())?.length === 200)

const dirty = runLesson(["set", key, "red \u001b[31mtext\u001b[0m with secret sk-ant-api03-abcdefghijklmnopqrst", "--store", projectDir])
const persistedDirty = await persistedCorrection()
check("set with ANSI + secret → exit 0", dirty.exitCode === 0)
check("persisted correction carries no ESC char and scrubs the secret", persistedDirty !== undefined && !persistedDirty.includes("\u001b") && !persistedDirty.includes("sk-ant") && persistedDirty.includes("red text"))

const final = runLesson(["set", key, "Prefer the locked toolchain", "--store", projectDir])
check("final set before show → exit 0", final.exitCode === 0)
const shown = runLesson(["show", key], projectDir)
check("show with the cwd store default → exit 0", shown.exitCode === 0)
check("show prints the correction and the signature", shown.stdout.includes("Prefer the locked toolchain") && shown.stdout.includes(signature))

report()
