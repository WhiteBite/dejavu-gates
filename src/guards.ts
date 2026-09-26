import {
  shouldWarnInheritedSpawn,
  shouldWarnLongRunning,
  shouldWarnOrphanJob,
  shouldWarnSuppressedSpawn,
  shouldWarnWaitLoop,
} from "./patterns"

/**
 * Proactive guards: static, bounded classes of bash commands interrupted BEFORE
 * they hang the call — unlike learned gates they warn on first sight. The
 * dejavu:proceed escape hatch still allows a deliberate run (logged).
 */

/** the first matching guard's block message, or null when the command is safe */
export function proactiveGuardMessage(command: string): string | null {
  // a FOREGROUND dev-server/watcher start blocks until the bash timeout and strands an orphan process
  if (shouldWarnLongRunning(command)) {
    return `[dejavu] LONG-RUNNING — this looks like a dev server / watcher started in FOREGROUND bash; it will block until the bash timeout and leave an orphan process. Do NOT give up on it — start it DETACHED and continue: PowerShell \`Start-Process npm -ArgumentList 'run','dev'\` (or \`Start-Process powershell -ArgumentList '-File','start-dev.ps1'\`), bash \`nohup npm run dev > server.log 2>&1 &\`, or \`tmux new-session -d\`. For e2e/browser tests: start it detached, then read the ACTUAL port from the server's startup log (with strictPort off the server picks a FREE port, so the configured port may be wrong — polling a wrong port hangs forever), poll THAT port until it answers, run your tests against it, then kill the process. If you truly need it in foreground, append the trailing comment "# dejavu:proceed".`
  }
  // a polling loop with no timeout hangs until the bash timeout if the condition never arrives
  if (shouldWarnWaitLoop(command)) {
    return `[dejavu] WAIT-LOOP — this looks like a polling loop (while/until/for + sleep) with NO timeout guard; it will hang until the bash timeout (~2 min) if the condition never arrives. Add a bound: \`curl --max-time N\`, \`Invoke-WebRequest -TimeoutSec N\`, or a max-iteration counter with \`break\`. If intentional, append "# dejavu:proceed".`
  }
  // compensates anomalyco/opencode#29831 — remove when the upstream fix ships
  if (shouldWarnSuppressedSpawn(command)) {
    return `[dejavu] SUPPRESSED-SPAWN — this spawns a detached daemon while piping/redirecting stdout; opencode ends a bash call only on stdio EOF and the living daemon keeps the pipe open, so this call hangs forever (upstream anomalyco/opencode#29831). CORRECTION: run the spawn WITHOUT any pipe or stdout redirect (it prints only 1-3 lines) and poll its status in a SEPARATE call. If you truly need this shape, append the trailing comment "# dejavu:proceed".`
  }
  // -RedirectStandard*/-Wait turns ON handle inheritance — the spawned process holds THIS call's stdio pipes
  if (shouldWarnInheritedSpawn(command)) {
    return `[dejavu] INHERITED-SPAWN — Start-Process with -RedirectStandard*/-Wait (or a pipe/redirect on the spawn statement) hands THIS call's stdio pipes to the spawned process via handle inheritance; opencode ends a bash call only on stdio EOF, so a child that outlives the call hangs it forever — redirecting all three streams does NOT help. CORRECTION: spawn BARE (no -RedirectStandard*, no -Wait, no pipe/redirect in the spawn statement) and let the daemon write its own logs from inside; or two-stage — an outer BARE Start-Process of a pwsh one-liner that does the redirecting INSIDE (the intermediary inherits nothing from this call). Poll readiness in a SEPARATE call. If you truly need this shape, append the trailing comment "# dejavu:proceed".`
  }
  // Start-Job work lives inside THIS call's PowerShell and is killed silently when the call ends
  if (shouldWarnOrphanJob(command)) {
    return `[dejavu] ORPHAN-JOB — Start-Job runs inside THIS bash call's PowerShell: the job is killed silently when the call ends, so work you expect to continue in the background never survives and nothing reports it. CORRECTION: for work that must outlive the call, spawn DETACHED — a BARE Start-Process (no -RedirectStandard*, no pipe) of a pwsh one-liner/script that does the work and writes its own logs, then poll in a SEPARATE call; if you only need the result here, run it synchronously or add Wait-Job / Receive-Job -Wait. If intentional, append the trailing comment "# dejavu:proceed".`
  }
  return null
}

/** visibility log lines for guards bypassed via dejavu:proceed — a hung subagent must be explainable after the fact */
export function guardBypassWarnings(command: string): string[] {
  const warnings: string[] = []
  if (shouldWarnLongRunning(command)) warnings.push(`dejavu: long-running guard bypassed via dejavu:proceed — command may hang: ${command.slice(0, 200)}`)
  if (shouldWarnSuppressedSpawn(command)) warnings.push(`dejavu: suppressed-spawn guard bypassed via dejavu:proceed — command may hang: ${command.slice(0, 200)}`)
  if (shouldWarnInheritedSpawn(command)) warnings.push(`dejavu: inherited-spawn guard bypassed via dejavu:proceed — command may hang: ${command.slice(0, 200)}`)
  if (shouldWarnOrphanJob(command)) warnings.push(`dejavu: orphan-job guard bypassed via dejavu:proceed — job dies with the call: ${command.slice(0, 200)}`)
  return warnings
}
