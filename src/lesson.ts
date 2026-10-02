/**
 * `dejavu lesson` — the user-facing gate surface: list enforced gates, show
 * one gate's evidence, set a human correction. Reads are read-only loads;
 * the only write is the correction edit, under the store lock.
 */
import { join } from "node:path"
import { sanitizeForStore } from "./patterns"
import { createStores, lessonStaleness, type Gate, type GateStore, type RetireWhen, type Stores } from "./store"
import { isAutoCorrection, sliceSafe, SNIPPET_MAX } from "./validate"

const KEY_SHAPE = /^[0-9a-f]{12}$/

const USAGE = `usage: dejavu lesson [--store <dir>] [--all] <command> [args]
  list                    enforced gates, highest count first
  show <key>              one gate's evidence and correction
  set <key> <text...>     write a human correction (sanitized, capped at ${SNIPPET_MAX} chars)
  retire-when <key> <spec>   set a retirement condition: dep:<name>@>=<min> | path-present:<path> | path-absent:<path> | tag:<name>
  retire-when <key> --clear  remove the retirement condition
  --store <dir>           project dir to read (default: cwd); must precede <command>
  --all                   list watching gates too, marked enforced=no; must precede <command>`

function scopes(stores: Stores): GateStore[] {
  return stores.projectStore !== null ? [stores.projectStore, stores.globalStore] : [stores.globalStore]
}

async function locateGate(stores: Stores, key: string): Promise<{ gate: Gate; store: GateStore } | null> {
  for (const store of scopes(stores)) {
    await store.load()
    const gate = store.byKey(key)
    if (gate !== undefined) return { gate, store }
  }
  return null
}

function parseRetireSpec(spec: string): RetireWhen | undefined {
  if (spec.startsWith("dep:")) {
    const body = spec.slice("dep:".length)
    const at = body.lastIndexOf("@")
    if (at < 1) return undefined
    const name = sanitizeForStore(body.slice(0, at))
    let min = body.slice(at + 1)
    if (min.startsWith(">=")) min = min.slice(2)
    min = sanitizeForStore(min)
    if (name === "" || min === "") return undefined
    return { kind: "dep", name, min }
  }
  if (spec.startsWith("path-present:")) {
    const path = sanitizeForStore(spec.slice("path-present:".length))
    if (path === "") return undefined
    return { kind: "path", mode: "present", path }
  }
  if (spec.startsWith("path-absent:")) {
    const path = sanitizeForStore(spec.slice("path-absent:".length))
    if (path === "") return undefined
    return { kind: "path", mode: "absent", path }
  }
  if (spec.startsWith("tag:")) {
    const tag = sanitizeForStore(spec.slice("tag:".length))
    if (tag === "") return undefined
    return { kind: "tag", tag }
  }
  return undefined
}

function retireSpec(cond: RetireWhen): string {
  if (cond.kind === "dep") return `dep:${cond.name}@>=${cond.min}`
  if (cond.kind === "path") return cond.mode === "present" ? `path-present:${cond.path}` : `path-absent:${cond.path}`
  return `tag:${cond.tag}`
}

async function runList(projectDir: string, args: readonly string[], all: boolean): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`error: list takes no arguments\n${USAGE}\n`)
    return 1
  }
  const stores = createStores(projectDir)
  // a key can sit in both scopes until migrate heals the duplicate — list it once, project copy first
  const seen = new Set<string>()
  const rows: { gate: Gate; scope: string }[] = []
  for (const store of scopes(stores)) {
    const scope = store === stores.projectStore ? "project" : "global"
    for (const gate of await store.load()) {
      if ((!all && gate.status === "watching") || seen.has(gate.key)) continue
      seen.add(gate.key)
      rows.push({ gate, scope })
    }
  }
  rows.sort((a, b) => b.gate.count - a.gate.count)
  for (const { gate, scope } of rows) {
    const correction = gate.correction === undefined ? "none" : isAutoCorrection(gate) ? "machine" : "human"
    const enforced = gate.status === "watching" ? "  enforced=no" : ""
    const verdict = lessonStaleness(gate, Date.now())
    const stale = verdict !== "fresh" ? `  stale=${verdict}` : ""
    process.stdout.write(`${gate.key}  ${gate.status}  count=${gate.count}  sessions=${gate.sessions.length}  correction=${correction}  scope=${scope}${enforced}${stale}  ${gate.signature}\n`)
  }
  return 0
}

