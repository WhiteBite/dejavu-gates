/** Shared test harness: ok/FAIL line printer + failure counter + summary-and-exit. */
import { spawnSync } from "node:child_process"

export interface Checker {
  check(name: string, ok: boolean): void
  report(): void
}

export function makeChecker(): Checker {
  let failures = 0
  return {
    check(name: string, ok: boolean): void {
      if (ok) console.log(`ok   - ${name}`)
      else { failures += 1; console.error(`FAIL - ${name}`) }
    },
    report(): void {
      if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
      console.log("\nall checks passed")
    },
  }
}

/** run a child-process probe (`-e` source) and parse its last stdout JSON line */
export function runProbe(source: string, env: Record<string, string>): Record<string, unknown> {
  const run = spawnSync(process.execPath, ["-e", source], { env: { ...process.env, ...env }, encoding: "utf8" })
  const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop()
  return JSON.parse(line ?? "{}") as Record<string, unknown>
}
