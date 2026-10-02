/**
 * `dejavu lesson` — the user-facing gate surface: list enforced gates, show
 * one gate's evidence, set a human correction. Reads are read-only loads;
 * the only write is the correction edit, under the store lock.
 */
import { join } from "node:path"
import { sanitizeForStore } from "./patterns"
import { createStores, type Gate, type GateStore, type Stores } from "./store"
import { isAutoCorrection, SNIPPET_MAX } from "./validate"

const KEY_SHAPE = /^[0-9a-f]{12}$/

const USAGE = `usage: dejavu lesson <command> [args] [--store <dir>]
  list                    enforced gates, highest count first
  show <key>              one gate's evidence and correction
  set <key> <text...>     write a human correction (sanitized, capped at ${SNIPPET_MAX} chars)
  --store <dir>           project dir to read (default: cwd)`

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

async function runList(projectDir: string): Promise<number> {
  const stores = createStores(projectDir)
  const enforced: Gate[] = []
  for (const store of scopes(stores)) {
    for (const gate of await store.load()) {
      if (gate.status !== "watching") enforced.push(gate)
    }
  }
  enforced.sort((a, b) => b.count - a.count)
  for (const gate of enforced) {
    const correction = gate.correction === undefined ? "none" : isAutoCorrection(gate.correction) ? "machine" : "human"
    process.stdout.write(`${gate.key}  ${gate.status}  count=${gate.count}  sessions=${gate.sessions.length}  correction=${correction}  ${gate.signature}\n`)
  }
  return 0
}

async function runShow(projectDir: string, args: readonly string[]): Promise<number> {
  const key = args[0]
  if (key === undefined || !KEY_SHAPE.test(key)) {
    process.stderr.write(`error: show requires a 12-hex gate key\n${USAGE}\n`)
    return 1
  }
  const found = await locateGate(createStores(projectDir), key)
  if (found === null) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  const { gate, store } = found
  const correction = gate.correction === undefined ? "(none)" : isAutoCorrection(gate.correction) ? "(machine default)" : gate.correction
  process.stdout.write(`${gate.key}  ${gate.status}  ${gate.tool}\n`)
  process.stdout.write(`signature: ${gate.signature}\n`)
  process.stdout.write(`evidence: ${gate.count} failures across ${gate.sessions.length} sessions, first seen ${gate.firstSeen.slice(0, 10)}, recurred-after-gate ${gate.recurredAfterGate}\n`)
  process.stdout.write(`snippet: ${gate.snippet}\n`)
  process.stdout.write(`correction: ${correction}\n`)
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
  let clean = sanitizeForStore(text)
  if (clean.length > SNIPPET_MAX) {
    process.stderr.write(`[dejavu] warning: correction exceeds ${SNIPPET_MAX} chars — truncated\n`)
    clean = clean.slice(0, SNIPPET_MAX)
  }
  const found = await locateGate(createStores(projectDir), key)
  if (found === null) {
    process.stderr.write(`[dejavu] no gate with key ${key} — promotion is mechanical (3 failures across 2 sessions). See \`dejavu report\` for near-promotion candidates.\n`)
    return 1
  }
  const store = found.store
  const before = await store.runLocked(async (): Promise<string | undefined | null> => {
    const gates = await store.loadForMutation()
    const gate = gates.find((g) => g.key === key)
    if (gate === undefined) return null
    const previous = gate.correction
    gate.correction = clean
    await store.save()
    return previous
  })
  if (before === null) {
    process.stderr.write(`[dejavu] no gate with key ${key}\n`)
    return 1
  }
  process.stdout.write(`[dejavu] correction written to gate ${key} (${found.gate.tool}: ${found.gate.signature})\n`)
  process.stdout.write(`  before: ${before ?? "(none)"}\n`)
  process.stdout.write(`  after:  ${clean}\n`)
  process.stdout.write(`  stored: ${join(store.dir, "gates.json")}\n`)
  return 0
}

export async function runLesson(argv: readonly string[]): Promise<number> {
  let storeDir: string | null = null
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) break
    if (arg === "--store") {
      const value = argv[i + 1]
      if (value === undefined) {
        process.stderr.write(`error: --store requires a directory\n${USAGE}\n`)
        return 1
      }
      storeDir = value
      i += 1
      continue
    }
    if (arg.startsWith("--store=")) {
      storeDir = arg.slice("--store=".length)
      continue
    }
    positional.push(arg)
  }
  const projectDir = storeDir ?? process.cwd()
  const [sub, ...args] = positional
  if (sub === "list") return runList(projectDir)
  if (sub === "show") return runShow(projectDir, args)
  if (sub === "set") return runSet(projectDir, args)
  process.stderr.write(`${USAGE}\n`)
  return 1
}
