/** Installer e2e: drives `bun src/main.ts <install|uninstall|hooks>` and the node bin shim against temp HOME/cwd worlds. Run: bun test/install.ts */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { targetPath } from "../src/install"
import {
  collectCommandsRoot,
  HARNESSES,
  mergeConfig,
  mergeConfigRoot,
  stripDejavu,
  type Harness,
  type Json,
} from "../src/install-config"
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
const end1 = s1.hooks?.SessionEnd ?? []
check("install wrote exactly one dejavu SessionEnd entry", Array.isArray(end1) && end1.length === 1)
const endCmd1 = JSON.stringify(end1)
check("SessionEnd command runs session-event --harness claude", endCmd1.includes("session-event") && endCmd1.includes("--harness claude"))

const inst2 = run(["install", "--harness", "claude", "--project", "--yes"], a.cwd, a.home)
check("re-install exits 0", inst2.code === 0)
const s2 = JSON.parse(await readFile(settingsA, "utf8")) as Settings
check("re-install stays idempotent (still one PreToolUse entry)", (s2.hooks?.PreToolUse ?? []).length === 1)
check("re-install stays idempotent (still one SessionEnd entry)", (s2.hooks?.SessionEnd ?? []).length === 1)
check("re-install rotated a .dejavu-bak backup", existsSync(`${settingsA}.dejavu-bak`))

// --- S3+S4: foreign hook survives install AND uninstall ---
const b = await world("b")
await mkdir(join(b.cwd, ".claude"), { recursive: true })
const settingsB = join(b.cwd, ".claude", "settings.json")
const foreignEntry = { matcher: "Bash", hooks: [{ type: "command", command: "echo foreign" }] }
const foreignEnd = { hooks: [{ type: "command", command: "echo foreign-end" }] }
await writeFile(settingsB, JSON.stringify({ hooks: { PreToolUse: [foreignEntry], SessionEnd: [foreignEnd] } }, null, 2), "utf8")
run(["install", "--harness", "claude", "--project", "--yes"], b.cwd, b.home)
const sB1 = JSON.parse(await readFile(settingsB, "utf8")) as Settings
const preB1 = JSON.stringify(sB1.hooks?.PreToolUse ?? [])
check("install preserves the foreign hook entry", preB1.includes("echo foreign"))
check("install adds dejavu alongside foreign", preB1.includes("--harness claude"))
const endB1 = JSON.stringify(sB1.hooks?.SessionEnd ?? [])
check("install adds dejavu SessionEnd alongside the foreign one", endB1.includes("--harness claude") && endB1.includes("echo foreign-end"))

const un = run(["uninstall", "--harness", "claude", "--project", "--yes"], b.cwd, b.home)
check("uninstall exits 0", un.code === 0)
const sB2 = JSON.parse(await readFile(settingsB, "utf8")) as Settings
const preB2 = JSON.stringify(sB2.hooks?.PreToolUse ?? [])
check("uninstall strips dejavu entries", !preB2.includes("--harness claude"))
check("uninstall keeps the foreign entry", preB2.includes("echo foreign"))
const endB2 = JSON.stringify(sB2.hooks?.SessionEnd ?? [])
check("uninstall strips the dejavu SessionEnd entry", !endB2.includes("--harness claude"))
check("uninstall keeps the foreign SessionEnd hook", endB2.includes("echo foreign-end"))

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

// --- S11: install --harness copilot --project --dry-run includes postToolUseFailure ---
const g = await world("g")
const inst11 = run(["install", "--harness", "copilot", "--project", "--dry-run"], g.cwd, g.home)
check("install copilot --dry-run exits 0", inst11.code === 0)
check("install copilot --dry-run stdout contains postToolUseFailure", inst11.stdout.includes("postToolUseFailure"))
const inst11b = run(["install", "--harness", "codex", "--project", "--dry-run"], g.cwd, g.home)
check("install codex --dry-run matcher covers apply_patch", inst11b.code === 0 && inst11b.stdout.includes("apply_patch"))

