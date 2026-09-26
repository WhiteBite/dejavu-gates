/**
 * Characterization of src/guards.ts proactive guards: fire shapes, benign
 * pass-through, check-order precedence, and bypass-visibility warnings.
 * Run: bun test/guards.ts
 */
import { guardBypassWarnings, proactiveGuardMessage } from "../src/guards"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

const msg = (command: string): string => proactiveGuardMessage(command) ?? ""

// --- LONG-RUNNING ---
check("long-running fires on foreground npm run dev", msg("npm run dev").includes("[dejavu] LONG-RUNNING"))
check("long-running fires on foreground next dev", msg("next dev").includes("[dejavu] LONG-RUNNING"))
check("long-running fires on foreground python -m http.server", msg("python -m http.server").includes("[dejavu] LONG-RUNNING"))
check("long-running allows one-shot npm run build", proactiveGuardMessage("npm run build") === null)
check("long-running allows one-shot vite build", proactiveGuardMessage("vite build") === null)
check("long-running allows trailing-& detached form", proactiveGuardMessage("npm run dev &") === null)
check("long-running allows bare Start-Process detached form", proactiveGuardMessage("Start-Process npm -ArgumentList 'run','dev'") === null)
check("long-running allows tmux new-session detached form", proactiveGuardMessage("tmux new-session -d 'npm run dev'") === null)
check("long-running fires on foreground npm run dev 2>&1 (fd-dup is not backgrounding)", msg("npm run dev 2>&1").includes("[dejavu] LONG-RUNNING"))
check("real background after fd-dup stays detached", proactiveGuardMessage("npm run dev 2>&1 &") === null)
check("nohup with redirect and trailing & stays detached", proactiveGuardMessage("nohup npm run dev > server.log 2>&1 &") === null)

// --- WAIT-LOOP ---
check("wait-loop fires on bash until/curl/sleep poll", msg("until curl -sf http://localhost:3000; do sleep 2; done").includes("[dejavu] WAIT-LOOP"))
check("wait-loop fires on PowerShell while + Start-Sleep -Seconds", msg("while ($true) { Start-Sleep -Seconds 1 }").includes("[dejavu] WAIT-LOOP"))
check("wait-loop fires on PowerShell for-loop + Start-Sleep", msg("for ($i = 0; $i -lt 10; $i++) { Start-Sleep 1 }").includes("[dejavu] WAIT-LOOP"))
check("wait-loop ignores a while loop without sleep", proactiveGuardMessage("while read line; do echo $line; done < file.txt") === null)
check("wait-loop ignores a bare Start-Sleep", proactiveGuardMessage("Start-Sleep 5") === null)

// --- SUPPRESSED-SPAWN ---
check("suppressed-spawn fires on spawner piped to Out-Null", msg("node siphon-supervisor.mjs start | Out-Null").includes("[dejavu] SUPPRESSED-SPAWN"))
check("suppressed-spawn fires on spawner with stdout redirect", msg("node siphon-supervisor.mjs start > supervisor.log").includes("[dejavu] SUPPRESSED-SPAWN"))
check("suppressed-spawn ignores a bare spawner run", proactiveGuardMessage("node siphon-supervisor.mjs start") === null)
check("suppressed-spawn ignores a stderr-only redirect", proactiveGuardMessage("node siphon-supervisor.mjs start 2> err.log") === null)
check("suppressed-spawn ignores a pipe without a known spawner", proactiveGuardMessage("node worker.js | Out-Null") === null)

// --- INHERITED-SPAWN ---
check(
  "inherited-spawn fires on -RedirectStandard* with hidden window",
  msg("Start-Process npm -ArgumentList 'run','dev' -RedirectStandardOutput out.txt -WindowStyle Hidden").includes("[dejavu] INHERITED-SPAWN"),
)
check(
  "inherited-spawn fires on -Wait with hidden window",
  msg("Start-Process pwsh -ArgumentList '-File','server.ps1' -Wait -WindowStyle Hidden").includes("[dejavu] INHERITED-SPAWN"),
)
check("inherited-spawn ignores a bare Start-Process", proactiveGuardMessage("Start-Process npm -ArgumentList 'run','dev'") === null)
check("inherited-spawn ignores a redirected one-shot child", proactiveGuardMessage("Start-Process notepad -RedirectStandardOutput out.txt") === null)
check("inherited-spawn ignores daemon intent without a leak vector", proactiveGuardMessage("Start-Process npm -WindowStyle Hidden") === null)

