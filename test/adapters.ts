/**
 * Characterization suite for the 6 harness adapters.
 * Run: bun test/adapters.ts
 */
import { claudeAdapter } from "../src/adapters/claude"
import { codexAdapter } from "../src/adapters/codex"
import { geminiAdapter } from "../src/adapters/gemini"
import { cursorAdapter } from "../src/adapters/cursor"
import { copilotAdapter } from "../src/adapters/copilot"
import { crushAdapter } from "../src/adapters/crush"
import type { NormalizedEvent, Verdict, OutboundDecision } from "../src/types"
import { UNKNOWN_SESSION } from "../src/adapters/shared"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

// --- claude: mapInbound pre ---
const claudePreBash = { tool_name: "Bash", tool_input: { command: "echo hello" }, session_id: "cs-1", tool_use_id: "tu-cla-1", cwd: "/tmp" }
const ce1 = claudeAdapter.mapInbound("pre", claudePreBash)
check("claude pre Bash → tool 'bash'", ce1?.tool === "bash")
check("claude pre Bash → args.command", (ce1?.args as Record<string, unknown>)?.command === "echo hello")
check("claude pre Bash → sessionId", ce1?.sessionId === "cs-1")
check("claude pre Bash → callId", ce1?.callId === "tu-cla-1")
check("claude pre Bash → exitCode null", ce1?.exitCode === null)
check("claude pre Bash → channel 'text'", ce1?.channel === "text")
check("claude pre Bash → output null", ce1?.output === null)
check("claude pre Bash → harness", ce1?.harness === "claude")
check("claude pre Bash → phase", ce1?.phase === "pre")

const claudePreRead = { tool_name: "Read", tool_input: { file_path: "src/foo.ts" }, session_id: "cs-2", tool_use_id: "tu-cla-2" }
const ce2 = claudeAdapter.mapInbound("pre", claudePreRead)
check("claude pre Read → tool 'read'", ce2?.tool === "read")
check("claude pre Read → args.filePath", (ce2?.args as Record<string, unknown>)?.filePath === "src/foo.ts")

const claudePreWrite = { tool_name: "Write", tool_input: { path: "out.txt", content: "hi" }, session_id: "cs-3", tool_use_id: "tu-cla-3" }
const ce3 = claudeAdapter.mapInbound("pre", claudePreWrite)
check("claude pre Write → tool 'write', args.filePath from 'path'", ce3?.tool === "write" && (ce3?.args as Record<string, unknown>)?.filePath === "out.txt")

const claudePreNoToolName = { tool_input: { command: "ls" }, session_id: "cs-4" }
check("claude pre missing tool_name → null", claudeAdapter.mapInbound("pre", claudePreNoToolName) === null)

const claudePreNonObject = 42
check("claude pre non-object payload → null", claudeAdapter.mapInbound("pre", claudePreNonObject) === null)

const claudeSessionEvent = { tool_name: "Bash" }
check("claude session-event → null", claudeAdapter.mapInbound("session-event", claudeSessionEvent) === null)

// --- claude: mapInbound post ---
const claudePostOk = { tool_name: "Bash", tool_input: { command: "echo hi" }, session_id: "cs-5", tool_use_id: "tu-cla-5", tool_response: "hello world" }
const ce5 = claudeAdapter.mapInbound("post", claudePostOk)
check("claude post tool_response string → output", ce5?.output === "hello world")

const claudePostObj = { tool_name: "Bash", tool_input: { command: "echo hi" }, session_id: "cs-6", tool_use_id: "tu-cla-6", tool_response: { stdout: "out", stderr: "err" } }
const ce6 = claudeAdapter.mapInbound("post", claudePostObj)
check("claude post tool_response object{stdout,stderr} → joined output", ce6?.output === "out\nerr")

const claudePostFailure = { tool_name: "Bash", tool_input: { command: "x" }, session_id: "cs-7", tool_use_id: "tu-cla-7", tool_response: "resp", error: "boom" }
const ce7 = claudeAdapter.mapInbound("post", claudePostFailure)
check("claude post PostToolUseFailure appends error after response text", ce7?.output === "resp\nboom")

