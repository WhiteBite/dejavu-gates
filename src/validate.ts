/**
 * Invariant layer: strict parsing and repair of persisted gate state.
 * Pure functions — no I/O. Used at the persistence boundary (store reconcile)
 * and by diagnostics (doctor). Parse, don't validate: what survives
 * coerceGateShape + repairGate satisfies the data-model invariants.
 */
import type { Gate, RetireWhen } from "./store"
import { canBlock, canRemind, looksLikeSuccess, patternKey, sanitizeForStore, suggestCorrection } from "./patterns"

/** sha1 prefix-12, the only key shape patternKey ever emits */
const KEY_SHAPE = /^[0-9a-f]{12}$/
/** detection truncates snippets at 200 chars on ingest */
export const SNIPPET_MAX = 200
/** per-session enforcement state rots after a day — sessions do not live longer */
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000
/** bound per-gate session state so long-lived gates cannot bloat */
const SESSION_STATE_CAP = 50
/** fixed machine template shape — a byte-equal match around the quoted snippet is machine-generated, never a human edit */
const AUTO_TEMPLATE_CORRECTION = /^Last error: "(.*)" [—-] address that specific error before retrying this exact call\.$/
/** fixed machine generic shape — a prefix match over both stale generations (em-dash or hyphen), never owner prose */
const GENERIC_TEMPLATE_CORRECTION = /^This exact call keeps failing [—-]/

/** Truncate at a UTF-16 code-unit boundary without splitting a surrogate pair:
 * ending on a lone high surrogate would persist invalid JSON escapes. */
export function sliceSafe(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    const next = text.charCodeAt(max)
    if (next >= 0xdc00 && next <= 0xdfff) return text.slice(0, max - 1)
  }
  return text.slice(0, max)
}

/** True when the correction is machine-made: absent, origin-tagged machine, or
 * (legacy records with no origin) byte-equal to any platform's derivation —
 * anything else is authored (agent or owner). */
export function isAutoCorrection(gate: Gate): boolean {
  if (gate.correction === undefined) return true
  if (gate.correctionOrigin === "machine") return true
  if (gate.correctionOrigin === "agent" || gate.correctionOrigin === "owner") return false
  return (
    gate.correction === suggestCorrection(gate.signature, gate.snippet, "win32") ||
    gate.correction === suggestCorrection(gate.signature, gate.snippet, "linux")
  )
}

/** Fail time (ms) of a failedSessions entry regardless of shape — legacy bare
 * number or the { t, v } form that carries the workspace version at fail time. */
export function failedAtMs(entry: number | { t: number; v: number }): number {
  return typeof entry === "number" ? entry : entry.t
}

/**
 * Structural parse of one persisted gate object. Returns a well-shaped Gate
 * or null when the record is hopeless (missing identity fields, unknown
 * status) — hopeless records are dropped, not guessed at.
 */