// --- ORPHAN-JOB ---
check("orphan-job fires on Start-Job without an in-call wait", msg("Start-Job -ScriptBlock { Get-ChildItem }").includes("[dejavu] ORPHAN-JOB"))
check("orphan-job ignores Start-Job followed by Wait-Job", proactiveGuardMessage("$j = Start-Job -ScriptBlock { Get-ChildItem }; Wait-Job $j; Receive-Job $j") === null)
check("orphan-job ignores Start-Job piped to Receive-Job -Wait", proactiveGuardMessage("Start-Job -ScriptBlock { Get-ChildItem } | Receive-Job -Wait") === null)
check("orphan-job ignores a plain Get-Job", proactiveGuardMessage("Get-Job") === null)

// --- precedence: first match in guards.ts check order wins ---
const longPlusWait = "until curl -sf http://localhost:3000; do sleep 2; done; npm run dev"
check("long-running is checked before wait-loop", msg(longPlusWait).includes("[dejavu] LONG-RUNNING") && !msg(longPlusWait).includes("[dejavu] WAIT-LOOP"))
const inheritPlusOrphan = "Start-Process pwsh -WindowStyle Hidden -RedirectStandardOutput o.txt; Start-Job { Get-ChildItem }"
check("inherited-spawn is checked before orphan-job", msg(inheritPlusOrphan).includes("[dejavu] INHERITED-SPAWN") && !msg(inheritPlusOrphan).includes("[dejavu] ORPHAN-JOB"))

// --- benign pass-through ---
check("ls -la passes all guards", proactiveGuardMessage("ls -la") === null)
check("npm run build passes all guards", proactiveGuardMessage("npm run build") === null)
check("git status passes all guards", proactiveGuardMessage("git status") === null)

// --- dejavu:proceed is handled in before.ts; guards.ts still reports the shape ---
check("long-running message still fires with # dejavu:proceed", msg("npm run dev # dejavu:proceed").includes("[dejavu] LONG-RUNNING"))
check("orphan-job message still fires with # dejavu:proceed", msg("Start-Job -ScriptBlock { Get-ChildItem } # dejavu:proceed").includes("[dejavu] ORPHAN-JOB"))

// --- guardBypassWarnings ---
check("bypass warnings non-empty for a guarded command", guardBypassWarnings("npm run dev").length > 0)
check("bypass warning names the long-running guard", (guardBypassWarnings("npm run dev")[0] ?? "").includes("long-running guard bypassed"))
check("bypass warning names the suppressed-spawn guard", (guardBypassWarnings("node siphon-supervisor.mjs start | Out-Null")[0] ?? "").includes("suppressed-spawn guard bypassed"))
check(
  "bypass warning names the inherited-spawn guard",
  (guardBypassWarnings("Start-Process npm -WindowStyle Hidden -RedirectStandardOutput o.txt")[0] ?? "").includes("inherited-spawn guard bypassed"),
)
check("bypass warning names the orphan-job guard", (guardBypassWarnings("Start-Job -ScriptBlock { Get-ChildItem }")[0] ?? "").includes("orphan-job guard bypassed"))
check("bypass warnings empty for a benign command", guardBypassWarnings("ls -la").length === 0)
check("bypass warning names the wait-loop guard", (guardBypassWarnings("until curl -sf http://localhost:3000; do sleep 2; done")[0] ?? "").includes("wait-loop guard bypassed"))

const longCmd = "npm run dev # " + "x".repeat(250)
const longWarns = guardBypassWarnings(longCmd)
check("bypass warning embeds the command truncated to 200 chars", longWarns.length === 1 && (longWarns[0] ?? "").endsWith(longCmd.slice(0, 200)))

report()
