/**
 * Harness-agnostic hook-handler CLI. Reads one hook-event JSON from stdin,
 * dispatches it through the matching adapter + enforcement engine, and writes
 * the harness's decision JSON to stdout. Exit 0 = allow, 2 = block (stderr
 * carries the reason). Fail-open by contract: a broken payload, a broken
 * store, or a dejavu bug must never wedge the user's tool call — any
 * unexpected error prints {} and exits 0.
 *
 * Usage: bun src/cli.ts <pre|post|session-event> --harness <name> [--store <dir>]
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
import { createStores, GLOBAL_PROJECTS, NOISE_TTL_DAYS, TTL_DAYS } from "./store"
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

/** harnesses this CLI serves — opencode itself uses the plugin entry (index.ts) */
type CliHarness = Exclude<HarnessName, "opencode">

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

const USAGE = "usage: dejavu <pre|post|session-event> --harness <claude|codex|gemini|cursor|copilot|crush|devin|kiro> [--store <dir>]"

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
  if (phase !== "pre" && phase !== "post" && phase !== "session-event") return null
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
      const verdict: Verdict = { action: "allow", reason: null, annotation: outcome.annotation, degraded: false }
      return adapter.mapOutbound("post", verdict)
    }
    case "session-event": {
      await recordEventFailure(event, ctx)
      const hookName = str(event.raw, "hook_event_name")?.toLowerCase() ?? ""
      if (hookName.includes("end") || hookName.includes("delete")) await cleanupSession(event.sessionId, ctx)
      return allowDecision()
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
  const event = adapter.mapInbound(args.phase, readHookPayload())
  if (event === null) {
    // fail-open speaks the harness's own allow dialect (Kiro's silence included)
    process.stdout.write(formatStdout(adapter.mapOutbound(args.phase, { action: "allow", reason: null, annotation: null, degraded: false })))
    return 0
  }
  const projectDir = args.store ?? event.cwd ?? process.cwd()
  const stores = createStores(projectDir)
  try {
    // per-invocation init is the CLI's accepted cost — all three passes are idempotent
    await stores.reconcileAll(GLOBAL_PROJECTS)
    await stores.migrate()
    await stores.expireAll(TTL_DAYS, NOISE_TTL_DAYS)
  } catch (error) {
    // a broken store must not hang the tool pipeline — proceed gateless, stay visible
    process.stderr.write(`[dejavu] init failed: ${formatError(error)}\n`)
  }
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
  }
  let decision: OutboundDecision
  try {
    decision = await dispatch(adapter, event, ctx)
  } catch (error) {
    process.stderr.write(`[dejavu] dispatch error: ${formatError(error)}\n`)
    decision = adapter.mapOutbound(event.phase, { action: "allow", reason: null, annotation: null, degraded: false })
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
