import { bashSegmentSignatures, callSignature, cmdWrapperPayload, patternKey, stripQuotedSpans } from "./patterns"
import { checkFeedbackDemotion, MAX_SESSIONS, retireAntiNag, retireTaught, type Gate, type GateStore, type LogEvent } from "./store"
import { ANTI_NAG_REMINDERS, ANTI_NAG_REOFFENSE, TAUGHT_REMINDERS, scrubbedArgs, trackPendingCall, type BeforeOutcome, type EnforceContext } from "./context"
import { guardBypassWarnings, proactiveGuardMessage } from "./guards"
import { blockMessage, remindMessage } from "./messages"
import { repeatSeriesDecision } from "./repeat"
import type { NormalizedEvent } from "./types"

// --- Tunables ---------------------------------------------------------------

/** a gate firing this often without killing the error gets flagged for review */
const REVIEW_FIRES = 10
/** a "retry" arriving this soon after a concurrently-dispatched reminder never
 *  saw it (same tool-call burst) — it gets reminded as a first encounter too */
const REMINDER_RACE_WINDOW_MS = 500

function allowOutcome(): BeforeOutcome {
  return { verdict: { action: "allow", reason: null, annotation: null }, signalKind: null }
}

function denyOutcome(reason: string, signalKind: BeforeOutcome["signalKind"]): BeforeOutcome {
  return { verdict: { action: "deny", reason, annotation: null }, signalKind }
}

/**
 * Full before-hook enforcement: repeat-series block, proactive guards, gate
 * lookup (exact/fuzzy/segment), dejavu:proceed override counting, remind→block
 * chain under the store lock (state read FRESH on the gate), blocking-tier
 * taught/anti-nag retirement, heal-aware first-encounter skip. Never throws
 * for enforcement — the caller maps verdict.action "deny" to its abort signal.
 */