async function runShow(projectDir: string, args: readonly string[]): Promise<number> {
  const key = args[0]
  if (key === undefined || !KEY_SHAPE.test(key)) {
    process.stderr.write(`error: show requires a 12-hex gate key\n${USAGE}\n`)
    return 1
  }
  if (args.length > 1) {
    process.stderr.write(`error: show takes exactly one gate key\n${USAGE}\n`)
    return 1
  }
  const found = await locateGate(createStores(projectDir), key)
  if (found === null) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  const { gate, store } = found
  const correction = gate.correction === undefined ? "(none)" : isAutoCorrection(gate) ? "(machine default)" : gate.correction
  process.stdout.write(`${gate.key}  ${gate.status}  ${gate.tool}\n`)
  process.stdout.write(`signature: ${gate.signature}\n`)
  process.stdout.write(`evidence: ${gate.count} failures across ${gate.sessions.length} sessions, first seen ${gate.firstSeen.slice(0, 10)}, recurred-after-gate ${gate.recurredAfterGate}\n`)
  process.stdout.write(`snippet: ${gate.snippet}\n`)
  process.stdout.write(`correction: ${correction}\n`)
  process.stdout.write(`lesson: ${lessonStaleness(gate, Date.now())}\n`)
  if (gate.retireWhen !== undefined) process.stdout.write(`retire-when: ${retireSpec(gate.retireWhen)}\n`)
  process.stdout.write(`store: ${store.dir}\n`)
  return 0
}

async function runSet(projectDir: string, args: readonly string[]): Promise<number> {
  const key = args[0]
  if (key === undefined || !KEY_SHAPE.test(key)) {
    process.stderr.write(`error: set requires a 12-hex gate key\n${USAGE}\n`)
    return 1
  }
  const text = args.slice(1).join(" ")
  if (text === "") {
    process.stderr.write(`error: set requires correction text\n${USAGE}\n`)
    return 1
  }
  if (/(^|\s)--store(?=[\s=]|$)/.test(text)) {
    process.stderr.write(`[dejavu] note: --store must precede the subcommand — a --store token inside the correction text is stored verbatim\n`)
  }
  const stores = createStores(projectDir)
  const owners: GateStore[] = []
  let display: { tool: string; signature: string; enforced: boolean } | null = null
  for (const store of scopes(stores)) {
    await store.load()
    const gate = store.byKey(key)
    if (gate !== undefined) {
      owners.push(store)
      if (display === null) {
        display = { tool: gate.tool, signature: gate.signature, enforced: gate.status !== "watching" && gate.feedbackDemoted !== true }
      }
    }
  }
  if (owners.length === 0 || display === null) {
    process.stderr.write(`[dejavu] no gate with key ${key} — promotion is mechanical (3 failures across 2 sessions). See \`dejavu report\` for near-promotion candidates.\n`)
    return 1
  }
  if (!display.enforced) {
    process.stderr.write(`[dejavu] warning: gate ${key} is not currently enforced — the correction will only show if/when the gate is enforced\n`)
  }
  let clean = sanitizeForStore(text)
  if (clean.length > SNIPPET_MAX) {
    process.stderr.write(`[dejavu] warning: correction exceeds ${SNIPPET_MAX} chars — truncated\n`)
    clean = sliceSafe(clean, SNIPPET_MAX)
  }
  // a duplicate key in the other scope must not keep teaching the old text — write every copy
  const written: GateStore[] = []
  let before: string | undefined | null = null
  for (const store of owners) {
    const previous = await store.runLocked(async (): Promise<string | undefined | null> => {
      const gates = await store.loadForMutation()
      const gate = gates.find((g) => g.key === key)
      if (gate === undefined) return null
      const prior = gate.correction
      gate.correction = clean
      gate.correctionOrigin = "human"
      gate.correctionAt = Date.now()
      gate.correctionBaseline = {
        recurred: gate.recurredAfterGate,
        reminded: gate.remindedCount,
        overrides: gate.overrideCount,
        ...(gate.promotionCount !== undefined ? { promoted: gate.promotionCount } : {}),
      }
      await store.save()
      return prior
    })
    if (previous === null) continue
    if (before === null) before = previous
    written.push(store)
  }
  if (written.length === 0) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  await stores.logAll({ type: "corrected", key, tool: display.tool, project: projectDir })
  process.stdout.write(`[dejavu] correction written to gate ${key} (${display.tool}: ${display.signature})\n`)
  process.stdout.write(`  before: ${before ?? "(none)"}\n`)
  process.stdout.write(`  after:  ${clean}\n`)
  for (const store of written) {
    process.stdout.write(`  stored: ${join(store.dir, "gates.json")}\n`)
  }
  return 0
}