// --- claude: mapOutbound allow ---
const ao1 = claudeAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("claude mapOutbound allow → json={}, exitCode 0, stderr null", Object.keys(ao1.json as object).length === 0 && ao1.exitCode === 0 && ao1.stderr === null)

// --- claude: mapOutbound deny (exit-2 dialect) ---
const do1 = claudeAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("claude deny → exitCode 2", do1.exitCode === 2)
check("claude deny → stderr = reason", do1.stderr === "[dejavu] BLOCKED")
check("claude deny → json empty", Object.keys(do1.json as object).length === 0)

// --- claude: post never blocks — annotation rides on the already-run call ---
const do2 = claudeAdapter.mapOutbound("post", { action: "deny", reason: "blocked", annotation: null, degraded: false })
check("claude post with no annotation → allowDecision (post never denies)", do2.exitCode === 0 && Object.keys(do2.json as object).length === 0)

const an1 = claudeAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: "NOTE: this is a reminder", degraded: false })
check("claude post annotation wins over deny → additionalContext exit 0", an1.exitCode === 0 && ((an1.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext === "NOTE: this is a reminder")

// the real CLI contract: a post verdict is action:"allow" + annotation
const claudeCli = claudeAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "[dejavu] NOTE: x", degraded: false })
check("claude post allow+annotation (CLI contract) → additionalContext exit 0", claudeCli.exitCode === 0 && ((claudeCli.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext === "[dejavu] NOTE: x")

const claudeTrunc = claudeAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "z".repeat(11000), degraded: false })
check("claude post annotation truncated to 10000", (((claudeTrunc.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext as string).length === 10000)

// --- claude: pre deny → exit-2 dialect ---
const fbPre = claudeAdapter.mapOutbound("pre", { action: "deny", reason: "reason", annotation: null, degraded: false })
check("claude pre deny → denyDecision exit 2 + stderr", fbPre.exitCode === 2 && fbPre.stderr === "reason")

// --- codex: mapInbound pre ---
const codexPreBash = { tool_name: "Bash", tool_input: { command: "npm run build" }, session_id: "xs-1", tool_use_id: "tu-x-1", cwd: "/proj" }
const xe1 = codexAdapter.mapInbound("pre", codexPreBash)
check("codex pre Bash → tool 'bash'", xe1?.tool === "bash")
check("codex pre Bash → args.command", (xe1?.args as Record<string, unknown>)?.command === "npm run build")
check("codex pre Bash → sessionId", xe1?.sessionId === "xs-1")
check("codex pre Bash → callId", xe1?.callId === "tu-x-1")
check("codex pre Bash → exitCode null", xe1?.exitCode === null)
check("codex pre Bash → channel 'text'", xe1?.channel === "text")

const codexPreShell = { tool_name: "shell", tool_input: { command: "ls" }, session_id: "xs-2" }
const xe2 = codexAdapter.mapInbound("pre", codexPreShell)
check("codex pre shell → tool 'bash' (alias)", xe2?.tool === "bash")

const codexPreApplyPatch = { tool_name: "apply_patch", tool_input: { file_path: "f.ts", patch: "diff" }, session_id: "xs-3" }
const xe3 = codexAdapter.mapInbound("pre", codexPreApplyPatch)
check("codex pre apply_patch → passes through unmapped tool", xe3?.tool === "apply_patch")

const codexPreNoToolName = { tool_input: {}, session_id: "xs-4" }
check("codex pre missing tool_name → null", codexAdapter.mapInbound("pre", codexPreNoToolName) === null)

const codexSessionEvent = { tool_name: "Bash" }
check("codex session-event → null", codexAdapter.mapInbound("session-event", codexSessionEvent) === null)

// --- codex: mapInbound post ---
const codexPostStr = { tool_name: "Bash", tool_input: { command: "x" }, session_id: "xs-5", tool_use_id: "tu-x-5", tool_response: "output text" }
const xe5 = codexAdapter.mapInbound("post", codexPostStr)
check("codex post tool_response string → output", xe5?.output === "output text")

const codexPostObj = { tool_name: "Bash", tool_input: { command: "x" }, session_id: "xs-6", tool_use_id: "tu-x-6", tool_response: { stdout: "so", stderr: "se" } }
const xe6 = codexAdapter.mapInbound("post", codexPostObj)
check("codex post tool_response object{stdout,stderr} → joined", xe6?.output === "so\nse")

// --- codex: mapOutbound allow ---
const cao = codexAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("codex allow → exitCode 0", cao.exitCode === 0)

// --- codex: mapOutbound deny (exit-2 dialect) ---
const cdo = codexAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("codex deny → exitCode 2", cdo.exitCode === 2)
check("codex deny → stderr = reason", cdo.stderr === "[dejavu] BLOCKED")

// --- codex: post annotation rides on the already-run call ---
const can = codexAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: "annotated", degraded: false })
check("codex post annotation wins over deny → additionalContext", ((can.json as Record<string, unknown>)?.hookSpecificOutput as Record<string, unknown>)?.additionalContext === "annotated")
check("codex post annotation → exitCode 0", can.exitCode === 0)

