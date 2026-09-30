/**
 * Read-only summary of dejavu stores: statuses, tools, recurrence health,
 * top patterns.
 *
 * Usage: bun scripts/analyze.ts [projectDir ...]
 *   without arguments, project stores are discovered from the global index
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEMOTE_OVERRIDES, DEMOTE_RECURRENCES, GateStore, resolveGlobalDir, type Gate } from "../src/store"

const globalDir = resolveGlobalDir()
const onlyRecurrence = process.argv.includes("--recurrence")
let projectArgs = process.argv.slice(2).filter((a) => a !== "--recurrence")
if (projectArgs.length === 0) {
  const discovered = new Set<string>()
  const index = await new GateStore(globalDir).loadIndex()
  for (const entry of Object.values(index.keys)) {
    if (!entry || !Array.isArray(entry.projects)) continue
    for (const project of entry.projects) {
      if (typeof project === "string" && existsSync(join(project, ".opencode", "dejavu"))) discovered.add(project)
    }
  }
  projectArgs = [...discovered].sort()
}
const dirs = [globalDir, ...projectArgs.map((p) => join(p, ".opencode", "dejavu"))]

type RecurrenceVerdict = "TEACHING" | "WORKING" | "FRICTION" | "RETIRED"

const VERDICT_RANK: Record<RecurrenceVerdict, number> = { FRICTION: 0, WORKING: 1, TEACHING: 2, RETIRED: 3 }

/** enforced now, or carrying retirement/demotion evidence — a watching gate that never promoted is not a gate yet */
function wasOrIsEnforced(gate: Gate): boolean {
  return gate.status !== "watching" || gate.retireBaseline !== undefined || gate.feedbackDemoted === true || (gate.promotionCount ?? 0) > 0
}

function recurrenceVerdict(gate: Gate): RecurrenceVerdict {
  if (gate.status === "watching") return gate.feedbackDemoted === true ? "FRICTION" : "RETIRED"
  // a human re-enforcement gets a fresh grace window: only recurrences/overrides since the baseline vote
  const base = gate.feedbackBaseline
  const recurred = gate.recurredAfterGate - (base?.recurred ?? 0)
  const overridden = gate.overrideCount - (base?.overrides ?? 0)
  if (recurred >= DEMOTE_RECURRENCES || overridden >= DEMOTE_OVERRIDES) return "FRICTION"
  return recurred === 0 ? "TEACHING" : "WORKING"
}

function recurrenceState(gate: Gate): string {
  if (gate.feedbackDemoted === true) return "demoted"
  if ((gate.succeededAfterGate ?? 0) > 0) return `healing:${gate.succeededAfterGate}`
  if (gate.retireBaseline !== undefined) return "retired"
  return "-"
}

function renderRecurrence(gates: Gate[]): void {
  const enforced = gates.filter(wasOrIsEnforced)
  if (enforced.length === 0) {
    console.log("   recurrence: (no enforced gates yet)")
    return
  }
  const sorted = [...enforced].sort(
    (a, b) =>
      VERDICT_RANK[recurrenceVerdict(a)] - VERDICT_RANK[recurrenceVerdict(b)] ||
      b.recurredAfterGate - a.recurredAfterGate ||
      b.count - a.count,
  )
  console.log("   recurrence report:")
  for (const g of sorted) {
    const chain = Object.keys(g.remindedSessions ?? {}).length
    const signature = g.signature.length > 80 ? `${g.signature.slice(0, 77)}...` : g.signature
    console.log(
      `     ${recurrenceVerdict(g).padEnd(8)} ${g.status.padEnd(9)} count ${String(g.count).padStart(4)} recurred ${String(g.recurredAfterGate).padStart(3)} healed ${String(g.succeededAfterGate ?? 0).padStart(2)} chain ${String(chain).padStart(2)} ${recurrenceState(g).padEnd(10)} ${signature}`,
    )
  }
  const counts: Record<RecurrenceVerdict, number> = { TEACHING: 0, WORKING: 0, FRICTION: 0, RETIRED: 0 }
  for (const g of enforced) counts[recurrenceVerdict(g)] += 1
  const ratio = Math.round((counts.TEACHING / enforced.length) * 100)
  console.log(
    `     aggregate: ${enforced.length} gates | teaching ${counts.TEACHING} | working ${counts.WORKING} | friction ${counts.FRICTION} | retired ${counts.RETIRED} | teaching-ratio ${ratio}%`,
  )
}

for (const dir of dirs) {
  const store = new GateStore(dir)
  const gates = await store.load()
  console.log(`\n== ${dir}`)
  if (!onlyRecurrence) {
    // --- repeat channel (log events) ---
    try {
      const logRaw = readFileSync(join(dir, "log.jsonl"), "utf8")
      const counts: Record<string, number> = {}
      for (const line of logRaw.split("\n")) {
        if (line.trim() === "") continue
        let evt: { type?: string; repeatCount?: unknown }
        try { evt = JSON.parse(line) } catch { continue }
        if (typeof evt.type !== "string") continue
        if (evt.type.startsWith("repeat-")) {
          const sub = evt.type.slice("repeat-".length)
          counts[sub] = (counts[sub] ?? 0) + 1
        } else if (evt.type === "override" && typeof evt.repeatCount !== "undefined") {
          counts.override = (counts.override ?? 0) + 1
        }
      }
      const keys = Object.keys(counts)
      if (keys.length > 0) {
        const parts = keys.map((k) => `${k} ${counts[k]}`)
        console.log(`   repeat: ${parts.join(" | ")}`)
      }
    } catch {
      // missing log.jsonl — skip silently
    }
  }
  if (gates.length === 0) {
    console.log("   (empty)")
    continue
  }
  if (!onlyRecurrence) {
    const blocking = gates.filter((g) => g.status === "blocking")
    const reminding = gates.filter((g) => g.status === "reminding")
    const watching = gates.filter((g) => g.status === "watching")
    const feedbackDemoted = gates.filter((g) => g.feedbackDemoted === true)
    const byTool = new Map<string, number>()
    for (const g of gates) byTool.set(g.tool, (byTool.get(g.tool) ?? 0) + 1)
    console.log(
      `   total ${gates.length} | blocking ${blocking.length} | reminding ${reminding.length} | watching ${watching.length}${feedbackDemoted.length > 0 ? ` | feedback-demoted ${feedbackDemoted.length}` : ""} | tools: ${[...byTool.entries()].map(([t, n]) => `${t}:${n}`).join(" ")}`,
    )
  }

  renderRecurrence(gates)

  if (!onlyRecurrence) {
    const top = [...gates].sort((a, b) => b.count - a.count).slice(0, 8)
    console.log("   top by count:")
    for (const g of top) {
      console.log(`     - ${g.count}x / ${g.sessions.length} sess [${g.status}] ${g.signature}`)
    }
  }
}
