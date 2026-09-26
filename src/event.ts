import { callSignature, isNoiseError, parameterizeError, patternKey, sanitizeForStore } from "./patterns"
import { GLOBAL_PROJECTS } from "./store"
import { isCrossChannelDuplicate, partAlreadyHandled, scrubbedArgs, type EnforceContext } from "./context"
import type { NormalizedEvent } from "./types"

/**
 * Event-channel failure path: tool-level failures that never reach the
 * after-hook (read of a missing file, rejected edit). The host adapter calls
 * this ONLY for tool parts in an error state, with event.output carrying the
 * raw error text, event.callId the part ID (dedup), event.args the tool input.
 * Prefers the real call signature (keeps the gate enforceable by the
 * before-hook); falls back to a parameterized error signature so "same root
 * cause, different data" collapses to one key. Never throws for enforcement.
 */
export async function recordEventFailure(event: NormalizedEvent, ctx: EnforceContext): Promise<void> {
  if (event.callId !== null && partAlreadyHandled(ctx.ephemeral, event.callId)) return

  // never persist secrets or terminal control characters
  const errorText = sanitizeForStore(event.output ?? "unknown error")
  // never count our own gate signals — a thrown REMINDER/BLOCK comes back as a tool error
  if (errorText.includes("[dejavu]")) return
  // aborted/cancelled executions are infrastructure noise, not mistakes
  if (isNoiseError(errorText)) return
  const session = event.sessionId

  let signature: string | null = callSignature(event.tool, scrubbedArgs(event.args))
  if (!signature) {
    signature = `${event.tool}:tool-error:${parameterizeError(errorText).slice(0, 120)}`
  }
  const key = patternKey(signature)

  // cross-channel double-count guard (mirror of the after-hook check)
  if (isCrossChannelDuplicate(ctx.ephemeral, key, session, "event")) return

  const result = await ctx.stores.recordFailure({
    key,
    signature,
    tool: event.tool,
    sessionID: session,
    projectDir: ctx.projectDir,
    snippet: errorText.slice(0, 200),
    globalProjects: GLOBAL_PROJECTS,
    workspaceVersion: ctx.ephemeral.workspaceVersions.get(ctx.projectDir) ?? 0,
  })
  await ctx.stores.logAll({
    type: "detected",
    key,
    tool: event.tool,
    session,
    project: ctx.projectDir,
    snippet: errorText.slice(0, 200),
    channel: "event",
  })
  if (result.promoted) {
    await ctx.stores.logAll({ type: "promoted", key, tool: event.tool, session, project: ctx.projectDir })
    await ctx.log("dejavu", "info", `dejavu: gate promoted — "${result.gate.signature}"`)
  }
}

/** session teardown: free the persisted per-session gate state + ephemeral maps */
export async function cleanupSession(sessionId: string, ctx: EnforceContext): Promise<void> {
  await ctx.stores.forgetSession(sessionId).catch(() => {})
  ctx.ephemeral.repeatSeries.delete(sessionId)
  ctx.ephemeral.repeatWindowLogged.delete(sessionId)
}