const codexCli = codexAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "[dejavu] NOTE", degraded: false })
check("codex post allow+annotation (CLI contract) → additionalContext exit 0", codexCli.exitCode === 0 && ((codexCli.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext === "[dejavu] NOTE")

const codexPostNoAnnot = codexAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: null, degraded: false })
check("codex post no annotation → allowDecision (post never denies)", codexPostNoAnnot.exitCode === 0 && Object.keys(codexPostNoAnnot.json as object).length === 0)

// --- gemini: mapInbound pre ---
const gemPreShell = { tool_name: "run_shell_command", tool_input: { command: "go build" }, session_id: "gs-1", cwd: "/g" }
const ge1 = geminiAdapter.mapInbound("pre", gemPreShell)
check("gemini pre run_shell_command → tool 'bash'", ge1?.tool === "bash")

const gemPreRead = { tool_name: "read_file", tool_input: { file_path: "main.go" }, session_id: "gs-2" }
const ge2 = geminiAdapter.mapInbound("pre", gemPreRead)
check("gemini pre read_file → tool 'read'", ge2?.tool === "read")

const gemPreWrite = { tool_name: "write_file", tool_input: { file_path: "out.go", data: "package main" }, session_id: "gs-3" }
const ge3 = geminiAdapter.mapInbound("pre", gemPreWrite)
check("gemini pre write_file → tool 'write'", ge3?.tool === "write")

const gemPreReplace = { tool_name: "replace", tool_input: { file_path: "a.go", old_str: "x", new_str: "y" }, session_id: "gs-4" }
const ge4 = geminiAdapter.mapInbound("pre", gemPreReplace)
check("gemini pre replace → tool 'edit'", ge4?.tool === "edit")

const gemPreSearch = { tool_name: "search_file_content", tool_input: { pattern: "TODO", files_to_search: ["*.ts"] }, session_id: "gs-5" }
const ge5 = geminiAdapter.mapInbound("pre", gemPreSearch)
check("gemini pre search_file_content → tool 'grep'", ge5?.tool === "grep")

const gemPreNoToolName = { tool_input: {}, session_id: "gs-6" }
check("gemini pre missing tool_name → null", geminiAdapter.mapInbound("pre", gemPreNoToolName) === null)

const gemSessionEvent = { tool_name: "Bash" }
check("gemini session-event → null", geminiAdapter.mapInbound("session-event", gemSessionEvent) === null)

// --- gemini: mapInbound post ---
const gemPostErr = { tool_name: "run_shell_command", tool_input: { command: "x" }, session_id: "gs-7", tool_response: { error: "fail", returnDisplay: "disp", llmContent: "lc" } }
const ge7 = geminiAdapter.mapInbound("post", gemPostErr)
check("gemini post tool_response.error takes priority", ge7?.output === "fail")

