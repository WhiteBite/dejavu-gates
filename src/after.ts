import {
  callSignature,
  detectFailure,
  failureSnippet,
  hasResidualIdentity,
  isDiagnosticSignature,
  isIntendedNonzero,
  isNoiseError,
  nonTransparentProducers,
  parameterizeError,
  patternKey,
  producerSegmentSignatures,
  PROBE_TOOLS,
  sanitizeForStore,
} from "./patterns"
import { checkFeedbackDemotion, GLOBAL_PROJECTS, MAX_SESSIONS, retireAntiNag, retireTaught, type LogEvent } from "./store"
import { ANTI_NAG_REMINDERS, ANTI_NAG_REOFFENSE, TAUGHT_REMINDERS, isCrossChannelDuplicate, scrubbedArgs, type AfterOutcome, type EnforceContext } from "./context"
import { remindNote } from "./messages"
import type { NormalizedEvent } from "./types"

function noneOutcome(): AfterOutcome {
  return { annotation: null, recorded: false }
}

/**
 * Full after-hook enforcement: exit-code failure detection (text-only scan when
 * the harness provides no exit code), isIntendedNonzero immunity, cross-channel
 * dedup, single-producer chain attribution, recordFailure/recordSuccess wiring,
 * reminding-tier NOTE annotation + taught/anti-nag retirement, recurredAfterGate /
 * recurredAfterReminder bookkeeping, review-flag. Never throws for enforcement.
 */
