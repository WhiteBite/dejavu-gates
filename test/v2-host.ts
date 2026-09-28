/**
 * Characterization test for the dual-export entrypoint.
 * Run: bun test/v2-host.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import mod, { Dejavu } from "../index"
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

report()