const gemPostDisplay = { tool_name: "run_shell_command", tool_input: { command: "x" }, session_id: "gs-8", tool_response: { returnDisplay: "display text" } }
const ge8 = geminiAdapter.mapInbound("post", gemPostDisplay)
check("gemini post fallthrough to returnDisplay string", ge8?.output === "display text")

const gemPostLlm = { tool_name: "run_shell_command", tool_input: { command: "x" }, session_id: "gs-9", tool_response: { llmContent: "llm content" } }
const ge9 = geminiAdapter.mapInbound("post", gemPostLlm)
check("gemini post fallthrough to llmContent string", ge9?.output === "llm content")

const gemPostNull = { tool_name: "run_shell_command", tool_input: { command: "x" }, session_id: "gs-10", tool_response: {} }
const ge10 = geminiAdapter.mapInbound("post", gemPostNull)
check("gemini post empty tool_response → output null", ge10?.output === null)

// --- gemini: mapOutbound allow ---
const gao = geminiAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("gemini allow → exitCode 0", gao.exitCode === 0)

// --- gemini: mapOutbound deny (exit-2 dialect) ---
const gdo = geminiAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("gemini deny → exitCode 2", gdo.exitCode === 2)
check("gemini deny → stderr = reason", gdo.stderr === "[dejavu] BLOCKED")

// --- gemini: post annotation rides on the already-run call ---
const gan = geminiAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: "note here", degraded: false })
check("gemini post annotation wins over deny → additionalContext exit 0", gan.exitCode === 0 && ((gan.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext === "note here")

const geminiCli = geminiAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "[dejavu] NOTE", degraded: false })
check("gemini post allow+annotation (CLI contract) → additionalContext exit 0", geminiCli.exitCode === 0 && ((geminiCli.json as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>).additionalContext === "[dejavu] NOTE")

const geminiPostNoAnnot = geminiAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: null, degraded: false })
check("gemini post no annotation → allowDecision (post never denies)", geminiPostNoAnnot.exitCode === 0 && Object.keys(geminiPostNoAnnot.json as object).length === 0)

// --- cursor: mapInbound pre Family A (shell events) ---
const curPreShell = { command: "cargo test", conversation_id: "conv-1", generation_id: "gen-1", cwd: "/c" }
const cu1 = cursorAdapter.mapInbound("pre", curPreShell)
check("cursor pre SHELL shape → tool 'bash'", cu1?.tool === "bash")
check("cursor pre SHELL → args.command", (cu1?.args as Record<string, unknown>)?.command === "cargo test")
check("cursor pre SHELL → sessionId = conversation_id", cu1?.sessionId === "conv-1")
check("cursor pre SHELL → callId = generation_id", cu1?.callId === "gen-1")
check("cursor pre SHELL → exitCode null", cu1?.exitCode === null)
check("cursor pre SHELL → channel 'text'", cu1?.channel === "text")

// --- cursor: mapInbound pre Family B (CC-compatible) ---
const curPreCC = { tool_name: "Bash", tool_input: { command: "make" }, session_id: "cc-ses-1", tool_use_id: "cc-tu-1" }
const cu2 = cursorAdapter.mapInbound("pre", curPreCC)
check("cursor pre CC shape → tool 'bash'", cu2?.tool === "bash")
check("cursor pre CC → args.command", (cu2?.args as Record<string, unknown>)?.command === "make")
check("cursor pre CC → sessionId", cu2?.sessionId === "cc-ses-1")

const curPreCCRead = { tool_name: "Read", tool_input: { file_path: "z.ts" }, session_id: "cc-ses-2" }
const cu3 = cursorAdapter.mapInbound("pre", curPreCCRead)
check("cursor pre CC Read → tool 'read', args.filePath", cu3?.tool === "read" && (cu3?.args as Record<string, unknown>)?.filePath === "z.ts")