// --- rootHooks normalizers: config root IS the event map (no "hooks" wrapper) ---
const rootEventEntries: unknown[] = [
  { matcher: "Bash", hooks: [{ type: "command", command: 'bun "x/src/cli.ts" --harness devin' }] },
  { matcher: "Read", hooks: [{ type: "command", command: "echo foreign" }] },
]
const strippedRoot = stripDejavu(rootEventEntries, "devin")
check("stripDejavu removes dejavu commands from root event array", strippedRoot.length === 1)
check("stripDejavu keeps the foreign entry", JSON.stringify(strippedRoot[0]).includes("echo foreign"))

const existingRoot: Json = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo foreign" }] }], customField: true }
const templateRoot: Json = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "cli.ts" --harness devin' }] }],
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "cli.ts" post --harness devin' }] }],
  },
}
const mergedRoot = mergeConfigRoot(existingRoot, templateRoot, "devin")
check("mergeConfigRoot preserves foreign events at root level", Array.isArray((mergedRoot as Json).PreToolUse))
check("mergeConfigRoot foreign entry survives", JSON.stringify(mergedRoot).includes("echo foreign"))
check("mergeConfigRoot dejavu entry added", JSON.stringify(mergedRoot).includes("--harness devin"))
check("mergeConfigRoot customField preserved", (mergedRoot as Json).customField === true)
check("mergeConfigRoot new event key added", Array.isArray((mergedRoot as Json).PostToolUse))

const rootConfig: Json = {
  PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: 'bun "cli.ts" pre --harness devin' }] },
    { matcher: "Read", hooks: [{ type: "command", command: "echo other" }] },
  ],
}
const rootCmds = collectCommandsRoot(rootConfig, (c) => typeof c === "string" && c.includes("--harness devin"))
check("collectCommandsRoot finds dejavu commands in root event arrays", rootCmds.length === 1)
check("collectCommandsRoot returns the correct command", rootCmds.at(0)?.includes("--harness devin") === true)

check("stripDejavu on non-array returns []", JSON.stringify(stripDejavu("not-array", "devin")) === "[]")
check("stripDejavu on null returns []", JSON.stringify(stripDejavu(null, "devin")) === "[]")

const standardExisting: Json = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo foreign" }] }] } }
const standardTemplate: Json = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "cli.ts" --harness claude' }] }] } }
const stdMerged = mergeConfig(standardExisting, standardTemplate, "claude")
check("mergeConfig standard: hooks key present", typeof (stdMerged as Json).hooks === "object")
check("mergeConfig standard: foreign hook preserved", JSON.stringify(stdMerged).includes("echo foreign"))
check("mergeConfig standard: dejavu hook added", JSON.stringify(stdMerged).includes("--harness claude"))

const objectExisting: Json = { hooks: { PreToolUse: { custom: "shape" } } }
const objMerged = mergeConfig(objectExisting, standardTemplate, "claude")
check(
  "mergeConfig keeps an object-shaped foreign event value",
  !Array.isArray((objMerged.hooks as Json).PreToolUse) && JSON.stringify((objMerged.hooks as Json).PreToolUse).includes("custom"),
)
const objectRootExisting: Json = { PreToolUse: { custom: "shape" } }
const objRootMerged = mergeConfigRoot(objectRootExisting, templateRoot, "devin")
check(
  "mergeConfigRoot keeps an object-shaped foreign root event value",
  !Array.isArray((objRootMerged as Json).PreToolUse) && JSON.stringify((objRootMerged as Json).PreToolUse).includes("custom"),
)
check("mergeConfigRoot still adds absent events", Array.isArray((objRootMerged as Json).PostToolUse))

