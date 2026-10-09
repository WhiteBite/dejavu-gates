/**
 * Harness-agnostic hook-handler CLI. Reads one hook-event JSON from stdin,
 * dispatches it through the matching adapter + enforcement engine, and writes
 * the harness's decision JSON to stdout. Exit 0 = allow, 2 = block (stderr
 * carries the reason). Fail-open by contract: a broken payload, a broken
 * store, or a dejavu bug must never wedge the user's tool call — any
 * unexpected error prints {} and exits 0.
 *
 * Usage: bun src/cli.ts <pre|post|session-event|session-start> --harness <name> [--store <dir>]
 * stdout carries ONLY the decision JSON; diagnostics go to stderr
 * (engine log lines only when DEJAVU_DEBUG is set).
 */
import { readFileSync } from "node:fs"
import { claudeAdapter } from "./adapters/claude"
import { codexAdapter } from "./adapters/codex"
import { copilotAdapter } from "./adapters/copilot"
import { crushAdapter } from "./adapters/crush"
import { cursorAdapter } from "./adapters/cursor"
import { devinAdapter } from "./adapters/devin"
import { geminiAdapter } from "./adapters/gemini"
import { kiroAdapter } from "./adapters/kiro"
import { allowDecision, str } from "./adapters/shared"
import {
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
} from "./enforce"
import { canonicalDir, findProjectRoot } from "./fs"
import { initStores } from "./host-init"
import { sessionDigest } from "./messages"
import { createStores, type Gate, type Stores } from "./store"
import type {
  HarnessAdapter,
  HarnessName,
  HookPhase,
  NormalizedEvent,
  OutboundDecision,
  Verdict,
} from "./types"

/** Format an OutboundDecision into the harness stdout string: stdoutRaw verbatim when set (empty = silent, Kiro injects hook stdout), else the decision JSON. */
export function formatStdout(decision: OutboundDecision): string {
  if (decision.stdoutRaw != null) return decision.stdoutRaw
  return `${JSON.stringify(decision.json)}\n`
}

/** harnesses this CLI serves — opencode (index.ts) and cline (src/cline-plugin.ts) use in-process plugin entries */
type CliHarness = Exclude<HarnessName, "opencode" | "cline">

const ADAPTERS: Record<CliHarness, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
  crush: crushAdapter,
  devin: devinAdapter,
  kiro: kiroAdapter,
}

const USAGE = "usage: dejavu <pre|post|session-event|session-start> --harness <claude|codex|gemini|cursor|copilot|crush|devin|kiro> [--store <dir>]"

interface CliArgs {
  phase: HookPhase
  harness: CliHarness
  store: string | null
}

function isCliHarness(value: string): value is CliHarness {
  return value in ADAPTERS
}

/** Parse argv; null means the caller prints usage and exits 1. */
function parseArgs(argv: string[]): CliArgs | null {
  const phase = argv[0]
  if (phase !== "pre" && phase !== "post" && phase !== "session-event" && phase !== "session-start") return null
  let harness: string | null = null
  let store: string | null = null
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--harness" && value !== undefined) {
      harness = value
      i += 1
    } else if (flag === "--store" && value !== undefined) {
      store = value
      i += 1
    } else {
      return null
    }
  }
  if (harness === null || !isCliHarness(harness)) return null
  return { phase, harness, store }
}