// --- cursor: mapInbound post ---
const curPostShell = { command: "ls", output: "file1\nfile2", conversation_id: "conv-2" }
const cu4 = cursorAdapter.mapInbound("post", curPostShell)
check("cursor post afterShellExecution{output} → output extracted", cu4?.output === "file1\nfile2")
check("cursor post afterShellExecution → tool 'bash'", cu4?.tool === "bash")

const curPostCC = { tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "file content", session_id: "cc-ses-3" }
const cu5 = cursorAdapter.mapInbound("post", curPostCC)
check("cursor post CC → output from tool_output", cu5?.output === "file content")

// --- cursor: unrecognized shape → null ---
const curUnknown = { some_field: "value" }
check("cursor unrecognized shape → null", cursorAdapter.mapInbound("pre", curUnknown) === null)

const curSessionEvent = { command: "ls" }
check("cursor session-event → null", cursorAdapter.mapInbound("session-event", curSessionEvent) === null)

// --- cursor: mapOutbound allow ---
const cau = cursorAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("cursor allow → exitCode 0", cau.exitCode === 0)

// --- cursor: mapOutbound deny (native JSON exit-0 dialect) ---
const cdu = cursorAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("cursor deny → exitCode 0 (native JSON)", cdu.exitCode === 0)
check("cursor deny → json.permission = 'deny'", (cdu.json as Record<string, unknown>)?.permission === "deny")
check("cursor deny → json.agent_message = reason", (cdu.json as Record<string, unknown>)?.agent_message === "[dejavu] BLOCKED")
check("cursor deny → json.user_message present", typeof (cdu.json as Record<string, unknown>)?.user_message === "string")

// --- cursor: post annotation rides on the already-run call ---
const can2 = cursorAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: "cursor note", degraded: false })
check("cursor post annotation wins over deny → additional_context exit 0", can2.exitCode === 0 && (can2.json as Record<string, unknown>)?.additional_context === "cursor note")

const cursorCli = cursorAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "[dejavu] NOTE", degraded: false })
check("cursor post allow+annotation (CLI contract) → additional_context exit 0", cursorCli.exitCode === 0 && (cursorCli.json as Record<string, unknown>)?.additional_context === "[dejavu] NOTE")

const cursorPostNoAnnot = cursorAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: null, degraded: false })
check("cursor post no annotation → allowDecision (post never denies)", cursorPostNoAnnot.exitCode === 0 && Object.keys(cursorPostNoAnnot.json as object).length === 0)

// --- copilot: mapInbound pre camelCase casing ---
const cpA = { toolName: "bash", sessionId: "cp-s-1", toolArgs: JSON.stringify({ command: "curl http://x" }), cwd: "/p" }
const co1 = copilotAdapter.mapInbound("pre", cpA)
check("copilot pre camelCase bash → tool 'bash'", co1?.tool === "bash")
check("copilot pre camelCase → args parsed from toolArgs JSON string", (co1?.args as Record<string, unknown>)?.command === "curl http://x")
check("copilot pre camelCase → sessionId", co1?.sessionId === "cp-s-1")
check("copilot pre camelCase → callId null", co1?.callId === null)

const cpAPowershell = { toolName: "powershell", sessionId: "cp-s-2", toolArgs: JSON.stringify({ command: "Get-Process" }) }
const co2 = copilotAdapter.mapInbound("pre", cpAPowershell)
check("copilot pre powershell → tool 'bash' (alias)", co2?.tool === "bash")

const cpAView = { toolName: "view", sessionId: "cp-s-3", toolArgs: JSON.stringify({ file_path: "v.ts" }) }
const co3 = copilotAdapter.mapInbound("pre", cpAView)
check("copilot pre view → tool 'read', args.filePath", co3?.tool === "read" && (co3?.args as Record<string, unknown>)?.filePath === "v.ts")

const cpAMalformed = { toolName: "bash", sessionId: "cp-s-4", toolArgs: "not json {" }
const co4 = copilotAdapter.mapInbound("pre", cpAMalformed)
check("copilot pre malformed toolArgs → args {} (never throws)", Object.keys(co4?.args as object ?? {}).length === 0)

