/**
 * Characterization test for the dual-export entrypoint.
 * Run: bun test/v2-host.ts
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import mod, { Dejavu } from "../index"
import { v2Setup } from "../src/opencode-v2"
import { makeChecker } from "./helpers"

type Ctx = Parameters<typeof Dejavu>[0]
type Hooks = Awaited<ReturnType<typeof Dejavu>>

const { check, report } = makeChecker()

check("named Dejavu export is a function", typeof Dejavu === "function")
check("default export id is dejavu", mod.id === "dejavu")
check("default export setup is a function", typeof mod.setup === "function")
check("default export server is a function", typeof mod.server === "function")

const EXPECTED_HOOK_KEYS = JSON.stringify([
  "event",
  "experimental.chat.messages.transform",
  "experimental.session.compacting",
  "tool.execute.after",
  "tool.execute.before",
])

const tmp = await mkdtemp(join(tmpdir(), "dejavu-v2-host-"))
process.env.DEJAVU_HOME = join(tmp, "global")
const fakeInput = {
  directory: join(tmp, "project"),
  client: { app: { log: async () => ({}) } },
} as unknown as Ctx

try {
  const v1 = await Dejavu(fakeInput)
  if (typeof mod.server === "function") {
    const viaServer: Hooks = await mod.server(fakeInput, {})
    check(
      "server() returns the same hook keys as Dejavu()",
      JSON.stringify(Object.keys(v1).sort()) === JSON.stringify(Object.keys(viaServer).sort()),
    )
    check("every server() hook value is a function", Object.values(viaServer).every((hook) => typeof hook === "function"))
    check("the 5 V1 hook keys are present", JSON.stringify(Object.keys(viaServer).sort()) === EXPECTED_HOOK_KEYS)
  } else {
    check("server() parity", false)
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}

// --- v2Setup stub-context invocation ---
const tmp2 = await mkdtemp(join(tmpdir(), "dejavu-v2-setup-"))
process.env.DEJAVU_HOME = join(tmp2, "global")

interface Registration {
  kind: "tool" | "session"
  name: string
  cb: (event: never) => Promise<void>
}

const registrations: Registration[] = []
let subscribeCalls = 0
let subscriptionTerminated = false

const fakeEvents = async function* (signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
  subscriptionTerminated = true
}

const stub = {
  location: { directory: join(tmp2, "project") },
  tool: {
    hook: async (name: string, cb: (event: never) => Promise<void>): Promise<{ dispose: () => Promise<void> }> => {
      registrations.push({ kind: "tool", name, cb })
      return { dispose: async () => {} }
    },
  },
  session: {
    hook: async (name: string, cb: (event: never) => Promise<void>): Promise<{ dispose: () => Promise<void> }> => {
      registrations.push({ kind: "session", name, cb })
      return { dispose: async () => {} }
    },
  },
  event: {
    subscribe: (input: { signal: AbortSignal }): AsyncGenerator<never> => {
      subscribeCalls += 1
      return fakeEvents(input.signal)
    },
  },
} as unknown as Plugin.Context

const invokeHook = async (name: string, event: unknown): Promise<unknown> => {
  const reg = registrations.find((r) => r.name === name)
  if (reg === undefined) return new Error(`${name} not registered`)
  try {
    await reg.cb(event as never)
    return null
  } catch (error) {
    return error
  }
}

try {
  let cleanup: (() => void) | null = null
  let setupThrew: unknown = null
  try {
    cleanup = await v2Setup(stub)
  } catch (error) {
    setupThrew = error
  }
  check("v2Setup completes without throwing against a stub Context", setupThrew === null)

  check('tool.hook registered "execute.before"', registrations.some((r) => r.kind === "tool" && r.name === "execute.before"))
  check('tool.hook registered "execute.after"', registrations.some((r) => r.kind === "tool" && r.name === "execute.after"))
  check('session.hook registered "compaction"', registrations.some((r) => r.kind === "session" && r.name === "compaction"))
  check("event.subscribe was called once", subscribeCalls === 1)

  const baseEvent = { tool: "bash", sessionID: "s1", agent: "build", messageID: "m1", id: "c1", input: { command: "echo hi" } }
  check("execute.before callback does not throw", (await invokeHook("execute.before", baseEvent)) === null)
  check(
    "execute.after completed callback does not throw",
    (await invokeHook("execute.after", { ...baseEvent, status: "completed", result: { content: "hi", metadata: { exit: 0 } } })) === null,
  )
  check(
    "execute.after error callback does not throw",
    (await invokeHook("execute.after", { ...baseEvent, status: "error", error: { message: "boom" } })) === null,
  )
  check(
    "compaction callback does not throw",
    (await invokeHook("compaction", {
      sessionID: "s1",
      model: { providerID: "p", modelID: "m" },
      system: [],
      messages: [],
      options: {},
      tools: {},
      agent: "build",
    })) === null,
  )
  const failingShell = {
    tool: "shell",
    sessionID: "s1",
    agent: "build",
    messageID: "m1",
    id: "c9",
    input: { command: "obs-fail-cmd" },
    status: "completed",
    result: { content: "error: obs regression boom\n", metadata: { exit: 1 } },
  }
  check("execute.after records a failing shell call without throwing", (await invokeHook("execute.after", failingShell)) === null)
  const gateDoc = JSON.parse(await readFile(join(tmp2, "project", ".opencode", "dejavu", "gates.json"), "utf8")) as {
    gates: Array<{ tool?: string; signature?: string }>
  }
  const shellGate = gateDoc.gates.find((gate) => (gate.signature ?? "").includes("obs-fail-cmd"))
  check("the failing shell call records under the bash vocabulary", shellGate !== undefined && shellGate.tool === "bash")

  check("v2Setup returns a function", typeof cleanup === "function")
  let cleanupThrew: unknown = null
  if (cleanup !== null) {
    try {
      cleanup()
    } catch (error) {
      cleanupThrew = error
    }
  }
  check("cleanup() does not throw", cleanupThrew === null)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  check("cleanup() terminates the event subscription", subscriptionTerminated)
} finally {
  await rm(tmp2, { recursive: true, force: true })
}

report()
