/** Installer e2e: drives `bun src/main.ts <install|uninstall|hooks>` and the node bin shim against temp HOME/cwd worlds. Run: bun test/install.ts */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeChecker } from "./helpers"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const mainTs = join(repoRoot, "src", "main.ts")
const binJs = join(repoRoot, "bin", "dejavu.mjs")
const root = await mkdtemp(join(tmpdir(), "dejavu-install-test-"))

const { check, report } = makeChecker()

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

function run(args: readonly string[], cwd: string, homeDir: string, stdin = ""): Run {
  const proc = spawnSync("bun", [mainTs, ...args], {
    input: stdin,
    cwd,
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    encoding: "utf8",
  })
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", code: proc.status ?? -1 }
}

async function world(name: string): Promise<{ cwd: string; home: string }> {
  const cwd = join(root, name)
  const home = join(root, `${name}-home`)
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  return { cwd, home }
}

// --- S1+S2: install → idempotent re-install with rotating backup ---
const a = await world("a")
const inst1 = run(["install", "--harness", "claude", "--project", "--yes"], a.cwd, a.home)
check("install claude --project exits 0", inst1.code === 0)
const settingsA = join(a.cwd, ".claude", "settings.json")
check("install wrote .claude/settings.json", existsSync(settingsA))

interface Settings {
  hooks?: Record<string, unknown[]>
}
const s1 = JSON.parse(await readFile(settingsA, "utf8")) as Settings
const pre1 = s1.hooks?.PreToolUse ?? []
check("settings.json parses, exactly one dejavu PreToolUse entry", Array.isArray(pre1) && pre1.length === 1)
const cmd1 = JSON.stringify(pre1)
check("hook command carries src/cli.ts and --harness claude", cmd1.includes("src/cli.ts") && cmd1.includes("--harness claude"))

const inst2 = run(["install", "--harness", "claude", "--project", "--yes"], a.cwd, a.home)
check("re-install exits 0", inst2.code === 0)
const s2 = JSON.parse(await readFile(settingsA, "utf8")) as Settings
check("re-install stays idempotent (still one PreToolUse entry)", (s2.hooks?.PreToolUse ?? []).length === 1)
check("re-install rotated a .dejavu-bak backup", existsSync(`${settingsA}.dejavu-bak`))

// --- S3+S4: foreign hook survives install AND uninstall ---
const b = await world("b")
await mkdir(join(b.cwd, ".claude"), { recursive: true })
const settingsB = join(b.cwd, ".claude", "settings.json")
const foreignEntry = { matcher: "Bash", hooks: [{ type: "command", command: "echo foreign" }] }
await writeFile(settingsB, JSON.stringify({ hooks: { PreToolUse: [foreignEntry] } }, null, 2), "utf8")
run(["install", "--harness", "claude", "--project", "--yes"], b.cwd, b.home)
const sB1 = JSON.parse(await readFile(settingsB, "utf8")) as Settings
const preB1 = JSON.stringify(sB1.hooks?.PreToolUse ?? [])
check("install preserves the foreign hook entry", preB1.includes("echo foreign"))
check("install adds dejavu alongside foreign", preB1.includes("--harness claude"))

const un = run(["uninstall", "--harness", "claude", "--project", "--yes"], b.cwd, b.home)
check("uninstall exits 0", un.code === 0)
const sB2 = JSON.parse(await readFile(settingsB, "utf8")) as Settings
const preB2 = JSON.stringify(sB2.hooks?.PreToolUse ?? [])
check("uninstall strips dejavu entries", !preB2.includes("--harness claude"))
check("uninstall keeps the foreign entry", preB2.includes("echo foreign"))

// --- S5: auto-detect from user-scope markers (no --harness) ---
const c = await world("c")
await mkdir(join(c.home, ".claude"), { recursive: true })
const inst5 = run(["install", "--user", "--yes"], c.cwd, c.home)
check("auto-detect install exits 0", inst5.code === 0)
check("auto-detect printed the detected list", inst5.stderr.includes("claude"))
check("auto-detect wrote ~/.claude/settings.json", existsSync(join(c.home, ".claude", "settings.json")))
check("auto-detect left undetected harnesses untouched", !existsSync(join(c.home, ".codex")) && !existsSync(join(c.home, ".gemini")))

