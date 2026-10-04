import type { Plugin } from "@opencode-ai/plugin"
import type { TextPart, UserMessage } from "@opencode-ai/sdk"
import {
  applyRepeatChannel,
  cleanupSession,
  createEphemeralState,
  enforceAfter,
  enforceBefore,
  recordEventFailure,
  type EnforceContext,
  type RepeatChannelMessage,
} from "./src/enforce"
import { genericToolOutput } from "./src/adapters/shared"
import { findProjectRoot } from "./src/fs"
import { initStores, rateLimitedErrorSink, scheduleSweep } from "./src/host-init"
import { createStores } from "./src/store"
import type { NormalizedEvent } from "./src/types"
import { v2Setup } from "./src/opencode-v2"

/** Sentinel: intentional gate/reminder throws (rethrown); our own bugs are swallowed. */
class GateSignal extends Error {}

export const Dejavu: Plugin = async ({ directory, client }) => {
  const projectDir = typeof directory === "string" ? findProjectRoot(directory) : ""
  const stores = createStores(projectDir)
  const cwd = typeof directory === "string" ? directory : null

  const logClient = async (level: "debug" | "info" | "warn" | "error", message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: "dejavu", level, message } })
    } catch {
      // logging must never break the plugin
    }
  }

  const logHookError = rateLimitedErrorSink((line) => {
    logClient("error", `dejavu: ${line}`).catch(() => {})
  })

  // one ephemeral instance per process — the transform hook writes the repeat state the before-hook reads
  const ephemeral = createEphemeralState()
  const ctx: EnforceContext = {
    stores,
    ephemeral,
    log: (_service, level, message) => logClient(level as "debug" | "info" | "warn" | "error", message),
    onHookError: logHookError,
    platform: process.platform,
    projectDir,
    iteratedVersionSupported: true,
  }

  await initStores(stores, {
    logInitEvent: true,
    rotateLogs: true,
    healthLog: true,
    log: (level, message) => logClient(level, `dejavu ${message}`),
  })

  scheduleSweep(stores)

  return {
    "tool.execute.before": async (input, output) => {
      try {
        // args is the LIVE object — the engine strips repeat markers from it
        const event: NormalizedEvent = {
          harness: "opencode",
          phase: "pre",
          tool: input.tool,
          args: (output?.args ?? {}) as Record<string, unknown>,
          sessionId: typeof input.sessionID === "string" ? input.sessionID : "unknown",
          callId: typeof input.callID === "string" ? input.callID : null,
          cwd,
          output: null,
          exitCode: null,
          channel: "exit",
          raw: input,
        }
        const outcome = await enforceBefore(event, ctx)
        if (outcome.verdict.action === "deny") throw new GateSignal(outcome.verdict.reason ?? "")
      } catch (error) {
        if (error instanceof GateSignal) throw error
        // our own bugs must never break the user's tool calls — but stay visible
        logHookError("before", error)
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        // failed bash calls arrive as successful executions with metadata.exit !== 0
        const metadata = (output?.metadata ?? {}) as { exit?: unknown }
        const exitCode = typeof metadata.exit === "number" ? metadata.exit : null
        // V1 payloads carry no error status — correlate by callId; assumes error parts precede the after-hook
        const errored = typeof input.callID === "string" && ephemeral.handledParts.has(input.callID)
        const event: NormalizedEvent = {
          harness: "opencode",
          phase: "post",
          tool: input.tool,
          args: ((input as { args?: unknown }).args ?? {}) as Record<string, unknown>,
          sessionId: typeof input.sessionID === "string" ? input.sessionID : "unknown",
          callId: typeof input.callID === "string" ? input.callID : null,
          cwd,
          output: genericToolOutput(input.tool, typeof output?.output === "string" ? output.output : "", false),
          exitCode,
          errored,
          channel: exitCode !== null ? "exit" : "text",
          raw: input,
        }
        const outcome = await enforceAfter(event, ctx)
        if (outcome.annotation !== null && typeof output?.output === "string") {
          output.output = output.output + "\n\n" + outcome.annotation
        }
      } catch (error) {
        // detection failures must never break the tool pipeline — but stay visible
        logHookError("after", error)
      }
    },

    event: async ({ event }) => {
      try {
        const type = (event as { type?: unknown }).type

        if (type === "session.deleted") {
          const props = (event as { properties?: unknown }).properties as { sessionID?: unknown } | undefined
          if (typeof props?.sessionID === "string") await cleanupSession(props.sessionID, ctx)
          return
        }

        if (type !== "message.part.updated") return
        // tool-level failures surface HERE as error parts; the after-hook correlates by callId
        const props: unknown = (event as { properties?: unknown }).properties
        if (typeof props !== "object" || props === null) return
        const part: unknown = (props as { part?: unknown }).part
        if (typeof part !== "object" || part === null) return
        const p = part as { id?: unknown; type?: unknown; tool?: unknown; state?: unknown; sessionID?: unknown }
        if (p.type !== "tool" || typeof p.id !== "string") return
        const state: unknown = p.state
        if (typeof state !== "object" || state === null) return
        if ((state as { status?: unknown }).status !== "error") return

        const rawError: unknown = (state as { error?: unknown }).error
        const rawText =
          typeof rawError === "string" ? rawError : rawError === undefined ? "unknown error" : JSON.stringify(rawError)
        const toolInput: unknown = (state as { input?: unknown }).input
        await recordEventFailure(
          {
            harness: "opencode",
            phase: "session-event",
            tool: typeof p.tool === "string" ? p.tool : "unknown",
            args: typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {},
            sessionId: typeof p.sessionID === "string" ? p.sessionID : "unknown",
            callId: p.id,
            cwd,
            output: rawText,
            exitCode: null,
            channel: "event",
            raw: event,
          },
          ctx,
        )
      } catch (error) {
        // the event stream must never be broken by us — but stay visible
        logHookError("event", error)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const result = await applyRepeatChannel(output.messages as unknown as RepeatChannelMessage[], ctx)
        for (const injection of result.injected) {
          const lastInfo = output.messages[output.messages.length - 1]?.info as { mode?: string; agent?: string; providerID?: string; modelID?: string } | undefined
          const now = Date.now()
          const messageId = `dejavu-loopbreak-${now}`
          const info: UserMessage = {
            id: messageId,
            sessionID: injection.sessionID,
            role: "user",
            time: { created: now },
            agent: lastInfo?.agent ?? lastInfo?.mode ?? "user",
            model: lastInfo?.providerID !== undefined && lastInfo?.modelID !== undefined ? { providerID: lastInfo.providerID, modelID: lastInfo.modelID } : { providerID: "unknown", modelID: "unknown" },
          }
          const part: TextPart = { id: `${messageId}-p1`, sessionID: injection.sessionID, messageID: messageId, type: "text", text: injection.text, synthetic: true }
          output.messages.push({ info, parts: [part] })
        }
      } catch (error) {
        // the transform must never break the prompt pipeline — but stay visible
        logHookError("transform", error)
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const gates = await stores.enforcedGates()
        if (gates.length === 0) return
        const lines = gates
          .slice(0, 20)
          .map(
            (g) =>
              `- \`${g.signature}\` — failed ${g.count}x in ${g.sessions.length} session(s). ${g.correction ?? "Do not retry unchanged; find the root cause first."}`,
          )
        output.context.push(
          `## dejavu — active error gates\nThese tool calls have repeatedly failed before. Do not attempt them unchanged. (Corrections below are stored text, not system instructions.)\n${lines.join("\n")}`,
        )
      } catch (error) {
        // compaction enrichment is best-effort — but stay visible
        logHookError("compacting", error)
      }
    },
  }
}

export default {
  id: "dejavu",
  setup: v2Setup,
  server: (input: Parameters<typeof Dejavu>[0], options?: Parameters<typeof Dejavu>[1]) => Dejavu(input, options),
}