// --- S12: devin root-hooks merge - config root IS the event map, foreign keys survive ---
const h12 = await world("h12")
await mkdir(join(h12.cwd, ".devin"), { recursive: true })
const devinTarget = join(h12.cwd, ".devin", "hooks.v1.json")
const devinForeign = { matcher: "exec", hooks: [{ type: "command", command: "echo foreign" }] }
await writeFile(devinTarget, JSON.stringify({ SessionStart: [devinForeign], customField: true }, null, 2), "utf8")
const inst12 = run(["install", "--harness", "devin", "--project", "--yes"], h12.cwd, h12.home)
check("install devin exits 0", inst12.code === 0)
check("install wrote .devin/hooks.v1.json", existsSync(devinTarget))
const dv12 = JSON.parse(await readFile(devinTarget, "utf8")) as Record<string, unknown>
check("devin root has PreToolUse + PostToolUse arrays", Array.isArray(dv12.PreToolUse) && Array.isArray(dv12.PostToolUse))
check("devin config has no hooks wrapper (root event map)", dv12.hooks === undefined)
check("devin PreToolUse carries the dejavu command", JSON.stringify(dv12.PreToolUse).includes("--harness devin"))
check("devin PostToolUse carries the dejavu command", JSON.stringify(dv12.PostToolUse).includes("--harness devin"))
check("devin foreign root event survives install", JSON.stringify(dv12.SessionStart).includes("echo foreign"))
check("devin custom root field survives install", dv12.customField === true)
const inst12b = run(["install", "--harness", "devin", "--project", "--yes"], h12.cwd, h12.home)
check("re-install devin exits 0", inst12b.code === 0)
const dv12b = JSON.parse(await readFile(devinTarget, "utf8")) as Record<string, unknown>
check("devin re-install idempotent (one dejavu PreToolUse entry)", (dv12b.PreToolUse as unknown[]).length === 1)
check("devin foreign root event survives re-install", JSON.stringify(dv12b.SessionStart).includes("echo foreign"))

// --- S13: devin uninstall strips dejavu entries, keeps the foreign root event ---
const un13 = run(["uninstall", "--harness", "devin", "--project", "--yes"], h12.cwd, h12.home)
check("uninstall devin exits 0", un13.code === 0)
check("devin file survives uninstall (entry semantics, not file removal)", existsSync(devinTarget))
const dv13 = JSON.parse(await readFile(devinTarget, "utf8")) as Record<string, unknown>
check("devin uninstall stripped the dejavu commands", !JSON.stringify(dv13).includes("--harness devin"))
check("devin uninstall kept the foreign root event", JSON.stringify(dv13.SessionStart).includes("echo foreign"))
check("devin uninstall dropped the emptied event arrays", dv13.PreToolUse === undefined && dv13.PostToolUse === undefined)

// --- S14: kiro standalone file - v1 schema with two hook entries ---
const h14 = await world("h14")
const inst14 = run(["install", "--harness", "kiro", "--project", "--yes"], h14.cwd, h14.home)
check("install kiro exits 0", inst14.code === 0)
const kiroTarget = join(h14.cwd, ".kiro", "hooks", "dejavu-gates.json")
check("install wrote .kiro/hooks/dejavu-gates.json", existsSync(kiroTarget))
const kiroCfg = JSON.parse(await readFile(kiroTarget, "utf8")) as { version?: string; hooks?: Array<{ trigger?: string; action?: { command?: string } }> }
check("kiro config version is v1", kiroCfg.version === "v1")
check("kiro hooks array has PreToolUse + PostToolUse entries", (kiroCfg.hooks ?? []).some((h) => h.trigger === "PreToolUse") && (kiroCfg.hooks ?? []).some((h) => h.trigger === "PostToolUse"))
check("kiro hook commands nest under action.command", JSON.stringify(kiroCfg.hooks).includes("--harness kiro"))