async function runRetireWhen(projectDir: string, args: readonly string[]): Promise<number> {
  const key = args[0]
  if (key === undefined || !KEY_SHAPE.test(key)) {
    process.stderr.write(`error: retire-when requires a 12-hex gate key\n${USAGE}\n`)
    return 1
  }
  if (args.length !== 2) {
    process.stderr.write(`error: retire-when takes exactly one spec (or --clear)\n${USAGE}\n`)
    return 1
  }
  const specArg = args[1] ?? ""
  const clear = specArg === "--clear"
  const next = clear ? undefined : parseRetireSpec(specArg)
  if (next === undefined && !clear) {
    process.stderr.write(`error: unknown retire-when spec "${specArg}"\n${USAGE}\n`)
    return 1
  }
  const stores = createStores(projectDir)
  const owners: GateStore[] = []
  let display: { tool: string; signature: string } | null = null
  for (const store of scopes(stores)) {
    await store.load()
    const gate = store.byKey(key)
    if (gate !== undefined) {
      owners.push(store)
      if (display === null) display = { tool: gate.tool, signature: gate.signature }
    }
  }
  if (owners.length === 0 || display === null) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  // a duplicate key in the other scope must not keep enforcing the old condition — write every copy
  const written: GateStore[] = []
  for (const store of owners) {
    const ok = await store.runLocked(async (): Promise<boolean> => {
      const gates = await store.loadForMutation()
      const gate = gates.find((g) => g.key === key)
      if (gate === undefined) return false
      if (next === undefined) delete gate.retireWhen
      else gate.retireWhen = next
      await store.save()
      return true
    })
    if (ok) written.push(store)
  }
  if (written.length === 0) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  process.stdout.write(`[dejavu] retire-when ${clear ? "cleared" : "set"} on gate ${key} (${display.tool}: ${display.signature})\n`)
  if (next !== undefined) process.stdout.write(`  condition: ${retireSpec(next)}\n`)
  for (const store of written) {
    process.stdout.write(`  stored: ${join(store.dir, "gates.json")}\n`)
  }
  return 0
}

export async function runLesson(argv: readonly string[]): Promise<number> {
  // flags only before the subcommand: correction text may contain "--store" or "--all" verbatim
  let storeDir: string | null = null
  let all = false
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined) break
    if (arg === "--") {
      i += 1
      break
    }
    if (arg === "--store") {
      const value = argv[i + 1]
      if (value === undefined || value === "") {
        process.stderr.write(`error: --store requires a directory\n${USAGE}\n`)
        return 1
      }
      storeDir = value
      i += 2
      continue
    }
    if (arg.startsWith("--store=")) {
      const value = arg.slice("--store=".length)
      if (value === "") {
        process.stderr.write(`error: --store requires a directory\n${USAGE}\n`)
        return 1
      }
      storeDir = value
      i += 1
      continue
    }
    if (arg === "--all") {
      all = true
      i += 1
      continue
    }
    break
  }
  const projectDir = storeDir ?? process.cwd()
  const [sub, ...args] = argv.slice(i)
  if (sub === "list") return runList(projectDir, args, all)
  if (sub === "show") return runShow(projectDir, args)
  if (sub === "set") return runSet(projectDir, args)
  if (sub === "retire-when") return runRetireWhen(projectDir, args)
  process.stderr.write(`${USAGE}\n`)
  return 1
}