export function coerceGateShape(raw: unknown): Gate | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.key !== "string" || !KEY_SHAPE.test(r.key)) return null
  if (typeof r.signature !== "string" || r.signature.trim() === "") return null
  if (typeof r.tool !== "string" || r.tool.trim() === "") return null
  if (r.status !== "watching" && r.status !== "reminding" && r.status !== "blocking") return null

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback)
  // Unparseable dates would make a gate immortal (expire() compares
  // Date.parse(...) < cutoff; NaN never is) — reset them instead.
  const dateStr = (v: unknown, fallback: string): string =>
    typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : fallback
  const now = new Date().toISOString()

  const gate: Gate = {
    key: r.key,
    signature: r.signature,
    tool: r.tool,
    status: r.status,
    count: num(r.count, 0),
    sessions: strings(r.sessions),
    projects: strings(r.projects),
    firstSeen: dateStr(r.firstSeen, now),
    lastSeen: dateStr(r.lastSeen, now),
    snippet: str(r.snippet, ""),
    remindedCount: num(r.remindedCount, 0),
    blockedCount: num(r.blockedCount, 0),
    recurredAfterReminder: num(r.recurredAfterReminder, 0),
    recurredAfterGate: num(r.recurredAfterGate, 0),
    overrideCount: num(r.overrideCount, 0),
  }
  if (typeof r.succeededAfterGate === "number" && Number.isFinite(r.succeededAfterGate) && r.succeededAfterGate >= 0) {
    gate.succeededAfterGate = Math.floor(r.succeededAfterGate)
  }
  if (typeof r.promotionCount === "number" && Number.isFinite(r.promotionCount) && r.promotionCount > 0) {
    gate.promotionCount = Math.floor(r.promotionCount)
  }
  if (typeof r.iteratedVersion === "number" && Number.isFinite(r.iteratedVersion) && r.iteratedVersion >= 0) {
    gate.iteratedVersion = Math.floor(r.iteratedVersion)
  }
  if (typeof r.movedOn === "number" && Number.isFinite(r.movedOn) && r.movedOn > 0) {
    gate.movedOn = Math.floor(r.movedOn)
  }
  if (typeof r.correction === "string") gate.correction = r.correction
  if (r.correctionOrigin === "machine" || r.correctionOrigin === "agent" || r.correctionOrigin === "owner") {
    gate.correctionOrigin = r.correctionOrigin
  } else if (r.correctionOrigin === "human") {
    gate.correctionOrigin = "owner"
  } else if (typeof r.correctionOrigin === "string") {
    // an unknown origin value must never fall into machine re-derivation — agent is the safe side
    gate.correctionOrigin = "agent"
  }
  if (typeof r.correctionAt === "number" && Number.isFinite(r.correctionAt) && r.correctionAt >= 0) {
    gate.correctionAt = Math.floor(r.correctionAt)
  }
  if (r.correctionBaseline !== null && typeof r.correctionBaseline === "object" && !Array.isArray(r.correctionBaseline)) {
    const b = r.correctionBaseline as Record<string, unknown>
    const recurred = typeof b.recurred === "number" && Number.isFinite(b.recurred) && b.recurred >= 0 ? Math.floor(b.recurred) : null
    const reminded = typeof b.reminded === "number" && Number.isFinite(b.reminded) && b.reminded >= 0 ? Math.floor(b.reminded) : null
    const overrides = typeof b.overrides === "number" && Number.isFinite(b.overrides) && b.overrides >= 0 ? Math.floor(b.overrides) : null
    if (recurred !== null && reminded !== null && overrides !== null) {
      gate.correctionBaseline = { recurred, reminded, overrides }
      if (typeof b.promoted === "number" && Number.isFinite(b.promoted) && b.promoted >= 0) {
        gate.correctionBaseline.promoted = Math.floor(b.promoted)
      }
    }
  }
  if (typeof r.correctionsProven === "number" && Number.isFinite(r.correctionsProven) && r.correctionsProven >= 0) {
    gate.correctionsProven = Math.floor(r.correctionsProven)
  }
  if (r.review === true) gate.review = true
  if (r.feedbackDemoted === true) gate.feedbackDemoted = true
  if (r.textOnly === true) gate.textOnly = true
  if (Array.isArray(r.reoffenseSessions)) {
    const sessions = r.reoffenseSessions.filter((x): x is string => typeof x === "string")
    if (sessions.length > 0) gate.reoffenseSessions = sessions.slice(-SESSION_STATE_CAP)
  }
  if (Array.isArray(r.overrideSessions)) {
    const sessions = r.overrideSessions.filter((x): x is string => typeof x === "string")
    if (sessions.length > 0) gate.overrideSessions = sessions.slice(-SESSION_STATE_CAP)
  }
  if (r.feedbackBaseline !== null && typeof r.feedbackBaseline === "object" && !Array.isArray(r.feedbackBaseline)) {
    const b = r.feedbackBaseline as Record<string, unknown>
    const recurred = typeof b.recurred === "number" && Number.isFinite(b.recurred) && b.recurred >= 0 ? Math.floor(b.recurred) : 0
    const overrides = typeof b.overrides === "number" && Number.isFinite(b.overrides) && b.overrides >= 0 ? Math.floor(b.overrides) : 0
    if (recurred > 0 || overrides > 0) gate.feedbackBaseline = { recurred, overrides }
  }
  if (r.retireBaseline !== null && typeof r.retireBaseline === "object" && !Array.isArray(r.retireBaseline)) {
    const b = r.retireBaseline as Record<string, unknown>
    const count = typeof b.count === "number" && Number.isFinite(b.count) && b.count >= 0 ? Math.floor(b.count) : 0
    const movedOn = typeof b.movedOn === "number" && Number.isFinite(b.movedOn) && b.movedOn >= 0 ? Math.floor(b.movedOn) : undefined
    if (count > 0) gate.retireBaseline = movedOn === undefined ? { count } : { count, movedOn }
  }
  if (r.retireWhen !== null && typeof r.retireWhen === "object" && !Array.isArray(r.retireWhen)) {
    const w = r.retireWhen as Record<string, unknown>
    let retireWhen: RetireWhen | undefined
    if (w.kind === "dep" && typeof w.name === "string" && typeof w.min === "string") {
      retireWhen = { kind: "dep", name: w.name, min: w.min }
    } else if (w.kind === "path" && (w.mode === "present" || w.mode === "absent") && typeof w.path === "string") {
      retireWhen = { kind: "path", mode: w.mode, path: w.path }
    } else if (w.kind === "tag" && typeof w.tag === "string") {
      retireWhen = { kind: "tag", tag: w.tag }
    }
    // malformed/unknown kind: the field is dropped, the gate survives
    if (retireWhen !== undefined) gate.retireWhen = retireWhen
  }
  if (r.remindedSessions !== null && typeof r.remindedSessions === "object" && !Array.isArray(r.remindedSessions)) {
    const sessions: Record<string, number> = {}
    for (const [session, at] of Object.entries(r.remindedSessions as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) sessions[session] = at
    }
    if (Object.keys(sessions).length > 0) gate.remindedSessions = sessions
  }
  if (Array.isArray(r.failedSessions)) {
    // Legacy shape (string[]) — convert with fresh timestamps
    const sessions: Record<string, number | { t: number; v: number }> = {}
    const now = Date.now()
    for (const session of r.failedSessions) {
      if (typeof session === "string") sessions[session] = now
    }
    if (Object.keys(sessions).length > 0) gate.failedSessions = sessions
  } else if (r.failedSessions !== null && typeof r.failedSessions === "object") {
    const sessions: Record<string, number | { t: number; v: number }> = {}
    for (const [session, at] of Object.entries(r.failedSessions as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) {
        sessions[session] = at
      } else if (at !== null && typeof at === "object" && !Array.isArray(at)) {
        const e = at as Record<string, unknown>
        if (typeof e.t === "number" && Number.isFinite(e.t) && typeof e.v === "number" && Number.isFinite(e.v)) {
          sessions[session] = { t: Math.floor(e.t), v: Math.floor(e.v) }
        }
      }
    }
    if (Object.keys(sessions).length > 0) gate.failedSessions = sessions
  }
  return gate
}