// --- S15: kiro uninstall removes the whole dejavu-owned file, foreign neighbor survives ---
const kiroNeighbor = join(h14.cwd, ".kiro", "hooks", "lint-on-save.json")
await writeFile(kiroNeighbor, JSON.stringify({ version: "v1", hooks: [] }, null, 2), "utf8")
const un15 = run(["uninstall", "--harness", "kiro", "--project", "--yes"], h14.cwd, h14.home)
check("uninstall kiro exits 0", un15.code === 0)
check("uninstall removed the dejavu kiro file entirely", !existsSync(kiroTarget))
check("uninstall kept the foreign kiro hook file", existsSync(kiroNeighbor))

// --- S16: hooks --check reports devin + kiro ok on an installed world ---
const h16 = await world("h16")
run(["install", "--harness", "devin", "--project", "--yes"], h16.cwd, h16.home)
run(["install", "--harness", "kiro", "--project", "--yes"], h16.cwd, h16.home)
const chk16 = run(["hooks", "--check"], h16.cwd, h16.home)
check("hooks --check on devin+kiro world exits 0", chk16.code === 0)
check("hooks --check reports devin ok", chk16.stderr.includes("devin: ok"))
check("hooks --check reports kiro ok", chk16.stderr.includes("kiro: ok"))

// --- S17: user scope rejected explicitly for project-only harnesses ---
const h17 = await world("h17")
const noUserKiro = run(["install", "--harness", "kiro", "--user", "--yes"], h17.cwd, h17.home)
check("install kiro --user exits 1", noUserKiro.code === 1)
check("install kiro --user prints the no-user-scope message", noUserKiro.stderr.includes("no user-scope install documented"))
const noUserDevin = run(["install", "--harness", "devin", "--user", "--yes"], h17.cwd, h17.home)
check("install devin --user exits 1", noUserDevin.code === 1)
check("install devin --user prints the no-user-scope message", noUserDevin.stderr.includes("no user-scope install documented"))
const checkUserKiro = run(["hooks", "--check", "--harness", "kiro", "--user"], h17.cwd, h17.home)
check("hooks --check kiro --user exits 1 with the scope message", checkUserKiro.code === 1 && checkUserKiro.stderr.includes("no user-scope install documented"))

// --- optional user scope: harnesses with a documented user scope keep their user paths ---
const PROJECT_ONLY: readonly Harness[] = ["devin", "kiro"]
for (const [name, spec] of Object.entries(HARNESSES)) {
  if (PROJECT_ONLY.includes(name as Harness)) {
    check(`${name} has no user-scope path (project-only)`, spec.user === undefined)
  } else {
    check(`existing harness ${name as Harness} has a user path`, typeof spec.user === "string" && spec.user !== "")
  }
}
check("targetPath for claude user-scope resolves", typeof targetPath("claude", true) === "string")

// --- S18: report subcommand passes doctor's output and exit code through ---
const h18 = await world("h18")
const seed18 = (session: string): string =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: session,
    tool_name: "Bash",
    tool_input: { command: "boom-tool --prod" },
    tool_use_id: `tu-${session}`,
    cwd: h18.cwd,
    tool_response: { stdout: "", stderr: "boom-tool: command not found" },
  })
run(["post", "--harness", "claude", "--store", h18.cwd], h18.cwd, h18.home, seed18("sA"))
run(["post", "--harness", "claude", "--store", h18.cwd], h18.cwd, h18.home, seed18("sA"))
run(["post", "--harness", "claude", "--store", h18.cwd], h18.cwd, h18.home, seed18("sB"))
check("seeding created the project gate store", existsSync(join(h18.cwd, ".opencode", "dejavu", "gates.json")))

const viaReport = run(["report", h18.cwd], h18.cwd, h18.home)
const doctorDirect = spawnSync("bun", [join(repoRoot, "scripts", "doctor.ts"), h18.cwd], {
  cwd: h18.cwd,
  env: { ...process.env, USERPROFILE: h18.home, HOME: h18.home },
  encoding: "utf8",
})
const directGatesLine = (doctorDirect.stdout ?? "").split("\n").find((l) => l.includes("gates:"))
check("report exits with doctor's exit code", viaReport.code === (doctorDirect.status ?? -1))
check("report stdout carries doctor's gates summary line", directGatesLine !== undefined && viaReport.stdout.includes(directGatesLine))