export async function enforceBefore(event: NormalizedEvent, ctx: EnforceContext): Promise<BeforeOutcome> {
  const rawArgs = event.args
  const session = event.sessionId
  const repeat = await repeatSeriesDecision(event, ctx)
  // a repeat OVERRIDE only waives the repeat block — gate processing continues
  if (repeat !== null && repeat.kind !== "override") return denyOutcome(repeat.message, "repeat")
  const args = scrubbedArgs(rawArgs)
  const signature = callSignature(event.tool, args, ctx.projectDir)
  if (!signature) return allowOutcome()

  if (event.tool === "bash" && typeof rawArgs.command === "string") {
    const command = rawArgs.command
    // unwrap a cmd /c wrapper first — quote-stripping would eat the marker inside the payload quotes
    const guardPayload = cmdWrapperPayload(command.trim()) ?? command
    const proceeded = /#[ \t]*dejavu:proceed\b/.test(stripQuotedSpans(guardPayload))
    if (!proceeded) {
      const guardMessage = proactiveGuardMessage(command)
      if (guardMessage !== null) return denyOutcome(guardMessage, "guard")
    } else {
      for (const warning of guardBypassWarnings(command)) await ctx.log("dejavu", "warn", warning)
    }
  }

  // the after-hook may arrive without args — the fallback covers NEW patterns too
  if (event.callId !== null) trackPendingCall(ctx.ephemeral, event.callId, signature)

  // chain-bypass protection: a gate must also fire when the command hides in a chain
  const candidates = [signature]
  if (event.tool === "bash" && typeof args.command === "string") {
    candidates.push(...bashSegmentSignatures(args.command))
  }

  let found: { gate: Gate; store: GateStore; via: "exact" | "fuzzy" | "segment" } | null = null
  const seenKeys = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    const sig = candidates[i] ?? ""
    const key = patternKey(sig)
    // single-segment commands repeat the whole-call key — skip the duplicate lookup
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const match = await ctx.stores.findGate(key, sig)
    if (match && match.gate.status !== "watching") {
      found = { gate: match.gate, store: match.store, via: i > 0 && match.via === "exact" ? "segment" : match.via }
      break
    }
  }
  if (found === null) return allowOutcome()
  const target = found
  const gate = found.gate
  const via = found.via

  // the marker must be a COMMENT — a leading cmd /c wrapper is unwrapped before quote-stripping
  const commandText =
    typeof rawArgs.command === "string"
      ? rawArgs.command
      : typeof rawArgs.pattern === "string"
        ? rawArgs.pattern
        : typeof rawArgs.filePath === "string"
          ? rawArgs.filePath
          : ""
  const wrappedPayload = typeof rawArgs.command === "string" ? cmdWrapperPayload(rawArgs.command.trim()) : null
  const markerText = wrappedPayload === null ? commandText : wrappedPayload
  if (/#[ \t]*dejavu:proceed\b/.test(stripQuotedSpans(markerText))) {
    await ctx.stores.logAll({ type: "override", key: gate.key, tool: gate.tool, session, project: ctx.projectDir })
    // overrides are the sanctioned bypass — surface them loudly (prompt-injection visibility)
    await ctx.log("dejavu", "warn", `dejavu: override (dejavu:proceed) for gate ${gate.key} "${gate.signature}" in session ${session}`)
    let demotedEvent: LogEvent | null = null
    await target.store.runLocked(async () => {
      const fresh = (await target.store.loadForMutation()).find((g) => g.key === gate.key)
      if (fresh === undefined || (fresh.status !== "blocking" && fresh.status !== "reminding")) return
      fresh.overrideCount += 1
      // distinct-session votes: one stubborn/injected session must not disarm the gate
      if (fresh.overrideSessions === undefined) fresh.overrideSessions = []
      if (!fresh.overrideSessions.includes(session)) {
        fresh.overrideSessions.push(session)
        if (fresh.overrideSessions.length > MAX_SESSIONS) fresh.overrideSessions = fresh.overrideSessions.slice(-MAX_SESSIONS)
      }
      const demoted = checkFeedbackDemotion(fresh)
      await target.store.save()
      if (demoted) {
        demotedEvent = {
          type: "demoted",
          key: fresh.key,
          tool: fresh.tool,
          session,
          project: ctx.projectDir,
          snippet: `feedback demotion (recurred ${fresh.recurredAfterGate}, overridden ${fresh.overrideCount})`,
        }
      }
    })
    // logging stays OUT of the gates lock — log-lock contention cascades into degrade storms
    if (demotedEvent !== null) {
      try {
        await ctx.stores.logAll(demotedEvent)
        await ctx.log("dejavu", "info", `dejavu: gate demoted after overrides — "${gate.signature}"`)
      } catch (error) {
        // a logging failure must not break the tool pipeline
        ctx.onHookError("before", error)
      }
    }
    return allowOutcome()
  }

  // reminding gates never interrupt — the note rides on the failing output (after-hook)
  if (gate.status === "reminding") return allowOutcome()

  // enforce from FRESH gate state under the lock — the chain lives on the gate, not in process memory
  const pendingLogs: LogEvent[] = []
  const signal = await target.store.runLocked(async (): Promise<{ message: string; kind: "block" | "reminder" } | null> => {
    const fresh = (await target.store.loadForMutation()).find((g) => g.key === gate.key)
    if (fresh === undefined) return null // gate deleted between find and lock
    // a concurrent window may have demoted the gate — only blocking gates interrupt
    if (fresh.status !== "blocking") return null

    // repeat offense: reminded, retried, failed again → hard block
    const failedEntry = fresh.failedSessions?.[session]
    if (fresh.status === "blocking" && failedEntry !== undefined) {
      // iteration grace: an edit since the failed attempt makes this a fresh try on changed code
      const failedAtVersion = typeof failedEntry === "object" ? failedEntry.v : undefined
      if (failedAtVersion !== undefined && (ctx.ephemeral.workspaceVersions.get(ctx.projectDir) ?? 0) > failedAtVersion) {
        if (fresh.failedSessions !== undefined) {
          delete fresh.failedSessions[session]
          if (Object.keys(fresh.failedSessions).length === 0) delete fresh.failedSessions
        }
        await target.store.save()
        pendingLogs.push({ type: "retry-allowed", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
        return null
      }
      fresh.blockedCount += 1
      if (fresh.blockedCount >= REVIEW_FIRES) fresh.review = true
      await target.store.save()
      pendingLogs.push({ type: "blocked", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
      return { message: blockMessage(fresh, target.store.dir), kind: "block" }
    }

    // first encounter this session → remind (the call is aborted; agent may retry corrected)
    const remindedAt = fresh.remindedSessions?.[session]
    if (remindedAt === undefined || Date.now() - remindedAt < REMINDER_RACE_WINDOW_MS) {
      // heal-aware: consecutive successes mean a likely-fixed command — arm the chain, don't interrupt
      if (fresh.status === "blocking" && (fresh.succeededAfterGate ?? 0) > 0) {
        if (fresh.remindedSessions === undefined) fresh.remindedSessions = {}
        fresh.remindedSessions[session] = Date.now()
        await target.store.save()
        pendingLogs.push({ type: "retry-allowed", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
        return null
      }
      if (fresh.remindedSessions === undefined) fresh.remindedSessions = {}
      fresh.remindedSessions[session] = Date.now()
      // only TRUE first encounters count — raced calls (same dispatch burst) never saw the reminder
      const firstEncounter = remindedAt === undefined
      if (firstEncounter) fresh.remindedCount += 1
      // taught retirement: many reminders, zero reoffense — the reminder works, retire softly (last reminder)
      if (firstEncounter && fresh.remindedCount >= TAUGHT_REMINDERS && fresh.recurredAfterReminder === 0 && fresh.recurredAfterGate === 0) {
        retireTaught(fresh)
        await target.store.save()
        pendingLogs.push({ type: "reminded", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
        pendingLogs.push({
          type: "retired-taught",
          key: fresh.key,
          tool: fresh.tool,
          session,
          project: ctx.projectDir,
          snippet: `reminded ${fresh.remindedCount}x with zero reoffense — teaching worked, retired to watching`,
        })
        return { message: remindMessage(fresh), kind: "reminder" }
      }
      // blocking-only: a demoted gate's stale recurredAfterReminder must not retire it on old evidence
      if (firstEncounter && fresh.status === "blocking" && fresh.remindedCount >= ANTI_NAG_REMINDERS && fresh.recurredAfterReminder >= ANTI_NAG_REOFFENSE) {
        const { reminded, reoffended } = retireAntiNag(fresh)
        await target.store.save()
        pendingLogs.push({
          type: "demoted",
          key: fresh.key,
          tool: fresh.tool,
          session,
          project: ctx.projectDir,
          snippet: `anti-nag retirement (reminded ${reminded}x, reoffended ${reoffended}x) — reminders ignored, stopped enforcing`,
        })
        return null
      }
      await target.store.save()
      pendingLogs.push({ type: "reminded", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
      return { message: remindMessage(fresh), kind: "reminder" }
    }

    // already reminded, no repeated failure yet → allow one retry
    pendingLogs.push({ type: "retry-allowed", key: fresh.key, tool: fresh.tool, session, project: ctx.projectDir, via })
    return null
  })
  try {
    for (const pendingEvent of pendingLogs) await ctx.stores.logAll(pendingEvent)
  } catch (error) {
    // a logging failure must not swallow the enforcement signal below
    ctx.onHookError("before", error)
  }
  if (signal !== null) {
    if (event.callId !== null) ctx.ephemeral.pendingCalls.delete(event.callId)
    return denyOutcome(signal.message, signal.kind)
  }
  return allowOutcome()
}