/**
 * In-place coercion of everything mechanically repairable. Returns true when
 * anything changed. What it cannot repair (identity fields, hopeless shapes)
 * is rejected earlier by coerceGateShape.
 */
export function repairGate(gate: Gate): boolean {
  let changed = false
  if (gate.firstSeen > gate.lastSeen) {
    const swap = gate.firstSeen
    gate.firstSeen = gate.lastSeen
    gate.lastSeen = swap
    changed = true
  }
  // The retirement baseline anchors a count AT retirement — it can never exceed
  // the lifetime count. Clamp a corrupted overshoot; dropping it instead would
  // re-open the instant re-promotion the baseline exists to damp.
  if (gate.retireBaseline !== undefined && gate.retireBaseline.count > gate.count) {
    gate.retireBaseline.count = gate.count
    changed = true
  }
  if (gate.retireWhen?.kind === "path" && gate.retireWhen.path.includes("\\")) {
    gate.retireWhen.path = gate.retireWhen.path.replace(/\\/g, "/")
    changed = true
  }
  if (gate.snippet.length > SNIPPET_MAX) {
    gate.snippet = sliceSafe(gate.snippet, SNIPPET_MAX)
    changed = true
  }
  // A success-shaped snippet is not failure evidence — clear it so the next
  // failure re-captures a real error line (heals legacy data at the boundary).
  if (looksLikeSuccess(gate.snippet)) {
    gate.snippet = ""
    changed = true
  }
  // template-shaped text is machine-made — re-derive on repair; owner text never matches byte-for-byte
  if (gate.correction !== undefined && gate.correctionOrigin !== "owner" && AUTO_TEMPLATE_CORRECTION.test(gate.correction)) {
    const rederived = suggestCorrection(gate.signature, gate.snippet)
    if (rederived !== gate.correction) {
      gate.correction = rederived
      changed = true
    }
    if (gate.correctionOrigin !== "machine") {
      gate.correctionOrigin = "machine"
      changed = true
    }
  }
  // generic fallback text is machine-made too — prefix match catches generations the AUTO shape misses
  if (gate.correction !== undefined && gate.correctionOrigin !== "owner" && GENERIC_TEMPLATE_CORRECTION.test(gate.correction)) {
    const rederived = suggestCorrection(gate.signature, gate.snippet)
    if (rederived !== gate.correction) {
      gate.correction = rederived
      changed = true
    }
    if (gate.correctionOrigin !== "machine") {
      gate.correctionOrigin = "machine"
      changed = true
    }
  }
  const signature = sanitizeForStore(gate.signature)
  if (signature !== gate.signature) {
    gate.signature = signature
    changed = true
  }
  const snippet = sanitizeForStore(gate.snippet)
  if (snippet !== gate.snippet) {
    gate.snippet = snippet
    changed = true
  }
  if (gate.correction !== undefined) {
    let correction = sanitizeForStore(gate.correction)
    if (correction.length > SNIPPET_MAX) {
      // Unbounded corrections are a context-pollution vector; the companion
      // skill mandates one actionable line anyway.
      correction = sliceSafe(correction, SNIPPET_MAX)
    }
    if (correction !== gate.correction) {
      gate.correction = correction
      changed = true
    }
  }
  // Per-session enforcement state hygiene: rot stale entries, bound the rest.
  if (gate.remindedSessions !== undefined) {
    const now = Date.now()
    const reminded = gate.remindedSessions
    for (const session of Object.keys(reminded)) {
      if (now - (reminded[session] ?? 0) > SESSION_STATE_TTL_MS) {
        delete reminded[session]
        changed = true
      }
    }
    const sessions = Object.keys(reminded)
    if (sessions.length > SESSION_STATE_CAP) {
      sessions.sort((a, b) => (reminded[a] ?? 0) - (reminded[b] ?? 0))
      for (const session of sessions.slice(0, sessions.length - SESSION_STATE_CAP)) {
        delete reminded[session]
      }
      changed = true
    }
    if (Object.keys(reminded).length === 0) delete gate.remindedSessions
  }
  if (gate.failedSessions !== undefined) {
    const now = Date.now()
    const failed = gate.failedSessions
    for (const session of Object.keys(failed)) {
      const entry = failed[session]
      // v:0 keeps the version grace inert; .t unlocks the heartbeat grace for legacy numbers
      if (typeof entry === "number") {
        if (entry <= 0) {
          delete failed[session]
          changed = true
          continue
        }
        failed[session] = { t: Math.floor(entry), v: 0 }
        changed = true
      }
      if (now - failedAtMs(failed[session] ?? 0) > SESSION_STATE_TTL_MS) {
        delete failed[session]
        changed = true
      }
    }
    const sessions = Object.keys(failed)
    if (sessions.length > SESSION_STATE_CAP) {
      sessions.sort((a, b) => failedAtMs(failed[a] ?? 0) - failedAtMs(failed[b] ?? 0))
      for (const session of sessions.slice(0, sessions.length - SESSION_STATE_CAP)) {
        delete failed[session]
      }
      changed = true
    }
    if (Object.keys(failed).length === 0) delete gate.failedSessions
  }
  // Policy is the single source of truth: an enforced gate that no longer
  // qualifies is a leftover from an older policy and must be demoted —
  // blocking to reminding if the shape can still remind, else to watching.
  if (gate.status === "blocking" && !canBlock(gate.tool, gate.signature)) {
    gate.status = canRemind(gate.tool, gate.signature) ? "reminding" : "watching"
    // reset at the transition: the old tier's counter is stale; reminding accrues fresh
    if (gate.recurredAfterReminder > 0) gate.recurredAfterReminder = 0
    changed = true
  }
  if (gate.status === "reminding" && !canRemind(gate.tool, gate.signature)) {
    gate.status = "watching"
    changed = true
  }
  return changed
}

/**
 * Corruption fingerprint of a placeholder re-parameterized inside another
 * token (`<code: <n> >` — a fingerprint eaten by the number rule). Only the
 * `<code:` token carries nested content, so the check is scoped to it —
 * shell text like heredoc `<<eof:` must NOT trip the detector.
 */
export function hasNestedTokens(signature: string): boolean {
  return /<code:\s*</.test(signature)
}

/** True when the persisted key no longer equals patternKey(gate.signature): the gate was keyed under different normalization (or hand-edited) and no live call can reach it. Detection only — evidence cannot be re-attributed. */
export function rekeyMismatch(gate: Gate): boolean {
  return patternKey(gate.signature) !== gate.key
}