// --- S6: hooks --check → ok, then stale after the cli path rots ---
const chk1 = run(["hooks", "--check"], a.cwd, a.home)
check("hooks --check on installed project exits 0", chk1.code === 0)
check("hooks --check reports claude ok", chk1.stderr.includes("claude: ok"))

const staleSettings = (await readFile(settingsA, "utf8")).replaceAll("src/cli.ts", "src/gone.ts")
await writeFile(settingsA, staleSettings, "utf8")
const chk2 = run(["hooks", "--check"], a.cwd, a.home)
check("hooks --check with a moved cli exits 1", chk2.code === 1)
check("hooks --check reports stale", chk2.stderr.includes("claude: stale"))

// --- S7: node bin shim → dispatcher → fail-open hook chain ---
const binRun = spawnSync("node", [binJs, "pre", "--harness", "claude"], {
  input: "{}",
  cwd: a.cwd,
  env: { ...process.env, USERPROFILE: a.home, HOME: a.home },
  encoding: "utf8",
})
check("node bin/dejavu.mjs pre exits 0", (binRun.status ?? -1) === 0)
check("node bin shim stdout is pure {}", (binRun.stdout ?? "").trim() === "{}")

// --- S8: copilot standalone file — uninstall removes it whole, foreign files survive ---
const d = await world("d")
await mkdir(join(d.cwd, ".github", "hooks"), { recursive: true })
const copilotTarget = join(d.cwd, ".github", "hooks", "dejavu.json")
const copilotBak = `${copilotTarget}.dejavu-bak`
const foreignNeighbor = join(d.cwd, ".github", "hooks", "other.json")
await writeFile(copilotTarget, JSON.stringify({ custom: true }), "utf8")
await writeFile(foreignNeighbor, JSON.stringify({ keep: true }), "utf8")
const inst8 = run(["install", "--harness", "copilot", "--project", "--yes"], d.cwd, d.home)
check("install copilot exits 0", inst8.code === 0)
check("install wrote the standalone copilot file", existsSync(copilotTarget))
const copilotConfig = await readFile(copilotTarget, "utf8")
check("standalone file carries the dejavu hook command", copilotConfig.includes("src/cli.ts") && copilotConfig.includes("--harness copilot"))
const bak8 = await readFile(copilotBak, "utf8")
check("install backed up the pre-existing file", bak8.includes("custom"))

const un8 = run(["uninstall", "--harness", "copilot", "--project", "--yes"], d.cwd, d.home)
check("uninstall copilot exits 0", un8.code === 0)
check("uninstall removed the standalone file entirely", !existsSync(copilotTarget))
check("uninstall kept the foreign neighbor file", existsSync(foreignNeighbor))
check("uninstall rotated a .dejavu-bak backup", existsSync(copilotBak))

// --- S9: explicit --user scope writes the home config, not the project one ---
const e = await world("e")
const inst9 = run(["install", "--harness", "claude", "--user", "--yes"], e.cwd, e.home)
check("explicit --user install exits 0", inst9.code === 0)
const userSettings = join(e.home, ".claude", "settings.json")
check("explicit --user wrote ~/.claude/settings.json", existsSync(userSettings))
const s9 = await readFile(userSettings, "utf8")
check("user-scope config carries the dejavu hook command", s9.includes("src/cli.ts") && s9.includes("--harness claude"))
check("explicit --user left the project scope untouched", !existsSync(join(e.cwd, ".claude")))

// --- S10: hooks --check reports broken on an unparseable config ---
const f = await world("f")
await mkdir(join(f.cwd, ".claude"), { recursive: true })
await writeFile(join(f.cwd, ".claude", "settings.json"), "{ not json", "utf8")
const chk10 = run(["hooks", "--check"], f.cwd, f.home)
check("hooks --check with an unparseable config exits 1", chk10.code === 1)
check("hooks --check reports broken", chk10.stderr.includes("claude: broken"))

report()