export async function enforceAfter(event: NormalizedEvent, ctx: EnforceContext): Promise<AfterOutcome> {
  const exitCode = event.exitCode
  const isBash = event.tool === "bash"
  // text signatures apply to bash and generic tools (their own error text); probes are file CONTENT
  const text = event.output ?? ""
  const textScanable = isBash || !PROBE_TOOLS.has(event.tool)
  const rawCommand = isBash && typeof event.args.command === "string" ? String(event.args.command) : ""
  // grep/pytest/linters: exit 1 is often the INTENDED outcome, not a mistake
  const intended = exitCode === 1 && isIntendedNonzero(rawCommand, 1)
  // the full-output scan runs only when the exit channel cannot decide or a snippet is needed
  let detection: { matched: boolean; snippet: string } = { matched: false, snippet: "" }
  let failed: boolean
  if (exitCode !== null) {
    failed = (exitCode !== 0 && !intended) || event.errored === true
    if (failed && textScanable) detection = detectFailure(text)
  } else {
    detection = textScanable ? detectFailure(text) : detection
    failed = detection.matched || event.errored === true
  }
  // probes have no exit code — the host's errored signal decides, snippet stays the tool's own error text
  if (!textScanable && event.errored === true) {
    detection = { matched: true, snippet: failureSnippet(text, 1) }
  }
  // only a landed edit/write is iteration evidence — a failed one must not lift the block
  if ((event.tool === "edit" || event.tool === "write") && !failed && event.errored !== true) {
    ctx.ephemeral.workspaceVersions.set(ctx.projectDir, (ctx.ephemeral.workspaceVersions.get(ctx.projectDir) ?? 0) + 1)
  }

  const args = scrubbedArgs(event.args)
  let signature = callSignature(event.tool, args, ctx.projectDir)
  if (event.callId !== null) {
    if (!signature) signature = ctx.ephemeral.pendingCalls.get(event.callId) ?? null
    ctx.ephemeral.pendingCalls.delete(event.callId)
  }
  // argless generic tools have no call identity; error text is the only key (mirrors the event channel)
  if (!signature && failed && !isBash && !PROBE_TOOLS.has(event.tool)) {
    signature = `${event.tool}:tool-error:${parameterizeError(sanitizeForStore(text === "" ? "unknown error" : text)).slice(0, 120)}`
  }
  if (!signature) return noneOutcome()

  // chain attribution needs exactly ONE non-transparent producer — else record under the whole call
  let recordSignature = signature
  if (event.tool === "bash" && typeof args.command === "string" && nonTransparentProducers(args.command) === 1) {
    for (const segSig of producerSegmentSignatures(args.command)) {
      if (!hasResidualIdentity(segSig)) continue
      if (await ctx.stores.hasKey(patternKey(segSig))) {
        recordSignature = segSig
        break
      }
    }
  }
  const key = patternKey(recordSignature)
  const session = event.sessionId

  // a SUCCESS on an enforced gate is healing evidence (bash only — only bash gates enforce)
  if (!failed) {
    if (isBash) await ctx.stores.recordSuccess({ key, signature: recordSignature, tool: event.tool, sessionID: session })
    return noneOutcome()
  }

  // dedup on the WHOLE-CALL signature — the event channel signs the entire call
  if (isCrossChannelDuplicate(ctx.ephemeral, patternKey(signature), session, "after")) return noneOutcome()

  const snippet = sanitizeForStore(detection.matched ? detection.snippet : failureSnippet(text, exitCode))

  // infrastructure noise (service down, transport) is not an agent mistake
  if (isNoiseError(snippet) || isNoiseError(text)) return noneOutcome()

  const result = await ctx.stores.recordFailure({
    key,
    signature: recordSignature,
    tool: event.tool,
    sessionID: session,
    projectDir: ctx.projectDir,
    snippet,
    globalProjects: GLOBAL_PROJECTS,
    workspaceVersion: ctx.ephemeral.workspaceVersions.get(ctx.projectDir) ?? 0,
  })

  await ctx.stores.logAll({
    type: "detected",
    key: result.gate.key,
    tool: event.tool,
    session,
    project: ctx.projectDir,
    harness: event.harness,
    snippet,
    channel: exitCode !== null ? "exit" : "text",
    exit: exitCode ?? undefined,
  })

  if (result.promoted) {
    await ctx.stores.logAll({ type: "promoted", key: result.gate.key, tool: event.tool, session, project: ctx.projectDir })
    await ctx.log("dejavu", "info", `dejavu: gate promoted — "${result.gate.signature}" (${result.gate.count}x, ${result.gate.sessions.length} sessions)`)
  }
  if (result.wentGlobal) {
    await ctx.log("dejavu", "info", `dejavu: gate went global — "${result.gate.signature}"`)
  }

  // escalation state persists ON THE GATE under the store lock — every window sees the same chain
  const ownerStore = result.wentGlobal ? ctx.stores.globalStore : result.store
  const escalationLogs: LogEvent[] = []
  // reminding notes are appended to the failing output after the lock, once per session
  let annotation: string | null = null
  await ownerStore.runLocked(async () => {
    const fresh = (await ownerStore.loadForMutation()).find((g) => g.key === result.gate.key)
    if (fresh === undefined) return
    let changed = false
    // diagnostics are exempt from recurredAfterGate — re-failing after the note IS the iteration
    if (fresh.status !== "watching" && !result.promoted && !isDiagnosticSignature(fresh.signature) && !result.iterated) {
      fresh.recurredAfterGate += 1
      changed = true
      // demotion votes count only failures the gate had a chance to prevent (reminded BEFORE this failure)
      if (fresh.remindedSessions?.[session] !== undefined) {
        if (fresh.reoffenseSessions === undefined) fresh.reoffenseSessions = []
        if (!fresh.reoffenseSessions.includes(session)) {
          fresh.reoffenseSessions.push(session)
          if (fresh.reoffenseSessions.length > MAX_SESSIONS) fresh.reoffenseSessions = fresh.reoffenseSessions.slice(-MAX_SESSIONS)
        }
      }
      escalationLogs.push({ type: "recurred-after-gate", key: fresh.key, tool: event.tool, session, project: ctx.projectDir })
      // negative feedback: a pattern that keeps failing under enforcement is not being taught
      if (checkFeedbackDemotion(fresh)) {
        escalationLogs.push({
          type: "demoted",
          key: fresh.key,
          tool: event.tool,
          session,
          project: ctx.projectDir,
          snippet: `feedback demotion (recurred ${fresh.recurredAfterGate}, overridden ${fresh.overrideCount})`,
        })
      }
    }
    // same-session repeat after a reminder → escalate; reminding gates never collect failedSessions
    if (fresh.status === "blocking" && fresh.remindedSessions?.[session] !== undefined) {
      if (fresh.failedSessions === undefined) fresh.failedSessions = {}
      // the workspace version rides along: an edit after this failure re-opens the attempt
      fresh.failedSessions[session] = { t: Date.now(), v: ctx.ephemeral.workspaceVersions.get(ctx.projectDir) ?? 0 }
      if (!result.iterated) fresh.recurredAfterReminder += 1
      changed = true
    }
    // first failure this session annotates; same-session repeats accrue ignored-note anti-nag
    if (fresh.status === "reminding" && !result.iterated) {
      if (fresh.remindedSessions?.[session] === undefined) {
        if (fresh.remindedSessions === undefined) fresh.remindedSessions = {}
        fresh.remindedSessions[session] = Date.now()
        fresh.remindedCount += 1
        changed = true
        escalationLogs.push({ type: "reminded", key: fresh.key, tool: event.tool, session, project: ctx.projectDir, via: "exact" })
        annotation = remindNote(fresh)
        // taught fires one reminder ABOVE the blocking threshold — the exact-threshold round may still reoffend
        if (fresh.remindedCount > TAUGHT_REMINDERS && fresh.recurredAfterReminder === 0) {
          retireTaught(fresh)
          escalationLogs.push({
            type: "retired-taught",
            key: fresh.key,
            tool: event.tool,
            session,
            project: ctx.projectDir,
            snippet: `reminded ${fresh.remindedCount}x with zero in-session reoffense — teaching worked, retired to watching`,
          })
        }
      } else {
        fresh.recurredAfterReminder += 1
        changed = true
        if (fresh.remindedCount >= ANTI_NAG_REMINDERS && fresh.recurredAfterReminder >= ANTI_NAG_REOFFENSE) {
          const { reminded, reoffended } = retireAntiNag(fresh)
          escalationLogs.push({
            type: "demoted",
            key: fresh.key,
            tool: event.tool,
            session,
            project: ctx.projectDir,
            snippet: `anti-nag retirement (reminded ${reminded}x, reoffended ${reoffended}x) — reminders ignored, stopped enforcing`,
          })
        }
      }
    }
    if (changed) await ownerStore.save()
  })
  // logging stays OUT of the gates lock
  try {
    for (const escalationEvent of escalationLogs) await ctx.stores.logAll(escalationEvent)
    if (escalationLogs.some((escalationEvent) => escalationEvent.type === "demoted")) {
      await ctx.log("dejavu", "info", `dejavu: gate demoted after recurrences — "${result.gate.signature}"`)
    }
  } catch (error) {
    // a logging failure must not break the tool pipeline
    ctx.onHookError("after", error)
  }
  return { annotation, recorded: true }
}