// --- copilot: mapInbound pre PascalCase casing ---
const cpB = { tool_name: "Bash", tool_input: { command: "dotnet build" }, session_id: "cp-s-5", cwd: "/p2" }
const co5 = copilotAdapter.mapInbound("pre", cpB)
check("copilot pre PascalCase Bash → tool 'bash'", co5?.tool === "bash")
check("copilot pre PascalCase → args.command", (co5?.args as Record<string, unknown>)?.command === "dotnet build")
check("copilot pre PascalCase → sessionId from session_id", co5?.sessionId === "cp-s-5")

const cpBRead = { tool_name: "Read", tool_input: { file_path: "b.ts" }, session_id: "cp-s-6" }
const co6 = copilotAdapter.mapInbound("pre", cpBRead)
check("copilot pre PascalCase Read → tool 'read'", co6?.tool === "read")

// --- copilot: mapInbound post camelCase ---
const cpPostCamel = { toolName: "Bash", sessionId: "cp-s-7", toolArgs: JSON.stringify({ command: "x" }), toolResult: { textResultForLlm: "camel output" } }
const co7 = copilotAdapter.mapInbound("post", cpPostCamel)
check("copilot post camelCase → output from toolResult.textResultForLlm", co7?.output === "camel output")

const cpPostCamelError = { toolName: "Bash", sessionId: "cp-s-8", toolArgs: JSON.stringify({ command: "x" }), toolResult: { textResultForLlm: "ok" }, error: "err msg" }
const co8 = copilotAdapter.mapInbound("post", cpPostCamelError)
check("copilot post camelCase appends error to output", co8?.output === "ok\nerr msg")

// --- copilot: mapInbound post PascalCase ---
const cpPostPascal = { tool_name: "Bash", tool_input: { command: "x" }, session_id: "cp-s-9", tool_response: "pascal output" }
const co9 = copilotAdapter.mapInbound("post", cpPostPascal)
check("copilot post PascalCase → output from tool_response", co9?.output === "pascal output")

// --- copilot: mapInbound postToolUseFailure (adapter handles it despite HookPhase type) ---
const cpPostFail = { tool_name: "Bash", tool_input: { command: "x" }, session_id: "cp-s-10", error: "failure text" }
const co10 = copilotAdapter.mapInbound("postToolUseFailure" as "pre" | "post" | "session-event", cpPostFail)
check("copilot postToolUseFailure → phase 'post', output = error text", co10?.phase === "post" && co10?.output === "failure text")

// --- copilot: unrecognized → null ---
const cpUnknown = { randomField: true }
check("copilot unrecognized shape → null", copilotAdapter.mapInbound("pre", cpUnknown) === null)

const cpSessionEvent = { toolName: "Bash" }
check("copilot session-event → null", copilotAdapter.mapInbound("session-event", cpSessionEvent) === null)

// --- copilot: mapOutbound allow ---
const cpo = copilotAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("copilot allow → exitCode 0", cpo.exitCode === 0)

// --- copilot: mapOutbound deny (native JSON exit-0 dialect) ---
const cpd = copilotAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("copilot deny → exitCode 0 (native JSON)", cpd.exitCode === 0)
check("copilot deny → permissionDecision='deny'", (cpd.json as Record<string, unknown>)?.permissionDecision === "deny")
check("copilot deny → permissionDecisionReason = reason", (cpd.json as Record<string, unknown>)?.permissionDecisionReason === "[dejavu] BLOCKED")

// --- copilot: post annotation rides on the already-run call ---
const cpa = copilotAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: "copilot note", degraded: false })
check("copilot post annotation wins over deny → additionalContext exit 0", cpa.exitCode === 0 && (cpa.json as Record<string, unknown>)?.additionalContext === "copilot note")

const cpLongAnnot = "z".repeat(11000)
const cpTrunc = copilotAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: cpLongAnnot, degraded: false })
check("copilot post annotation truncated to 10000", ((cpTrunc.json as Record<string, unknown>)?.additionalContext as string).length === 10000)