/** Read the single hook-event JSON on stdin; null = treat as a no-op payload. */
function readHookPayload(): unknown {
  let text: string
  try {
    text = readFileSync(0, "utf8")
  } catch {
    return null // no stdin at all (manual run) — no-op
  }
  try {
    return JSON.parse(text)
  } catch {
    return null // a broken payload must never block the user's tool call
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- SessionStart digest ------------------------------------------------------

const SESSION_DIGEST_GATES = 5

const digestTier = (gate: Gate): number => (gate.status === "blocking" ? 0 : 1)

/** SessionStart digest: the top enforced gates (blocking first, then reminding, lastSeen-desc in a tier) taught upfront so the first call is not lost to a reminder. null = no digest. */
async function sessionStartDigest(stores: Stores): Promise<string | null> {
  const enforced = await stores.enforcedGates()
  const ranked = enforced
    .slice()
    .sort((a, b) => digestTier(a) - digestTier(b) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, SESSION_DIGEST_GATES)
  return sessionDigest(ranked)
}

/** Run the engine for one normalized event and map its outcome to the harness dialect. */
async function dispatch(
  adapter: HarnessAdapter,
  event: NormalizedEvent,
  ctx: EnforceContext,
): Promise<OutboundDecision> {
  switch (event.phase) {
    case "pre": {
      const outcome = await enforceBefore(event, ctx)
      return adapter.mapOutbound("pre", outcome.verdict)
    }
    case "post": {
      const outcome = await enforceAfter(event, ctx)
      // no post-hook channel (crush): detection above still taught the store, only the annotation is skipped
      if (!adapter.postChannel) return allowDecision()
      const verdict: Verdict = { action: "allow", reason: null, annotation: outcome.annotation }
      return adapter.mapOutbound("post", verdict)
    }
    case "session-event": {
      // a null-output session event (SessionEnd) is pure teardown — recording it would fabricate a failure
      if (event.output !== null) await recordEventFailure(event, ctx)
      const hookName = str(event.raw, "hook_event_name")?.toLowerCase() ?? ""
      if (hookName.includes("end") || hookName.includes("delete")) await cleanupSession(event.sessionId, ctx)
      return allowDecision()
    }
    case "session-start": {
      // read-only phase: the digest teaches upfront, nothing is recorded and nothing is denied
      const digest = await sessionStartDigest(ctx.stores)
      return adapter.mapOutbound("session-start", { action: "allow", reason: null, annotation: digest })
    }
  }
}

/** CLI entry: parse → normalize → enforce → emit. Returns the process exit code. */
export async function runHook(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args === null) {
    process.stderr.write(`${USAGE}\n`)
    return 1
  }
  const adapter = ADAPTERS[args.harness]
  try {
    const event = adapter.mapInbound(args.phase, readHookPayload())
    if (event === null) {
      // fail-open speaks the harness's own allow dialect (Kiro's silence included)
      process.stdout.write(formatStdout(adapter.mapOutbound(args.phase, { action: "allow", reason: null, annotation: null })))
      return 0
    }
    // non-bash pre can never deny (canBlock is bash-only) — skip the store boot
    if (args.phase === "pre" && event.tool !== "bash") {
      process.stdout.write(formatStdout(adapter.mapOutbound(args.phase, { action: "allow", reason: null, annotation: null })))
      return 0
    }
    // canonicalize an explicit --store too: a relative or mixed-separator value must not register a second dir
    const projectDir = args.store !== null ? canonicalDir(args.store) : findProjectRoot(event.cwd ?? process.cwd())
    const stores = createStores(projectDir)
    // per-invocation init is the CLI's accepted cost — the three idempotent passes, nothing else
    await initStores(stores, {
      logInitEvent: false,
      rotateLogs: false,
      healthLog: false,
      versionDriftCheck: false,
      log: (_level, message) => {
        process.stderr.write(`[dejavu] ${message}\n`)
      },
    })
    const debug = process.env.DEJAVU_DEBUG !== undefined && process.env.DEJAVU_DEBUG !== "" && process.env.DEJAVU_DEBUG !== "0"
    const ctx: EnforceContext = {
      stores,
      ephemeral: createEphemeralState(),
      log: debug
        ? (_service, level, message) => {
            process.stderr.write(`[dejavu:${level}] ${message}\n`)
          }
        : () => {},
      onHookError: (where, error) => {
        process.stderr.write(`[dejavu] ${where} hook error: ${formatError(error)}\n`)
      },
      platform: process.platform,
      projectDir,
      iteratedVersionSupported: false,
    }
    let decision: OutboundDecision
    try {
      decision = await dispatch(adapter, event, ctx)
    } catch (error) {
      process.stderr.write(`[dejavu] dispatch error: ${formatError(error)}\n`)
      decision = adapter.mapOutbound(event.phase, { action: "allow", reason: null, annotation: null })
    }
    try {
      // deferred repair/retire events must reach the log before this process exits
      await stores.flushDeferredAll()
    } catch {
      // losing a forensic line must not change the decision
    }
    process.stdout.write(formatStdout(decision))
    if (decision.stderr !== null) process.stderr.write(`${decision.stderr}\n`)
    return decision.exitCode
  } catch (error) {
    // fail-open in the harness's own dialect — Kiro injects a successful hook's stdout into agent context
    process.stderr.write(`[dejavu] fatal: ${formatError(error)}\n`)
    const fallback = adapter.mapOutbound(args.phase, { action: "allow", reason: null, annotation: null })
    process.stdout.write(formatStdout(fallback))
    return 0
  }
}

// import.meta.main is a Bun extension absent from @types/node; false when imported (e.g. by src/main.ts)
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  runHook(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      // fail-open last resort — a dejavu bug must never wedge the user's tooling
      process.stderr.write(`[dejavu] fatal: ${formatError(error)}\n`)
      process.stdout.write("{}\n")
      process.exitCode = 0
    },
  )
}
