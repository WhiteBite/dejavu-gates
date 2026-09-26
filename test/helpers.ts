/** Shared test harness: ok/FAIL line printer + failure counter + summary-and-exit. */
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