const copilotCli = copilotAdapter.mapOutbound("post", { action: "allow", reason: null, annotation: "[dejavu] NOTE", degraded: false })
check("copilot post allow+annotation (CLI contract) → additionalContext exit 0", copilotCli.exitCode === 0 && (copilotCli.json as Record<string, unknown>)?.additionalContext === "[dejavu] NOTE")

const cpaAbsent = copilotAdapter.mapOutbound("post", { action: "deny", reason: "block", annotation: null, degraded: false })
check("copilot post no annotation → allowDecision (post never denies)", cpaAbsent.exitCode === 0 && Object.keys(cpaAbsent.json as object).length === 0)

// --- crush: mapInbound pre ---
const crPreBash = { tool_name: "bash", session_id: "cr-s-1", cwd: "/cr", tool_input: { command: "rustc main.rs" } }
const cr1 = crushAdapter.mapInbound("pre", crPreBash)
check("crush pre bash → tool 'bash'", cr1?.tool === "bash")
check("crush pre bash → args.command", (cr1?.args as Record<string, unknown>)?.command === "rustc main.rs")
check("crush pre bash → sessionId", cr1?.sessionId === "cr-s-1")
check("crush pre bash → callId null", cr1?.callId === null)
check("crush pre bash → exitCode null", cr1?.exitCode === null)
check("crush pre bash → channel 'text'", cr1?.channel === "text")

const crPreMultiedit = { tool_name: "multiedit", session_id: "cr-s-2", tool_input: { edits: [] } }
const cr2 = crushAdapter.mapInbound("pre", crPreMultiedit)
check("crush pre multiedit → tool 'edit' (alias)", cr2?.tool === "edit")

const crPreNoToolName = { session_id: "cr-s-3" }
check("crush pre missing tool_name → null", crushAdapter.mapInbound("pre", crPreNoToolName) === null)

// --- crush: mapInbound post/session-event → null (structural no-op) ---
const crPostAny = { tool_name: "bash", tool_input: {} }
check("crush mapInbound('post', anyObject) → null", crushAdapter.mapInbound("post", crPostAny) === null)
check("crush mapInbound('session-event', anyObject) → null", crushAdapter.mapInbound("session-event", crPostAny) === null)

// --- crush: mapOutbound allow ---
const cro = crushAdapter.mapOutbound("pre", { action: "allow", reason: null, annotation: null, degraded: false })
check("crush allow → exitCode 0", cro.exitCode === 0)

// --- crush: mapOutbound pre deny (native JSON dialect) ---
const crd = crushAdapter.mapOutbound("pre", { action: "deny", reason: "[dejavu] BLOCKED", annotation: null, degraded: false })
check("crush pre deny → exitCode 0 (native JSON)", crd.exitCode === 0)
check("crush pre deny → version: 1", (crd.json as Record<string, unknown>)?.version === 1)
check("crush pre deny → decision: 'deny'", (crd.json as Record<string, unknown>)?.decision === "deny")
check("crush pre deny → halt: false", (crd.json as Record<string, unknown>)?.halt === false)
check("crush pre deny → reason = verdict.reason", (crd.json as Record<string, unknown>)?.reason === "[dejavu] BLOCKED")

// --- crush: mapOutbound post → degraded no-op (always allowDecision regardless of verdict) ---
const crdp = crushAdapter.mapOutbound("post", { action: "deny", reason: "should not matter", annotation: null, degraded: true })
check("crush post deny → allowDecision (degraded no-op)", crdp.exitCode === 0)
check("crush post deny → json={}", Object.keys(crdp.json as object).length === 0)

// --- crush: mapOutbound session-event → degraded no-op ---
const crdse = crushAdapter.mapOutbound("session-event", { action: "deny", reason: "x", annotation: null, degraded: true })
check("crush session-event → allowDecision (degraded no-op)", crdse.exitCode === 0)

// --- crush: non-object inbound → null ---
check("crush non-object payload → null", crushAdapter.mapInbound("pre", 42) === null)

report()