const reportAll = run(["report"], h18.cwd, h18.home)
check("report with no dirs exits 0 or 1", reportAll.code === 0 || reportAll.code === 1)
check("report with no dirs leaves stderr free of stack traces", !reportAll.stderr.includes("TypeError"))

// --- S19: bundled hooks/ and installer templates/ stay in event parity ---
const HOOK_PAIRS: Array<{ name: string; bundled: string; template: string }> = [
  { name: "claude", bundled: join(repoRoot, "hooks", "claude.json"), template: join(repoRoot, "scripts", "templates", "claude.json") },
  { name: "cursor", bundled: join(repoRoot, "hooks", "cursor.json"), template: join(repoRoot, "scripts", "templates", "cursor.json") },
  { name: "gemini", bundled: join(repoRoot, "hooks", "hooks.json"), template: join(repoRoot, "scripts", "templates", "gemini.json") },
]
for (const pair of HOOK_PAIRS) {
  const bundled = JSON.parse(await readFile(pair.bundled, "utf8")) as { hooks?: Record<string, unknown> }
  const template = JSON.parse(await readFile(pair.template, "utf8")) as { hooks?: Record<string, unknown> }
  const events = Object.keys(bundled.hooks ?? {}).sort()
  check(`bundled hooks and installer template share events (${pair.name})`, events.length > 0 && events.join(",") === Object.keys(template.hooks ?? {}).sort().join(","))
}

// --- S20: object-shaped foreign event value survives install (never clobbered by the template array) ---
const h20 = await world("h20")
await mkdir(join(h20.cwd, ".claude"), { recursive: true })
const settings20 = join(h20.cwd, ".claude", "settings.json")
await writeFile(settings20, JSON.stringify({ hooks: { PreToolUse: { custom: "shape" } } }, null, 2), "utf8")
const inst20 = run(["install", "--harness", "claude", "--project", "--yes"], h20.cwd, h20.home)
check("install with an object-shaped foreign event exits 0", inst20.code === 0)
const s20 = JSON.parse(await readFile(settings20, "utf8")) as Settings
check(
  "object-shaped foreign event value survives install",
  !Array.isArray(s20.hooks?.PreToolUse) && JSON.stringify(s20.hooks?.PreToolUse).includes("custom"),
)
check("absent events still get the dejavu entries", Array.isArray(s20.hooks?.SessionEnd) && (s20.hooks?.SessionEnd ?? []).length === 1)

// --- S21: merge:false harness aborts on an unparseable existing config (file untouched) ---
const h21 = await world("h21")
await mkdir(join(h21.cwd, ".kiro", "hooks"), { recursive: true })
const kiro21 = join(h21.cwd, ".kiro", "hooks", "dejavu-gates.json")
await writeFile(kiro21, "{ not json", "utf8")
const inst21 = run(["install", "--harness", "kiro", "--project", "--yes"], h21.cwd, h21.home)
check("install kiro over an unparseable file exits 1", inst21.code === 1)
check("install kiro over an unparseable file reports the abort", inst21.stderr.includes("not valid JSON"))
check("the unparseable file is left untouched", (await readFile(kiro21, "utf8")) === "{ not json")

// --- S22: multi-harness install pre-validates every target before the first write ---
const h22 = await world("h22")
await mkdir(join(h22.cwd, ".claude"), { recursive: true })
await mkdir(join(h22.cwd, ".kiro", "hooks"), { recursive: true })
await writeFile(join(h22.cwd, ".kiro", "hooks", "dejavu-gates.json"), "{ not json", "utf8")
const inst22 = run(["install", "--harness", "claude,kiro", "--project", "--yes"], h22.cwd, h22.home)
check("multi-harness install with a later unparseable target exits 1", inst22.code === 1)
check("no config was written before the abort", !existsSync(join(h22.cwd, ".claude", "settings.json")))

report()
