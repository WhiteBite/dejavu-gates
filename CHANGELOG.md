# Changelog

## 2.40.0 — 2026-09-28

### Added (one-command installer)
- **`npx -y dejavu-gates install`** auto-detects installed harnesses from config markers (project or `--user` scope), installs project-scope by default. `uninstall` removes only dejavu-managed entries, foreign hooks survive. `hooks --check` drift report: ok / stale (moved clone) / missing / broken. Idempotent merge into each harness's config (foreign hooks/fields preserved), backs every file up to `<config>.dejavu-bak` before mutating, refuses unparseable configs, writes hook commands calling the installed package's CLI directly (never `npx` in the hot path). `bin` entries `dejavu` / `dejavu-gates` point at `bin/dejavu.mjs`. `scripts/install-hooks.ts` is now a thin wrapper over the shared installer.

### Added (native plugin manifests)
- **Claude Code**: `.claude-plugin/plugin.json` + marketplace manifest (`marketplace.json`) + `hooks/claude.json`; resolved via `${CLAUDE_PLUGIN_ROOT}`. Gemini CLI: `gemini-extension.json` + `hooks/hooks.json`; resolved via `${extensionPath}`. Both confirmed spec-correct against published harness specs. Cursor (`.cursor-plugin/plugin.json`) and Copilot CLI (root `plugin.json`) ship as EXPERIMENTAL — their manifest formats are not yet confirmed against official specs; the CLI-hook install path remains the supported route for those two.

### Added (OpenCode V2 host)
- **Dual export from one entrypoint.** `export default { id: "dejavu", setup, server }` loads on BOTH OpenCode lines (`@opencode-ai/plugin` V1 and `@opencode/plugin` V2). V1 calls `server()` → the unchanged `Dejavu` factory (byte-identical behavior); V2 calls `setup(ctx)` → `src/opencode-v2.ts` registers `ctx.tool.hook("execute.before"|"execute.after")` (deny-by-throw; V2's `execute.after` `status:"error"` branch replaces the V1 `message.part.updated` event scan), `ctx.event.subscribe()` for `session.deleted` cleanup, and `ctx.session.hook("compaction")`. `@opencode/plugin` is a TYPES-ONLY devDependency (zero runtime deps preserved — `Plugin.define` is identity, a plain `{id, setup}` object is structurally accepted). `engines.opencode: ">=1.18.29"` makes older V1 loaders skip loudly instead of loading a dead plugin. NOTE: the repeat channel (DashScope consecutive-identical-call 400 prevention) is NOT yet ported to V2 — V2's `session.hook("context")` message model (AI-SDK `tool-call`/`tool-result` parts) differs structurally from V1's `parts[].state` and needs runtime verification; gate enforcement + event channel + compaction all work on V2 today.
- **V2 hook shapes pinned at the type level** against the published `@opencode/plugin@2.0.18` tarball (loader contract verified against upstream `readV1Plugin` + V2 `external.ts` source). Three runtime conventions are type-implied but not yet observed live and are flagged for verification on the first V2 sessions via `log.jsonl`: bash exit codes arriving in `result.metadata.exit`, aborted-call wording matching `isNoiseError`, and annotation mutations of `event.result` propagating to the model-visible transcript.

### Added (tests)
- `test/install.ts` (installer e2e: install/uninstall/`hooks --check`, backup, foreign-hook survival, copilot standalone, `--user`, broken-config) and `test/v2-host.ts` (dual-export characterization: `server()` parity with the V1 `Dejavu` factory, plus a stub-Context invocation of `v2Setup` — registration set, callback smoke, cleanup aborts the event subscription). Both registered in CI + publish workflows.

### Removed
- `legacy/opencode-dejavu/` stub directory (the deprecated npm stub package is published separately; the dir had zero code references).

## 2.39.1 — 2026-09-26

### Fixed
- **`2>&1` no longer reads as backgrounding.** `isDetached`'s standalone-`&` check matched the `&` inside fd-duplication, so a FOREGROUND dev server with stderr merged (`npm run dev 2>&1`) silently evaded the long-running guard and hung the call until timeout. The preceding-character class now excludes `>`; real background forms (`cmd &`, `nohup … 2>&1 &`, `(cmd &)`) are unchanged. Found by the new guards characterization suite.
- **Wait-loop bypasses are now logged.** `guardBypassWarnings` covered 4 of 5 guards — a `# dejavu:proceed` bypass of the wait-loop guard left no trace; it now logs like its siblings.

### Changed (refactoring, behavior-identical)
- `makeOutbound(dialect)` factory encodes the canonical adapter contract once (post never blocks, annotation first; pre denies) — the 2.39.0 pre-release annotation bug class is now structurally impossible; `postChannel` capability flag on `HarnessAdapter` (Crush = false). `createStores()`/`resolveGlobalDir()` dedupe the 5-site store bootstrap. New suites: `test/guards.ts`, `test/messages.ts` (both modules previously had zero direct coverage), `test/helpers.ts` makeChecker extraction — 11 suites, all in CI.

## 2.39.0 — 2026-09-26

### Added (cross-harness port — the plugin is now an engine + hosts)
- **Renamed to `dejavu-gates`** (repo `WhiteBite/dejavu-gates`, npm `dejavu-gates`; old `opencode-dejavu` deprecated with a pointer). dejavu is no longer OpenCode-only: the enforcement core was extracted from `index.ts` into harness-agnostic modules (`src/enforce.ts` + `context/before/after/event/guards/repeat/messages`) with the OpenCode plugin as one host among many. The OpenCode side is behavior-identical (extraction verified branch-by-branch; oracle-reviewed).
- **CLI hook-handler** (`src/cli.ts`): `bun src/cli.ts <pre|post|session-event> --harness <name> [--store <dir>]` reads one hook-event JSON on stdin, runs the SAME engine, writes the harness's decision JSON on stdout. Exit 0 allow / 2 block (stderr = model-visible reason) / 1 usage. Fail-open by contract: malformed stdin, a broken store, or an internal dejavu bug prints `{}` and exits 0 — a gate plugin must never wedge the host's tool pipeline. stdout is pure JSON; diagnostics go to stderr (DEJAVU_DEBUG).
- **Six harness adapters** (`src/adapters/`): Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush. Each maps the harness's native hook payload (field names, tool names, casings, dual payload families like Cursor's shell-events vs CC-compatible and Copilot's camelCase vs PascalCase) to the shared `NormalizedEvent`, and engine verdicts back to the harness's decision dialect (exit-2+stderr for claude/codex/gemini; native JSON deny for cursor/copilot/crush). Canonical outbound contract: **post never blocks** — the call already ran, so a reminding NOTE rides as `additionalContext`/`additional_context` (10k cap where documented); only pre denies.
- **Unified store across harnesses**: every host reads/writes the same `<repo>/.opencode/dejavu/` + `~/.config/opencode/dejavu/` (DEJAVU_HOME overrides). Signatures are harness-neutral (tool names and arg fields normalized before `callSignature`), so a gate learned in Claude Code fires in OpenCode, Cursor, or anywhere else — and vice versa. Cross-process safety is the existing lock design; the remind→block chain lives on the gate, so short-lived CLI processes enforce identically to the long-lived plugin (documented ephemeral-state degradation: repeat-series/pending-calls/dedup-window weaken per-process, gate enforcement does not).
- **`scripts/install-hooks.ts`** + `scripts/templates/*.json`: generates/merges the hook config per harness (`.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`, `.cursor/hooks.json`, `.github/hooks/dejavu.json`, `.crush/crush.json`), project or user scope, `--dry-run` preview. Idempotent (prior dejavu entries removed then re-added), preserves foreign hooks/fields, aborts on unparseable config, Windows-safe `bun "<abs path>"` invocation.
- **Language coverage**: interpreter one-liner fingerprinting for `php -r`, `julia -e`, `lua -e`, `Rscript -e` (with a php-only `-r` guard — node/ruby/perl `-r` is a preload flag and must never fingerprint); `php/julia/lua/rscript` joined WRAPPER_BASENAMES (`php <path>` stays a watching-only family shape). PHPUnit/PHP failure shapes (`There was/were N failure(s)/error(s)`, `FAILURES!`/`ERRORS!`, `Fatal error:`, `PHP Parse/Fatal error`; `PHP Warning` deliberately NOT a failure). New suggestCorrection families: go, cargo, maven/gradle, dotnet, rspec, phpunit/php, make/cmake. New diagnostic verbs (exit-1 immunity + remind-only tier): `mvn test|verify`, `dotnet test`, `phpunit`, `rspec`, `rubocop`, `swift build|test` — producers stay recordable (`mvn compile`, `dotnet build`, bare `mvn` are NOT diagnostics).
- **Test suites**: `test/enforce.ts` (engine characterization incl. the multi-process degradation contract), `test/adapters.ts` (mapping + deny dialects + the real CLI post-annotation contract), `test/cli.ts` (end-to-end: spawn the CLI, seed failures through it, assert promotion → block exit 2, reminding → additionalContext, per-harness deny dialects, fail-open), `test/language-gaps.ts`. CI + publish workflow run all of them.

### Fixed
- **Post-annotation was silently dropped by 4 of 6 adapters** (caught in review before release): an early `action === "allow"` return made the annotation branch unreachable for the CLI's post verdict (`{action:"allow", annotation}`), killing the reminding NOTE on external harnesses. All adapters now check the post annotation before allow/deny, uniformly.
- Uniform deny-reason default (`[dejavu] BLOCKED`) across adapters — a null-reason deny no longer blocks with an empty message.

### Scope (honest matrix)
- Full: OpenCode (plugin, all channels), Claude Code, Gemini CLI, Cursor, Copilot CLI, Codex CLI (hooks fire for Bash only upstream), Crush (PreToolUse only upstream — degraded: pre-channel enforcement + the shared store; no post annotations).
- Not possible: Zed, Aider (no hook API to intercept tool calls).
- Deferred: Windsurf, Amp, Kiro (block-only or fire-and-forget surfaces; no context injection back to the model).

## 2.38.0 — 2026-09-18

### Fixed (correction quality)
- **Timeout-kill corrections now separate the two leak shapes.** A call killed at the timeout hangs because SOMETHING held the stdio pipe (the call ends only on EOF, upstream anomalyco/opencode#29831). The old text assumed a spawn/pipe/redirect call-shape problem. But a normal command (a test suite, a build) whose own completion summary is in the output means the command FINISHED and the leak is a child it spawned that never exited (worker pool, dev server, watch mode — frequently in the code under test). The correction now tells the agent to read the killed run's output and self-classify: completion marker present → fix the child's shutdown, retrying hangs again; no marker → long run, bare + poll separately + explicit timeout near the wall time. (A plugin cannot cancel a running call — the EOF semantics are upstream; the teaching is the reachable surface.)

## 2.37.0 — 2026-09-18

### Added (repeat channel)
- **Windowed repeat detection.** The consecutive-series detector (v2.33.0) mirrors the provider's 400 semantics — but an interleaved loop (analysis/read rounds between retries) never forms a consecutive series while still burning rounds on the identical call (production case: a full 102s test suite re-run for hours against one flaky timeout test). New `detectRepeatWindows` counts a key's occurrences across the last 12 assistant rounds regardless of adjacency; at 3+ with the last one at the tail, the failing output gets a NOTE. NOTE-only by design — never blocks (interleaved rounds are provider-safe), never fires on successful repeats, and stays silent when the failure form is moving (that is debugging, not a stuck loop). Test-suite runs get targeted teaching: the failing file is extracted from the output and the note says to re-run ONLY that file instead of the whole suite. Consecutive tail series never double-annotate (the series path owns them). Events: `repeat-windowed` (damped per session, logged on count growth).

## 2.36.0 — 2026-09-16

### Changed (repeat channel)
- **REPEAT STOP: the Nth consecutive block switches to a hard stop.** Production data: one looping subagent took 303 consecutive REPEAT BLOCKs across 4.7 hours without ever stopping — a plain "change the args" correction does not reach weak models. After `REPEAT_STOP_AFTER` (3) consecutive blocks of the same tail series in one session, the message switches to an imperative stop: do not re-issue, do not rename, do not work around — finish with what you have and report partial results to whoever launched you. The counter lives on the in-process series entry, survives transform rewrites while the same series owns the tail, and resets when a different series takes over. Bypassed (`_dejavu_proceed`) calls never grow it.

## 2.35.0 — 2026-09-15

### Added (iteration discriminator)
- **Iteration vs stuck.** A failure carrying iteration evidence — a landed edit/write since the last failure (process-local workspace version) or a changed error form (parameterized snippets differ, both failure-shaped, neither a bare `exit code N`) — is debugging, not a blind retry. Iteration evidence: skips the recurrence metric (`recurredAfterGate` + reoffense votes), suppresses the reminding NOTE, arms the block chain with the version attached, and lets an edited retry past an armed block (bare retries still block). Pure-iteration evidence never promotes — at least one stuck failure must exist. New gate fields: `iteratedVersion` (workspace version at last failure), `movedOn` (lifetime iterated failures); `failedSessions` entries carry `{ t, v }` (legacy bare numbers coerce and never prove iteration); `retireBaseline` captures `movedOn`.

### Fixed (pre-existing, surfaced by the new tests)
- **Escalation fragmented evidence via a stale key index.** Phase 3c and the flood-guard eviction removed gates with a raw `splice`, leaving `keyIndex`/`enforcedCache` pointing at the removed gate: the pattern's next failure re-landed on the project store as a fresh duplicate, losing accumulated state. Both removals now go through `extract()`. New structural gate `no-raw-gates-splice` (ast-grep, sabotage-tested) forbids raw `splice` on gate arrays in store.ts; smoke pins `byKey()` not returning an extracted gate.

## 2.34.0 — 2026-09-15

### Fixed (one-liner identity + fuzzy cross-class leak — production misfire)
- **Interpreter flags with values no longer break one-liner fingerprinting.** `INTERPRETER_ONELINER` only tolerated bare flags between the interpreter and `-c` — so `python -X utf8 -c "…"` (or `node --import tsx -e "…"`) never fingerprinted, and every such one-liner collapsed into one family signature (`python -x utf8 -c <str>`) shared by unrelated scripts. The flag section now allows long flags and flag+value pairs, with a longest-first lookahead that never swallows the code flag itself.
- **Fuzzy no longer crosses payload classes.** A failed-fingerprint residue shape (`-c <str>`, `-e <str>`, `--eval <str>`, `-command <str>`) is identity-bearing: it joins the `CODE_FINGERPRINTS` exact-match guard, so a one-liner family can never fuzzy-match a plain `<path>` argument or vice versa. Production case: an agent's i18n-verification one-liner got REMINDED by a gate learned from unrelated `python -X utf8 script.py` failures — and the one-liner's own failures were fuzzy-consolidated into that gate's evidence.

## 2.33.0 — 2026-09-14

### Added (repeat channel)
- **DashScope repetitive-call 400 is now structurally impossible.** The provider hard-rejects a payload whose history carries the same tool call (name + args byte-identical) in consecutive assistant rounds, and one rejection poisons the session permanently (the same history ships with every retry; compaction preserves the tail verbatim). The new `experimental.chat.messages.transform` hook scans every outgoing payload statelessly: every occurrence past the first of an identical-consecutive series gets a `_dejavu_repeat` marker (with a uniqueness bump, so a model mimicking markers onto earlier occurrences still yields byte-distinct args) — request-scoped, never persisted; already-poisoned sessions are CURED on the next request (the only cure, since stored history is never rewritten). A series reaching the tail of history gets a `[dejavu] REPETITION` note on its last tool result (the model just looped); a third identical call is hard-blocked in the before-hook (`REPEAT BLOCKED`) with a change-your-args correction. Bypass: `_dejavu_proceed: true` in args (or the bash `# dejavu:proceed` comment), logged as `override`. Detection is pure (`detectRepeatSeries` in patterns.ts): consecutive assistant rounds, parallel duplicates inside one round count once, user messages and missing-key rounds break the run. Events `repeat-detected`/`-sanitized`/`-reminded`/`-blocked` land in the project log, damped to fire only on series growth; analyze.ts summarizes them. No gates, no persistence, no promotion.

## 2.32.0 — 2026-09-14

### Changed (hang guards, audit round)
- **INHERITED-SPAWN daemon-intent markers widened.** `-WindowStyle Minimized` joins `Hidden`, and a known server starter (`SERVER_STARTERS`: `npm run dev`, `vite`, `flask run`, …) as the spawned command counts as outliving the call too — a redirected dev-server spawn in a normal window hangs exactly like the hidden one. Redirected ONE-SHOT spawns stay unflagged (they merely delay the call by the child's lifetime).
- **ORPHAN-JOB guard**: `Start-Job` without an in-call wait (`Wait-Job` / `Receive-Job -Wait`) is interrupted in the before-hook — the job runs inside THIS call's PowerShell and is killed silently when the call ends, so "background" work never survives and nothing reports it. The correction teaches the detached bare-Start-Process pattern (or synchronous wait). `# dejavu:proceed` bypasses (logged).

### Verified (no code change)
- **stdin inheritance is not an independent hang vector**: the probe runs showed ANY `-RedirectStandard*` turns on handle inheritance (all three streams redirected still hangs), while a bare `Start-Process` inherits nothing — the guard already keys on the redirect itself, not on which stream it is.

## 2.31.0 — 2026-09-14

### Added (hang guards)
- **INHERITED-SPAWN guard** — the second leak path of anomalyco/opencode#29831, empirically verified on this machine (4 bounded probe runs): `Start-Process` with `-RedirectStandard*` or `-Wait` turns ON handle inheritance, so the spawned process receives THIS call's stdio pipes among the inheritable handles; opencode ends a bash call only on stdio EOF, so a child that outlives the call (`-WindowStyle Hidden` daemon) hangs the call forever. Redirecting ALL THREE streams does NOT help; a BARE `Start-Process` (no `-Redirect*`, no pipe/redirect on the spawn statement) leaks nothing and returns at once; with a short-lived child the call merely waits its lifetime. The before-hook interrupts `Start-Process … -WindowStyle Hidden` combined with `-RedirectStandard*`/`-Wait`/a pipe/redirect on the spawn statement and teaches the working patterns: spawn BARE and let the daemon write its own logs from inside, or two-stage — an outer bare `Start-Process` of a pwsh one-liner that does the redirecting INSIDE (the intermediary inherits nothing from this call). Both production hangs (`dart capture_server.dart` / `dart machine_driver.dart` with `-RedirectStandardOutput[+Error]`) match the flagged shape; bare hidden spawns and redirect-without-hidden stay unflagged (v1 conservative). `# dejavu:proceed` bypasses (logged).

### Fixed
- **WAIT_LOOP saw through `-Milliseconds`/`-Seconds` spellings.** `Start-Sleep -Milliseconds 500` slipped past the `\s+\d` tail of the while/for rules, so an unbounded `while (-not (Test-Path …)) { Start-Sleep -Milliseconds 500 }` poll hung to the bash timeout unflagged; `Test-Path` also joins the multi-line probe list (file-waiting is the most common polling condition). Bounded `for` loops stay unflagged.

## 2.30.0 — 2026-09-13

Fleet-wide store audit (7 projects, 1389 gates) surfaced systemic over-enforcement and dead-correction classes; every fix below is mechanical and propagates to existing gates via repair/migrate.

### Changed (enforcement tiers)
- **PowerShell read-only probes are diagnostics** (`Get-Process`/`Get-Item`/`Get-ChildItem`/`Get-Content`/`Test-Path`/`Resolve-Path`/`Measure-Object`): their non-zero exit is a probe result (no matching process, missing path), not a failed operation — the `ls` class. Never block, remind at most, exit 1 immune. Production data: a `Get-Process` gate stored the process-list OUTPUT ("78692 dart 02.09.2026 1:10:14") as its "error".
- **Unix read-only viewers never block** (`cat`/`head`/`tail`/`wc`/`less`/`more`, `isUnixViewerSignature`): a read-only habit typed into PowerShell is teachable, not blockable — production data showed `cat <str> | head - <n>` BLOCKING with a generic correction. Unlike diagnostics their exit 1 stays RECORDABLE (a missing file / not-recognized is a real teachable mistake, and the terminal-producer rule for `head`/`tail` is preserved), but they join the remind tier and the correction teaches the PowerShell-native form.
- **Family shapes lost their teeth** (`segmentHasIdentity`): `git commit -m <str>` (the message is always parameterized and staged content is invisible — the gate matched EVERY commit; a pre-commit hook failure banned all commits), `npx tsx|ts-node|esno <str>` (the runner package is the verb, the script is the call), and wrapper run-subcommands (`bun run <str>`) are verb-phrase families: watching only. Concrete arguments keep identity (`git commit src/foo.ts -m <str>`, `npx tsx scripts/x.ts`, `bun run scripts/build.ts`).
- **Diagnostic recurrence exemption**: `recurredAfterGate` no longer grows for diagnostic/iteration signatures — for a test runner or lint, failing again after the note is the iteration itself (fix → rerun → fail), not a failure to teach. Production data: one flutter-test gate reminded 38×, a gradle-test gate recurred 7×, all counted as "not teaching" pressure. Reminders, anti-nag and taught retirement still use `recurredAfterReminder`/`remindedCount`, so nagging gates still retire.

### Fixed
- **Legacy override votes count again.** Gates whose `overrideCount` predates `overrideSessions` tracking (2.28.0) could never reach the distinct-session demotion bar — the array was permanently absent, so 3-5 agent overrides changed nothing. A missing array now falls back to count-only demotion (current hooks always record sessions alongside the count, so absence proves the data is historical). The recurrence vote keeps the strict session requirement — `reoffenseSessions` legitimately stays absent on current data (first-encounter failures never vote).
- **Unix-tool advice without the cmdlet wording.** `suggestCorrection` needed "not recognized" in the snippet to teach the PowerShell-native form, but OpenCode normalizes exits to 1 and stderr often never reaches the output — most real gates sat on a bare `exit code 1` and got the generic text. On Windows, a bare-exit failure on a Unix-only tool (`head`/`tail`/`wc`/`sed`/`awk`/`cut`/`uniq`/`xargs`/`less` — no pwsh alias exists) now gets the native-equivalent correction. `cat`/`grep`/`sort`/`tr` are excluded (pwsh aliases / common installs — their exit 1 may be real).
- **PowerShell table rows are never failure evidence.** `looksLikeSuccess` recognizes process/file/dir-listing data rows (PID + name + locale date-time, `D:\path\file  dd.mm.yyyy HH:MM:SS`, `-a---- …` mode rows), so probe output can no longer be quoted as a gate's "Last error".
- **Doctor MISSED ESCALATION no longer fires on orphans.** An index key with 2+ projects whose gate exists in NO scope is an INDEX ORPHAN (already reported, pruned by `--repair`) — reporting it as "not global" was a contradiction; there is nothing to escalate.
- **Doctor STALE-CORRECTION pathology**: an enforced gate whose correction teaches a file-not-found error while the quoted path EXISTS again cannot recur — the gate nags about a dead error (production: `check_layers.py` reminded 28× quoting "can't open file"). Reported per scope; `--repair` retires such gates softly (`retireTaught` — damped re-promotion, a genuinely-returning pattern earns a fresh bar and a fresh correction).

## 2.29.0 — 2026-09-12

### Fixed (correction quality)
- **Timeout kills teach the right lesson.** A bash call killed at its timeout (`shell tool terminated command after exceeding timeout …`) now outranks command-family guesses in `suggestCorrection`: the correction says the call SHAPE is the problem — spawn/pipe/redirect shapes must run bare and poll status separately (an orphaned descendant holds stdio; the call ends only on stdio EOF), and genuinely long runs need an explicit per-call timeout near the expected wall time. Companion to the 2.28.0 SUPPRESSED-SPAWN guard: the hang family now teaches from its own recurrence evidence too. Verified live on opencode 1.18.30: the shape hangs past shell exit, the default 120s timeout kills the tree, and `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` caps calls without an explicit timeout. Real fix pending upstream: anomalyco/opencode#42756.

## 2.28.0 — 2026-09-10

### Added (proactive guards)
- **SUPPRESSED-SPAWN guard** — compensating measure for anomalyco/opencode#29831 (+ #42756); **remove it when the upstream fix ships**. opencode ends a bash call only on stdio EOF, so a call that spawns a detached daemon while piping/redirecting stdout (`… start | Out-Null`, `… start > $null`) hands the open pipe to the living daemon and hangs forever. A static, bounded list of known spawn commands (`DETACHED_SPAWNERS`, v1: `siphon-supervisor.mjs start|restart`) is interrupted in the before-hook with the correction "run the spawn bare — it prints 1-3 lines — and poll status in a separate call". Bare spawns, non-spawn verbs (`stop`/`status`), and stderr-only redirects (`2>`, `2>&1`) pass; `# dejavu:proceed` bypasses (logged).

### Fixed (concurrency + persistence safety)
- **Same-process critical sections serialize on an in-process queue before the file lock.** Parallel tool calls in ONE window used to poll the file lock for 3s and then degrade to unlocked — losing updates exactly when two sections raced (e.g. a 3s+ section under a flood). The degrade path is now cross-process only.
- **A transiently-unreadable store no longer reads as empty.** `load()`/`loadIndex()` distinguish ENOENT (legitimately absent) from other read errors (EISDIR/EPERM/AV lock → throw, fail-open at the hook level), so a failed read can never let the next `save()` clobber real gates.
- **Override demotion needs two distinct sessions.** One stubborn or prompt-injected session can no longer disarm a blocking gate for everyone: overrides now track `overrideSessions` and `DEMOTE_OVERRIDES` (3) must span `DEMOTE_OVERRIDE_SESSIONS` (2) distinct sessions — mirroring the reoffense-session rule.
- **Every failure indexes cross-project evidence.** The old churn gate skipped first-time (`count < 2`) failures, so a pattern failing once per project across N projects — the canonical agent habit — could never reach the global store.
- **Slow recurrences can promote again.** The 7-day noise TTL now applies only to never-recurred one-offs (watching, count ≤ 1); a twice-seen pattern gets the full 60-day TTL even below the promotion bar.
- **The before-hook signature fallback covers ungated calls.** `pendingCalls` is recorded before the gate lookup, so an after-hook arriving without args records NEW patterns too, not just gated ones.
- **Chain-bypass protection covers command substitutions.** `bashSegmentSignatures` unfolds `$(...)` and backtick payloads (both shells expand them, including inside double quotes), so a gate fires when the gated command hides in a substitution.
- **Fuzzy flood path is capped.** `levenshteinCapped` early-exits a DP row whose minimum provably exceeds the ratio bar — verdicts identical to full Levenshtein (property-tested against the reference), without the per-gate cost cliff under the lock.
- **Log-lock degradations are logged** (`degraded` event on `log.lock`), like gates/index locks already were.

### Changed (internal API)
- `load(true)`/`loadIndex(true)` are gone: the write-capable read is named `loadForMutation()`/`loadIndexForMutation()` (the capability is in the name, not a boolean flag). Enforced by the new `no-load-force-flag` ast-grep gate in CI (`bun run lint:ast`).
- Taught/anti-nag retirement mutations are shared (`retireTaught`/`retireAntiNag`); the tier-specific conditions stay at the hook call sites.

## 2.27.0 — 2026-09-08

### Changed (friction + signal-to-noise)
- **Heal-aware blocking first encounter.** A blocking gate with recent consecutive successes (`succeededAfterGate > 0` — the command is being fixed) no longer aborts the first run of a session; it arms the remind→block chain silently and lets the call run. A success keeps healing; a repeat failure still blocks. This removes the last false-positive interrupt class (a stale blocking gate nagging a command that already works, e.g. the `cli start` case) without weakening blocking for commands that are genuinely still broken.
- **Doctor NOT TEACHING now flags only blocking gates.** A recurring reminding/diagnostic gate (gradlew test, flutter test, vitest) is normal iteration — the failure IS the work — not a teaching failure; flagging it was noise. A recurring blocking gate is the real "correction isn't working" signal.

## 2.26.1 — 2026-09-08

### Fixed (snippet evidence for bare-exit failures)
`failureSnippet` no longer falls straight to a bare `exit code N` when a failed command's output has no failure-shaped line: it now returns the last NON-success line (a success-shaped tail is still never surfaced). Gates on gradle/flutter/etc. that previously taught nothing now carry real context. Existing bare-exit gates pick up the better snippet on their next recurrence.

## 2.26.0 — 2026-09-08

### Fixed (correction quality — what dejavu actually tells agents)
A store audit of enforced gates surfaced three systemic advice defects; the two mechanical ones are fixed and propagate to existing gates via repair:

- **Unix-tool-in-PowerShell advice.** A large share of recurring gates were `… | head`/`tail`/`cat`/`wc` failing because those are Unix tools, not PowerShell commands. The captured snippet was the PowerShell boilerplate tail (`Check the spelling of the name…`), which the Unix rule in `suggestCorrection` never matched (it looked for "not recognized"). The rule now also matches the boilerplate tail and covers `cat`/`grep`/`less`; the correction teaches the native equivalent (`Select-Object -First/-Last`, `Get-Content`, `Select-String`, `(Get-Content f).Count`). Existing gates are re-derived on repair (6 upgraded in the audit).
- **Success/banner-shaped snippets are no longer stored as failure evidence** — gradle task summaries (`N actionable tasks: …`), `Configuration cache entry …`, and the `Node.js v<ver>` crash-tail banner join `looksLikeSuccess`, so they are cleared at the boundary instead of being quoted as the "error".
- **`repairGate` re-derives machine-made (AUTO_TEMPLATE) corrections on every repair**, not just when the quote is success-shaped — `suggestCorrection` upgrades now reach old gates. Human/agent edits never match the template byte-for-byte and are untouched.

### Known limitation (not mechanical)
Gates whose only evidence is a bare `exit code N` (no error line captured) still get the generic correction — there is nothing to teach from. 28 such gates in the audit; improving this needs better snippet capture or a non-mechanical step.

## 2.25.0 — 2026-09-08

### Added (self-maintenance: the remaining manual `--repair` work now runs itself)
- **Index orphans prune automatically (time-decayed candidacy).** The only fleet-wide operation a single plugin process could not safely do was pruning an index key whose gate lives in a project it cannot see. Now `expireAll` marks a key absent from every visible scope (own project + global) with `orphanCandidateSince`, clears it the moment any scope holds the gate again, and prunes only after `ORPHAN_CANDIDATE_DAYS` (7) of continuous absence — a live gate in another project clears its own candidacy on that project's sweep, so no cross-project evidence is lost in practice. `doctor --repair` remains the authoritative full-fleet sweep; the candidacy path removes the day-to-day need for it.
- **Startup health event.** Init logs a `health` event to the project log when enforced gates are NOT TEACHING (`recurredAfterGate >= 3`) or review-flagged, instead of letting them accumulate silently.

### Changed
- **`git status` is a diagnostic** (joins `git show|log|ls-tree|ls-files|blame|diff`): read-only, its exit 1 is a downstream filter finding nothing, so it can never block and its exit 1 is immune. Existing blocking `git status` gates demote to reminding on repair.
- **`DEMOTE_OVERRIDES` 5 → 3.** An agent that bypasses a gate 3 times is fighting it — demote sooner. Gates already past the bar demote on the next repair.

## 2.24.1 — 2026-09-05

### Readiness-poll hang: port hint + multi-line wait-loop detection
A subagent started vite detached correctly but vite picked a FREE port (strictPort off) while the readiness poll / playwright waited on the configured port → hang. The long-running reminder now says: read the ACTUAL port from the server's startup log (don't assume the configured port), poll THAT port. Also WAIT-LOOP now catches multi-line PowerShell loops (`while ($true) { … Start-Sleep … }` across lines), which the single-line regexes missed.

## 2.24.0 — 2026-09-05

### Close the remaining subagent-hang vectors (deep-research driven)
Three research agents (oracle design, librarian on OpenCode bash internals, empirical gap probe) enumerated every way a bash call still hangs. Fixed the high-value, low-false-positive gaps:
- **More starters**: `docker compose up` / `docker run` (without `-d`, `run` constrained to `-p/-it`), `node --watch`, `bun --watch`, monorepo `yarn workspace <name> dev`, Python server entrypoints (`python app.py|server.py|main.py|wsgi.py|asgi.py`). Ambiguous `go run`/`cargo run`/`dotnet run`/`make` stay excluded by design.
- **`isDetached` hardened** (these were silently treated as detached but actually block): `& … wait`, `nohup X` without `&`, `Start-Process … -Wait` / `-NoNewWindow`.
- **New WAIT-LOOP guard**: polling loops (`while/until/for` + `sleep`/`Start-Sleep`, or `while (Test-Connection/Invoke-WebRequest) {`) with no timeout hang until the bash timeout; the reminder now pushes `curl --max-time N` / `-TimeoutSec N` / a max-iteration `break`.
- **Bypass visibility**: a `dejavu:proceed` bypass of the long-running guard now logs a warning, so "why did my subagent hang" is answerable after the fact.
- Confirmed from OpenCode source: bash stdin is `ignore` (interactive prompts fail fast on EOF, they don't hang), there is no model-facing background-job or PTY tool, and the 2-min (max 10-min) timeout with SIGTERM→SIGKILL is the only native hang cap — so proactive detection in the plugin is the right layer.

## 2.23.3 — 2026-09-05

### Long-running reminder is now actionable (stop agents giving up on e2e)
A subagent refused browser/e2e verification because starting the dev server seemed impossible (foreground is interrupted by the guard; a `start-dev.ps1` wrapper hangs). The guard was right to interrupt, but its reminder didn't hand the agent a working path, so it gave up instead of switching to detached. The reminder now includes a concrete detached recipe per shell (`Start-Process npm -ArgumentList 'run','dev'`, `Start-Process powershell -ArgumentList '-File','start-dev.ps1'`, `nohup … &`, `tmux new-session -d`) and the e2e workflow (start detached → poll the port → run tests → kill). Note: `.ps1`/`.sh` wrappers are deliberately NOT matched by name — a filename can't tell a detached starter (`start-backend.mjs`) from a foreground one, so name-matching would be a coin flip.

## 2.23.2 — 2026-09-05

### False-positive visibility (`doctor` OVERRIDDEN section)
Every `dejavu:proceed` override is the agent explicitly voting "this gate is wrong / friction." `doctor` now surfaces an **OVERRIDDEN** section listing gates with `overrideCount > 0`, sorted by overrides, and counts how many are **still enforced** (those are live false positives / friction and raise the issue count). Watching ones are history (already feedback-demoted); still-enforced ones (e.g. a `blocking` gradle pipeline the agent keeps overriding) are the actionable false positives. This makes "what is dejavu falsely nagging on?" a one-command answer, alongside the existing STALE-BLOCKING / FEEDBACK-DEMOTED / ANNOYING / NOT-TEACHING sections.

## 2.23.1 — 2026-09-05

### Long-running guard hardening (agent-driven combination sweep)
Two agents (a librarian survey of real starter/detach idioms across ecosystems + an empirical probe over ~60 command combinations) stress-tested the 2.23.0 guard and surfaced 14 false positives and 16 false negatives. Fixed the high-value, low-risk ones:
- **Starters added** (canonical, unambiguous): `npm|yarn|pnpm|bun start`, `ng serve`, `manage.py runserver` / `django-admin runserver`, `php artisan serve`, `jupyter lab|notebook`, `webpack serve|webpack-dev-server`, `http-server|live-server`, `dotnet watch`, `hugo server`, `jekyll serve`, `mkdocs serve`, `mix phx.server`, `iex -S mix`, `nodemon`, `expo|react-native start`, `ollama serve`.
- **False positives fixed**: `pip install uvicorn gunicorn` no longer reads as starting a server (uvicorn/gunicorn now require a module:var or flag arg); `cat vite.config.ts` / `npm run build:vite` no longer match `vite` as a filename/`build:` target; `vite build --watch` now warns (watcher).
- **Detach detection broadened**: `screen -dm`, `pm2`, `Start-Job`, `forever`, `daemonize`, `systemd-run`, and a standalone `&` anywhere (trailing, mid-chain, or closing a subshell) — while `&&` chains still warn.
- **Read-only git inspectors are diagnostics** (`git show|log|ls-tree|ls-files|blame|diff`): a live subagent was interrupted by a blocking gate on `git show … | Select-String`, whose exit 1 is just the downstream filter finding nothing. These now promote to `reminding` at most; real git errors exit ≥ 2 and still count. Existing blocking `git show | …` gates were demoted by `doctor --repair`.
- Known limitations remain by design: ambiguous `node <file>`, `go run`, `dotnet run` are not flagged; mention-vs-execution (`grep 'npm run dev' Makefile`) can still warn — `# dejavu:proceed` escapes.

## 2.23.0 — 2026-09-05

### Long-running command guard (interrupt BEFORE the hang)
Agents and subagents sometimes start dev servers / watchers in FOREGROUND bash (`npm run dev`, `node server.js`, …). OpenCode's bash tool is one-shot (default 2-min timeout), so the call blocks until timeout, burns tokens, and strands an orphan process; native background-bash was removed from V2 and PTY/tmux are behavior, not enforcement. dejavu now interrupts a foreground server start in the before-hook with a "run detached" reminder (tmux / `nohup … &` / `Start-Process` / a startup script that spawns detached and returns).
- **Static, bounded class** — unlike open-ended error detection, the set of server starters is small and recognizable (`npm|yarn|pnpm|bun run dev|serve|watch`, `next|nuxt|astro dev`, `vite` (not build), `flask|streamlit run`, `uvicorn|gunicorn`, `python -m http.server`, `mvn spring-boot:run`, `gradle bootRun`, `rails s`, `php -S`), so it warns on first sight rather than learning from an expensive hang.
- **Detached forms pass silently** — trailing `&`, `nohup`, `setsid`, `disown`, `Start-Process`, `tmux new-session`, `start /b`. One-shots and builds (`vite build`, `npm run build`) are never flagged; ambiguous `node <file>`, `go run`, `dotnet run` are deliberately excluded.
- **`# dejavu:proceed`** remains the escape hatch for a deliberate foreground run.

## 2.22.1 — 2026-09-05

### Noise boundary — two more infra classes, both non-bash tool errors
A post-release sweep of the live stores surfaced two more server-side-unavailability patterns that had accumulated as gates (the playwright one at 10x/10 sessions, the LSP one at 10x/6). Both are non-bash tool errors, so they could only ever `watch` — classifying them noise removes clutter with zero teaching lost.
- **Closed-browser automation errors** (`target page, context or browser has been closed`) — a transient startup/state hiccup fixed by relaunching, not an agent habit.
- **LSP diagnostics timeouts** (`timed out waiting for fresh diagnostics … within 3000ms`) — the LSP was slow to answer, a latency hiccup, not a mistake.
- Retroactive: `doctor --repair` expired the accumulated gates (both were non-bash `watching` gates in the global store).

## 2.22.0 — 2026-09-04

### Theme
Root-cause pass over the accumulated store data — 1481 gates across 7 stores analyzed by `analyze`+`doctor`, then reviewed by explore/oracle/kimi3-verifier/Momus. The stores had been faithfully remembering the WRONG things: success lines as errors, infrastructure noise as failures, and whole command families as specific calls. This release fixes evidence quality, the noise boundary, and attribution integrity — what we remember, not just how we remember it.

### Evidence quality (the "17 passed" bug)
- **`failureSnippet` is error-aware.** For a non-zero exit it now scans from the END for a failure-shaped line instead of blindly keeping the last non-empty line. A success-shaped tail ("17 passed (3.1m)", "1 passed (50.1s)") is never returned as failure evidence; when only success lines remain it falls back to `exit code N`. Chained commands and `Select-Object -Last N` pipelines put another shard's pass summary at the tail — that was teaching gates to "fix" a passing summary.
- **`looksLikeSuccess` / `looksLikeFailure`** are the shared evidence-quality classifiers. A line that reports failures is never success, even when it also tallies passes ("1 failed, 1780 passed").
- **`FAILURE_SIGNATURES` gaps closed:** the PowerShell "is not recognized as the name of a cmdlet" wording (only the cmd wording matched, so head/tail/wc gates stored the "Check the spelling" boilerplate), bare runner summaries `[1-9]\d* failed` (pytest/playwright/vitest), `no tests found/matched`, and the generic `^error:` prefix.
- **Evidence monotonicity:** `recordFailure` never overwrites a failure-shaped snippet with a success-shaped one (latest still wins between two failure-shaped snippets).

### Cross-language generalization (detection is an engine, not a JS/Python list)
An adversarial cross-ecosystem probe (librarian ground truth for 22 tools + an empirical battery + an independent verifier) showed the v2.22.0 evidence engine was tuned to the JavaScript/Python/PowerShell formats seen in production: Go `--- FAIL:` / `exit status 1`, Maven `[ERROR] BUILD FAILURE`, RSpec/Elixir/minitest `N failure(s)`, dotnet `Failed! - Failed: N` (reversed order), PHPUnit `FAILURES!`, sbt `*** TEST FAILED ***` were all undetected, so their gates degraded to a useless `exit code 1` correction. The fix is language-agnostic, not per-tool enumeration:
- **Failure vocabulary generalized by shape, not by tool:** count-bearing failure forms now match with a NON-ZERO count in EITHER order (`1 failed` / `Failed: 1` / `Failures: 1` / `failures=N`), covering every runner's summary; build-status words that never appear in a pass summary (`BUILD FAILURE|FAILED`, standalone uppercase `FAIL`, `TEST(S) FAILED`); compiler prefixes that carry a bracket (`error[E0308]:`, `[ERROR]`); Go `exit status N`; TAP `not ok`.
- **Success invariant is substring-based, not line-start:** decorated/embedded pass summaries (`==== 10 passed ====`, `test result: ok.`, `BUILD SUCCESSFUL`, `OK (N tests)`, Go `ok\tpkg`, dotnet `Passed!`/`Build succeeded.`) are all rejected as evidence. The non-zero-failure guard (`1 failed`, `Failed: 1`) runs first, so a `0 failed` pass tally can never read as a failure — the "17 passed" bug cannot recur in any ecosystem's clothing.
- **Leading runner decorations** (`====`, `---`, `[info]`) are stripped before matching, so a pattern need not anticipate every tool's framing.
- Regression battery locks it: 15 ecosystems' failing outputs must yield a real evidence line (never `exit code 1`), and every ecosystem's pass summary must be rejected.

### Correction integrity
- **`suggestCorrection` never quotes a success-shaped snippet as "Last error"** — it produced `Last error: "17 passed (3.1m)"`. Bare `exit code N` is no longer quoted either.
- **New correction families:** Unix commands in PowerShell (head/tail/wc → `Select-Object -First/-Last`, `(Get-Content).Count`), file-not-found for read/edit/write (locate via glob, don't guess path variants), and command-not-installed.
- **`repairGate` heals legacy evidence at the persistence boundary:** clears success-shaped snippets and re-derives a machine `Last error: "…"` template correction that quoted a success line. Human edits never match the fixed template byte-for-byte and are untouched.

### Noise boundary (server-side unavailability is not an agent mistake)
- **`NOISE_ERRORS` extended:** LSP daemon unreachable, MCP transport / streamable-http errors, webfetch non-2xx, and webfetch/gRPC `transport error` (the connection itself never completed). Client-side mistakes (4xx, ENOENT, syntax) stay teachable.
- **`isNoiseError` now guards the after-hook too** (it guarded only the event channel), so infra noise grows no gate from either channel.
- **Retroactive cleanup:** `migrate()` backdates already-classified noise gates to the epoch so the TTL sweep expires them (the accumulated lsp-daemon / webfetch / MCP-noise gates).

### Attribution integrity (the playwright-count-56 bug)
- **Chain attribution applies only with exactly ONE non-transparent producer.** With several producers the exit code does not say which one failed, so attributing the failure to a known segment fabricated evidence — a diagnostic segment's gate inflated by a non-diagnostic producer's failure. Such chains now record under the whole call. New `nonTransparentProducers` counts the producers (navigation, env assignments, start-sleep, pipe-tail formatters are transparent).

### Immunity holes closed
- **Env assignments (`$env:CI="true"`, `FOO=bar`) and `start-sleep` are transparent** — they cannot be the failing producer, so they no longer break a diagnostic's exit-1 immunity or attribution.
- **`npm run check:*` / `verify:*` are diagnostics** — like test/typecheck/lint, their exit 1 is "found issues", not an infrastructure error.
- **Flag-only wrapper shapes lose residual identity** — `cmd <path> <str> -f` matches a whole command family (a flag is a switch, not call identity) and may only watch.

### Lifecycle & observability
- **Reminding taught retirement** — a diagnostic gate reminded `TAUGHT_REMINDERS`+1 times with zero same-session reoffense retires softly to `watching` (no `feedbackDemoted`), logged `retired-taught`. The bar is one clean reminder above the blocking threshold so it never preempts anti-nag evidence. `recurredAfterGate` is no signal here (it grows structurally for reminding gates — every session's first failure counts, the note rides after it).
- **`promotionCount` lifetime counter** — incremented on every promotion, never reset, summed by `mergeGate`, parsed by `coerceGateShape`. Doctor's FLAPPY escalates to an issue at `promotionCount >= 3` (rot-proof oscillation evidence; the log-based FLAPPY rots with rotation). Report-only — no mechanical auto-demotion.
- **`lastInitVersion` drift signal** — `save()` stamps the WRITER's own version into gates.json on every save; doctor reads it first (log init events rotate away). Fixes the "version indeterminate" blind spot on busy logs.
- **`migrate(force)` for explicit repair** — `doctor --repair` and `bun scripts/migrate.ts` now force the full per-gate migration regardless of the version stamp. The init-storm skip is a startup optimization; an explicit repair must apply ALL healing, otherwise a same-version re-run of `--repair` silently skips newly added repair logic.

### Data
- Ran `doctor --repair` across all 7 stores: pruned true-orphan index keys, stamped `lastInitVersion`, expired noise gates (lsp-daemon / webfetch non-2xx / grep-app / transport-error), demoted flag-only / success-evidence gates. Post-repair invariant verified: no enforced gate carries a success-shaped snippet or a garbage template correction.

## 2.21.0 — 2026-09-03

### Changed (reminding gates never interrupt — "help, don't nag" completed)
Two production screenshots showed the same root problem: a reminding (diagnostic) gate aborted the call with a reminder and hid the output, nagging with stale evidence (`flutter test` after the immunity fix; a `dart analyze`+`custom_lint` chain whose "103 issues" predated a cleanup). The reminding tier existed to protect iteration, yet aborting the run was itself punishment for iterating. Now:

- **Reminding gates never abort.** The before-hook lets `reminding`-tier calls straight through; the reminder is delivered as a non-blocking `[dejavu] NOTE` appended to the FAILING output in the after-hook, once per session (a repeat same-session failure only accrues `recurredAfterReminder`, no second note). A run that succeeds produces no note at all — so the stale-evidence nag disappears entirely. Blocking gates are unchanged (remind-abort on first encounter, hard block on same-session repeat).
- **Anti-nag retirement for reminding gates accrues in the after-hook** — a gate reminded `ANTI_NAG_REMINDERS` (5) times whose notes are consistently ignored (`recurredAfterReminder >= ANTI_NAG_REOFFENSE` (3)) retires to `watching` + `feedbackDemoted`, logged `demoted` ("anti-nag retirement"). Taught retirement deliberately does not apply to reminding gates (a failure event cannot prove a reminder taught anything).
- **`repairGate` zeroes a stale `recurredAfterReminder` at the blocking→non-blocking demotion transition only** (was: on every load). The counter now accrues legitimately while reminding, so the unconditional reset would have wiped it inside every store lock; tying it to the transition keeps the "no retirement on the previous tier's evidence" guarantee.

## 2.20.0 — 2026-09-03

### Fixed (residual immunity blind spots found in post-restart production data)
Re-checked the stores after the 2.19.0 restart: immunity held for 27 of 30 post-restart diagnostic failures, but three residual shapes still gated ordinary iteration work. All three closed:

- **`cd` + diagnostic in one segment no longer dropped as navigation** — `cd packages/foo npx vitest run …` (no separator between the path and the command) was dropped wholesale as navigation, hiding the diagnostic and breaking immunity. Navigation is now transparent only when the segment is PURE navigation; a segment pairing a nav verb with a diagnostic keeps the diagnostic. A bare `cd /bad/path` still counts (not immune).
- **Subshell-paren flattening no longer breaks PowerShell script blocks** — `Select-String … | ForEach-Object { $_.line.trim() }` was gated because the blanket `()→;` flatten split the `.trim()` method-call parens inside the `{ }` script block. New `flattenSubshellParens` flattens parens only OUTSIDE `{}` braces and quotes, so method-call parens stay part of their segment while `(deploy && grep)` still splits (a diagnostic nested in parens must not blanket-immunize a non-diagnostic).
- **`npm/pnpm/yarn` `typecheck`/`lint` are diagnostics** — production `npm run typecheck` was reminded 20+ times because only `test` was recognized; `typecheck`/`lint` join it, including the flags-between form (`pnpm --filter <pkg> typecheck`). `npm run build` stays non-diagnostic (a build failure is a real error, not the work).

### Note (deliberate non-goal)
The point of these fixes is NOT to enumerate every command in every language — that is whack-a-mole. The durable design is (a) cover the common iteration commands broadly and (b) let anti-nag retirement self-correct anything that still slips through and nags. Both are now in place.

## 2.19.0 — 2026-08-31

### Fixed (closing the verifier's remaining blind spots — "help, don't nag" cleanup)
The 2.18.0 `kimi3-verifier` review confirmed ship-ready but listed five pre-existing blind spots. Three were safe and worth closing; two are deliberately left (see Notes).

- **Bash `|&` (pipe stdout+stderr) is now a pipe separator** — `npm test |& head -5` was counted instead of immune because the `&` glued onto the next segment (`& head -5` misses the anchored formatter regex). Both `splitChain` and `splitChainTagged` now consume `|&` as a 2-char pipe, so the tail is a pipe-tail formatter and the diagnostic keeps immunity.
- **Unix `tee` added to the pipe formatters** — only `tee-object` was recognized, so `npm test | tee out.log` counted. `tee` (a pass-through that exits 0) is now transparent in pipe-tail position; a standalone `tee` producer still counts.
- **Stale `recurredAfterReminder` cleared on tier demotion** — the counter accrues only while blocking, but a policy demotion (e.g. a legacy blocking `npm test` gate demoted to reminding when it became diagnostic) left the stale value, which blocked taught-retirement (needs it `=== 0`) and let the gate nag until TTL. `repairGate` now zeroes it once the gate is no longer blocking, letting such gates taught-retire softly. Regression tests split the two outcomes by `recurredAfterGate`.

### Notes (two verifier blind spots deliberately NOT fixed)
- **Single `&` is not treated as a chain separator** — on Windows `&` is the PowerShell **call operator** (`& "C:\…\exe" args`), so splitting on it would break those invocations. Bash-style backgrounding (`A & B`) is rare in agent commands here; leaving it unsplit is the correct call, not a gap.
- **Manually re-enforced gates keep old session chains** — re-enforcement is a human edit of `gates.json`; the mechanical path (promotion) clears chains, and a human can clear the arrays too. Documented behavior, not a defect.

## 2.18.0 — 2026-08-31

Theme: **the plugin should help, not nag** — finish closing the immunity blind spots and stop interrupting when interrupting provably does nothing.

### Fixed (production-data follow-up: the immunity fix had a formatter blind spot)
Re-ran doctor/analyze on the accumulated stores after 2.17.0 and found a live case the immunity still broke: `cd <path> && npx vitest run … >& <n> | head - <n>` (MidasAI). 2.17.0 made the **PowerShell** pipeline formatters (`Select-Object`, `Tee-Object`, …) transparent, but not the **unix** output shapers — so piping a diagnostic into `head`/`tail`/`column`/`uniq` still counted the ordinary test failure.

- **Unix output shapers added to the transparent formatters** — `head`, `tail`, `column`, `uniq` join the PowerShell cmdlets in `PIPE_FORMATTERS`. Piping a diagnostic into one keeps its exit-1 immunity; a non-diagnostic piped into a formatter still counts (`npm install | head -5` still gates), and a bare formatter as the producer still gates.
- **Formatter transparency is pipe-position only** — an independent review (`kimi3-verifier`) refuted the first cut, which was separator-blind and over-granted: `npm test && tail -5 missing.log` became immune even though `npm test` exits 0 under `&&` and the exit 1 is `tail`'s file-not-found (a real recurring mistake). Transparency now applies only to segments `splitChainTagged` marks as **pipe tails** (`|`); a formatter as a `;`/`&&`/`||` terminal producer is the failing producer and its exit still counts.

### Added (anti-nag retirement — the negative twin of taught retirement)
- **Anti-nag retirement** — a **blocking** gate reminded `ANTI_NAG_REMINDERS` (5) times whose advice is consistently ignored (`recurredAfterReminder >= ANTI_NAG_REOFFENSE` (3): the agent reoffends in-session right after being reminded) is nagging, not teaching. On the next first-encounter it retires to `watching` + `feedbackDemoted`, the call proceeds **without** a reminder, and the event is logged (`demoted`, "anti-nag retirement"). Mirrors taught retirement (same hook point, same lock, first-encounter only) but marks `feedbackDemoted` so it does not mechanically re-promote into the nag loop; a human can re-enforce manually. Two guards the independent review forced: (1) `status === "blocking"` in the condition — `recurredAfterReminder` accrues only while blocking but a tier demotion keeps the stale counter, so a reminding/diagnostic gate demoted from a legacy blocking one must not be retired on someone else's old evidence; (2) the counters are **reset on fire**, so a manual re-enforce gets a genuinely fresh start instead of instantly re-triggering.

### Note (independent verification)
This release was hardened by a read-only adversarial review (`kimi3-verifier`) that refuted two over-claims in the first cut (the separator-blind formatter over-grant; anti-nag firing on a reminding gate via a stale counter) plus a manual-re-enforce trap. All three are fixed above with regression tests; typecheck + full smoke suite green.

## 2.17.0 — 2026-08-31

### Fixed (production-data analysis: exit-1 immunity was breaking on real-world command shapes)
Found by reading the accumulated store data (doctor + analyze across all projects): the dominant NOT-TEACHING / REMINDERS-IGNORED / ANNOYING / FLAPPY noise was test and type-check commands being **gated on ordinary test failures** — exactly the "the failures are the work" case the immunity exists for. Three root causes:

- **Piping a diagnostic into a PowerShell formatter broke immunity** — `flutter test --no-pub 2>&1 | Select-Object -Last 5` (and `Tee-Object`, etc.): the formatter segment is not in `DIAGNOSTIC_VERBS`, so the "every chain segment must be diagnostic" rule denied immunity and the test's exit-1 became a gate. PowerShell pipeline formatters never set the exit code (`$LASTEXITCODE` stays with the producing native command), so they are now transparent to the check. A real non-diagnostic producer still gates (`npm install | select-object` still counts).
- **A leading `cd <path> &&` broke immunity** — `cd X && npx tsc --noEmit`: the navigation segment is non-diagnostic and denied immunity even though only the diagnostic can fail. Navigation (`cd`/`set-location`/`pushd`/`popd`) is now transparent. (`cd` alone still gates — a bare `cd` to a bad path is a real recurring mistake.)
- **`npm test` / `yarn test` / `pnpm test` were not recognized as diagnostics** — the test-runner list covered pytest/jest/vitest/etc. but not the npm/yarn/pnpm script runners, so their ordinary test failures gated. Added. (`npm run build` stays non-diagnostic — a build failure is a real error, not "the work".)

The `deploy --broken && grep done` hazard (a later diagnostic hiding a real failure) is unchanged and still denied.

### Systemic lesson
- An allowlist rule ("every segment must be diagnostic") is only as good as its segment model: segments that never produce the exit code (pipe formatters, `cd`) must be transparent to it, or the rule false-fires on the exact shapes agents use to trim noisy output (`… | Select-Object -Last 5`). Real production data was the only thing that surfaced this — the synthetic immunity tests all used bare or `&&`-chained commands.

## 2.16.0 — 2026-08-30

### Added (implementing the three deferred audit items)
- **Cross-channel double-count guard** — the same failure recorded by BOTH detection channels (after-hook exit/text AND the event-stream error part) within 2s for one (key, session) is now counted once. The guard keys on the WHOLE-CALL signature, not the segment-attributed key: the event channel signs the entire call, so a chained command (`x && gated`) double-firing across channels still dedups on one identity instead of slipping through on mismatched keys. The channels are disjoint by construction today (bash fails via exit/text, file tools via error-state parts), so the guard is inert until upstream ever double-fires — then it keeps counts and demotion math correct instead of inflating them. The doctor tripwire from 2.11.0 remains as the observable.
- **Promote→heal oscillation damping (`retireBaseline`)** — `count`/`sessions` are lifetime-cumulative, so a healed or taught-retired gate re-promoted on the VERY NEXT single failure (the FLAPPY loop the round-7 doctor report now measures). Retirement (heal or taught) now captures `retireBaseline.count`; re-promotion requires a full fresh bar (`count − retireBaseline.count ≥ threshold`), consumed on promotion. Feedback-demoted gates are untouched (they never re-promote mechanically). The invariant holds on EVERY mechanical re-promotion path: `migrate()`'s watching→reminding catch-up also exempts `retireBaseline` gates — without that, a healed diagnostic gate's lifetime count cleared the catch-up bar and re-promoted on every migrate (each version bump), re-opening the oscillation and spamming `healed` into the global log. This is the damping the audits deferred until data justified — shipped behind the same evidence model, observable via the FLAPPY report.
- **Deferred salient events reach the global log** — deferred events bypass `logAll`'s routing, so a project-store `demoted` (migrate) or `retired-healed` (expireAll) never reached the global forensics despite being in `GLOBAL_LOG_EVENTS`. The project store now carries `routeSalientTo` (wired by `Stores` to the global store); `log()`/`flushDeferred()` mirror the salient subset of the DRAINED deferred batch to the peer after their own log lock releases. Direct events are NOT mirrored (logAll already routes them — mirroring would double-write).

### Notes
- **`dejavu:learned` stays abandoned** — the audits' fourth deferred item is deliberately NOT implemented: a marker an agent (or injected content) could emit to silence gates mechanically is an adversarial vector; the proxy metrics (`REMINDERS IGNORED` / `TEACHING-WELL`) already cover the legitimate need.
- Re-promotion smoke tests updated to the damped semantics (a single post-heal failure no longer re-promotes; a full fresh bar does).

### Systemic lessons
- Two detection channels that are "disjoint by construction" still need a runtime dedup keyed on the shared identity (key, session) + channel-mismatch window — construction guarantees rot when the producer is upstream of you.
- Damping a lifecycle oscillation is best done with a baseline captured at the transition (like `feedbackBaseline`), not by resetting the lifetime evidence — the evidence stays truthful for display/eviction/merge while the decision is gated.
- Deferred-event routing and direct-event routing must stay distinct code paths: they look identical at the log lock, but only one is already routed.
- A mechanical-state invariant ("never re-promote without a fresh bar") is only as strong as its WEAPEST promotion path — `recordFailure` honored the baseline but `migrate`'s catch-up was a second promotion path that bypassed it. When adding a transition rule, enumerate EVERY path that performs that transition (here: recordFailure + migrate catch-up), and gate them all; a fresh-eyes audit caught the one the implementer's mental model omitted.

## 2.15.0 — 2026-08-30

### Fixed (subagent audit round 8)
- **`load(true)` outside the gates lock in `reconcileAll` (two sites)** — the escalation filter (project store, no lock held) and the index rebuild (holding the index lock, not the gates lock) both used the force path, which quarantines an unparseable `gates.json` — a WRITE — without the gates lock. That is exactly the write-without-lock class round 3 fixed in doctor. Both now use non-force `load()` (routing-hint reads per the project's own invariant); `reconcile()` healed both scopes a few lines earlier, so the peeks are fresh and the force path's only job (quarantine-on-corruption) already ran under the lock.

### Systemic lessons (round 8)
- `load()`'s two modes have different write semantics: non-force is a pure peek, force CAN WRITE (quarantine). The rule is therefore "force only under the gates lock" — not merely "prefer force under the lock". Any new read outside the gates lock must be non-force, or it silently reintroduces the write-without-lock window.

## 2.14.0 — 2026-08-30

### Fixed (subagent audit round 7)
- **`reconcile()` held the gates lock across the log lock (last nesting)** — `exciseCorruptLogLines()` was called inside `runLocked`, acquiring the log lock while holding the gates lock on every init. No deadlock (the log lock is a leaf), but it extended the gates critical section by a full log read+parse+rewrite exactly at init-storm time — the round-4 lesson leaking in one last place. Log hygiene now runs after the gates lock releases.

### Added
- **Doctor FLAPPY report** — per-key count of `promoted` vs resolved (`healed`/`retired-healed`/`retired-taught`) log transitions; flags keys promoted ≥2 AND resolved ≥2 times (promote→heal oscillation). Data-gathering only: `count`/`sessions` are lifetime-cumulative, so a healed/retired gate re-promotes on a single next failure — damping is deferred until this report shows it matters.
- **AGENTS.md CODE MAP is now symbol-only** — dropped the per-symbol line numbers (they rot every audit round and misled the round-7 doc check); references locate by symbol name. Header metadata refreshed.

### Systemic lessons (round 7)
- The log lock is a LEAF lock — it is always acquired alone or outermost, never while holding a gates/index lock. `reconcile()`'s nesting was the last survivor of the pre-`exciseCorruptLogLines` era; "nothing heavy runs under the gates lock" must be re-checked against every new log-touching helper.
- Doc line numbers rot on every change — a CODE MAP that carries them goes stale each round and misleads the next audit. Symbol-only references are the stable form; the map names WHAT and WHERE (file), never WHICH LINE.
- Measure oscillation before damping it — promote→heal→promote is a real risk, but damping changes promotion semantics; ship the FLAPPY tripwire first, act only on data.

## 2.13.0 — 2026-08-30

### Fixed (subagent audit round 6)
- **`recordFailure` flat lock phases (item A)** — the previous implementation held the project gates lock across the index lock + the global gates lock + two saves: the longest critical section in the system, and every other window's waiter degraded to unlocked after `LOCK_WAIT_MS` (the lost-update window the `degraded` event documents). Each phase now holds exactly one lock (project gates → index → [copy, global, remove-local] for escalation). Crash invariant preserved (global-first-then-remove-local; a crash between the two writes leaves a duplicate healed by migrate, never a hole).
- **`logAll` scoping (item B)** — the global log is shared by every window of every project (the most-contended lock) and was double-writing every event. High-volume events (`detected`/`reminded`/`blocked`/`retry-allowed`/`recurred-after-gate`) now stay in the project log; only machine-memory-salient events (`init`/`promoted`/`demoted`/`healed`/`retired-*`/`override`) reach the global log. ~90% fewer global log-lock acquisitions.
- **Deferred events drained before the log lock (N1)** — `log()`/`flushDeferred()` drained `deferredEvents` BEFORE acquiring the log lock, so an event deferred between the drain and the lock was dropped from that flush. The drain now happens inside the log lock.
- **Logging moved out of the index lock (N2)** — `reconcileAll` and doctor logged `repaired` events while holding the index lock, extending the index critical section at exactly init-storm time. Now logged after the lock releases.
- **TTL timer flushes deferred events (N3)** — `expireAll` defers `expired`/`retired-healed` events; a quiet long-lived process previously held them until the next hook log (lost on exit). The jittered TTL timer now calls `flushDeferredAll()`.

## 2.12.0 — 2026-08-30

### Fixed (subagent audit round 5)
- **Migration stamp was erased on every startup** — `reconcile()` parses `gates.json` directly (bypassing `load()`) and saved without the in-memory stamp, so the next `migrate()` re-ran its full per-gate scan on every startup. The init-storm killer from 2.11.0 was dead code. reconcile now preserves the stamp.
- **`recordSuccess` logged under the gates lock** — a heal on a hot gate while other windows waited cascaded contention. The `healed` event now logs after the lock releases.
- **Scripts lost deferred repair events** — doctor/migrate repair stores then exit without a subsequent `log()` call, so deferred repaired/quarantined/demoted/expired events were silently dropped ("every repair is logged" invariant). Added `GateStore.flushDeferred()`; doctor and migrate call it.
- **`pendingCalls` leaked entries for reminded/blocked calls** — aborted calls never reach the after-hook, so their entries leaked until FIFO eviction at the cap. Now deleted when the signal throws.
- **Paren sub-expressions blanket-immunized the outer verb** — `deploy (grep x)` flattened to one segment and the inner diagnostic immunized deploy's failure. Parens now flatten to segment separators (`;`), keeping command-level granularity.
- **`flagTokens` recomputed per pair** — the flood path re-split/sorted the same incoming signature on every gate under the gates lock. Now bounded-cached.
- **TTL timer had no jitter** — windows opened together all swept the shared global store at the same instant every interval. Now jittered (0.75–1.25× interval).

## 2.11.0 — 2026-08-30

### Added (subagent audit round 4 — verification + backlog triage)
- **Migration stamp** — `gates.json` now carries `migrated: <plugin version>`; the 2nd..Nth start of the same version skips the full per-gate `migrate()` scan. The biggest init-storm contributor removed on the common path (repairGate on load still heals hand-edits/policy violations).
- **Doctor capacity & corruption visibility** — per-scope gate count vs `MAX_GATES` (warning at ≥80%), flood-guard eviction count, quarantine artifact count+size, and a cross-channel double-count monitor (same failure recorded by two channels within 2s — the early-warning tripwire for the latent upstream double-count).
- **Stale-steal is pid-liveness-gated and visible** — a stale lock is stolen only if the recorded holder pid is dead (ESRCH); a live slow holder is waited out, and every steal is logged (`stale lock stolen`). A same-pid holder (another window/context in this process) is never stolen.

### Fixed
- **Escalation no longer rests on ghost dirs** — project dirs renamed/moved away (common on Windows dev machines) no longer count toward the 2-project escalation threshold (`recordFailure`, `reconcileAll`, doctor MISSED ESCALATION all filter `existsSync`). Evidence is preserved in the index; only the decision ignores ghosts.
- **`expireAll`/`migrate`/`reconcile`/quarantine/excise no longer log under the gates lock** — events are deferred (`deferEvent`) and flushed by the next `log()` call, batched under one log-lock acquisition. The round-3 invariant ("nothing heavy runs while holding the gates lock") was leaking in five places; all closed.
- **`reconcile()` reports steals/degrades** — it called `withLock` without the callbacks, so a stale-steal during init was invisible.
- **`fuzzySimilar` rejects cheap-first** — the O(1) length-band check now runs before the code-fingerprint regexes and `flagTokens` allocation; the flood path calls this per gate under the gates lock, and most pairs are rejected before any allocation.
- **Hook log flushes can no longer swallow enforcement** — the post-lock event flushes are wrapped: a logging failure is reported via `logHookError` and the GateSignal still throws.

### Systemic lessons (round 4)
- Lock staleness must be judged by holder LIVENESS, not lock age — a slow live holder and a dead one need opposite responses; and same-process lock holders are always "live".
- Deferred-event flushing must be the ONLY way to log from inside a store lock — every `await store.log(...)` inside `runLocked` is a contention cascade waiting to happen.
- Cross-project evidence must distinguish "dir existed" from "dir exists" at decision time; ghost evidence is kept (it may return) but never decides.
- Escalation of hot-path rejection order matters: free O(1) checks before any allocation.

## 2.10.0 — 2026-08-30

### Fixed (adversarial review round 3)
- **Paren-wrapped chains blanket-granted exit-1 immunity.** `splitChain` keeps `(deploy --broken && grep done log)` as ONE segment, so a diagnostic anywhere inside immunized the non-diagnostic part — hiding deploy's failure. `isIntendedNonzero` now flattens paren groups before splitting (immunity needs command-level granularity).
- **Re-promotion inherited stale session chains.** The lifecycle reset cleared counters but left `remindedSessions`/`failedSessions` — the session that triggered a taught-retirement could skip its reminder after re-promotion ("one retry allowed" on a stale entry). Promotion now clears session chains too.
- **Logging under the gates lock cascaded contention.** `reminded`/`blocked`/`retry-allowed`/`override`/`recurred-after-gate`/`demoted` events were logged while holding the gates lock — log-lock contention extended the critical section toward degrade storms. Hook events are queued and logged after the lock is released.
- **`recordSuccess` ran a wasted fuzzy scan** on every successful bash call while accepting exact matches only — now an exact-only lookup (also removes the fuzzy proxy-heal surface entirely). `recordFailure` routing uses the O(1) key index instead of a linear scan.
- **doctor repairs were unsafe against the live plugin.** `--repair`'s key collection used `load(true)`, which could quarantine an unparseable gates.json WITHOUT the store lock while OpenCode is running (the `/dejavu` command runs doctor in-session) — now non-force `load()`. Also: `--repair` now sweeps expired gates (reports no longer show gates that should be gone), and a missing init event after log rotation reports "version indeterminate" instead of a false VERSION DRIFT.
- Docs: review-flag semantics (blocked 10+ times, error persists — not "fired while error stopped"), re-enforcement wording (set `status` back AND clear `feedbackDemoted`), tunables list (`TAUGHT_REMINDERS`, `DEMOTE_REOFFENSE_SESSIONS`), blocking-only override counting.

### Fixed (adversarial review round 2 — holes found by subagent audit of 2.9.0)
- **Race-burst taught-retirement hole.** A parallel burst of identical calls within the reminder race window each incremented `remindedCount` — one burst of 5 could `retired-taught` a gate on its very first encounter, having taught nothing (raced calls never saw a reminder). Only true first encounters count now.
- **Retire↔re-promote oscillation.** Counters were lifetime-cumulative: a re-promoted gate (after heal/taught retirement) re-retired on its first reminder (stale `remindedCount ≥ 5`, stale zero recurrences), and one early recurrence locked out taught-retirement forever. Promotion now starts a fresh enforcement lifecycle (remindedCount/recurrences/overrides/heal-streak/baseline reset).
- **Demotion voted by failures the gate could not prevent.** `recurredAfterGate` counted first-encounter failures that never saw a reminder — 3 sessions failing once each demoted a gate that never spoke, and one bad session/model in a shared store could demote a gate for everyone. Recurrence demotion now additionally requires `DEMOTE_REOFFENSE_SESSIONS` (2) distinct sessions that reoffended AFTER a reminder (`reoffenseSessions`, capped, lifecycle-scoped).
- **`migrate()` re-promoted feedback-demoted gates.** The watching→reminding catch-up ignored `feedbackDemoted` — a demoted diagnostic gate silently re-enforced on every restart, directly violating "never re-promotes mechanically". The invariant now holds on EVERY mechanical path.
- **Proxy success healed the wrong gate.** `recordSuccess` used fuzzy matching: a success on a fuzzy-similar command grew another gate's heal streak and cleared its session chain. Healing and chain-clearing now require EXACT matches — fuzzy is attribution convenience, never a basis for state mutation.
- **Override marker smuggling.** The bypass check accepted an unquoted `dejavu:proceed` anywhere in actionable text — `echo dejavu:proceed && gated-cmd` or `tool --message dejavu:proceed` bypassed gates (and 5 smuggled overrides demoted them). The marker now requires comment syntax (`# dejavu:proceed`).
- **Chain immunity hole.** Exit-1 immunity was granted if ANY diagnostic verb appeared anywhere in the command — `deploy --broken && grep done log.txt` hid deploy's failure. Immunity now requires EVERY chain segment to be diagnostic.
- **Mid-session corruption → silent data loss.** `load()` conflated "file missing" with "file unparseable": a corrupted gates.json became an empty store in memory, and the next save overwrote the recoverable bytes. Parse errors now quarantine (bytes kept, fresh store started), like reconcile.
- **Lock ownership race.** After a stale-steal, the original holder's `unlink` deleted the STEALER's lockfile, opening the critical section to a third process. `withLock` now verifies ownership (pid in the lockfile) before releasing.
- **Env-prefixed one-liners escaped fingerprinting.** `PYTHONPATH=x python -c "..."` normalized to an over-generic watching shape; the interpreter regex anchor now allows leading env assignments.
- **`mergeGate` dropped the reminding tier** when merging a reminding source into a watching target (status merge is now rank-preserving: watching < reminding < blocking).
- Probe gates at count 3-4 no longer get the 60-day TTL (their promotion bar is 5); `coerceGateShape` round-trips `succeededAfterGate === 0`.

### Added
- **Retire-on-taught** — the positive twin of feedback demotion: a gate reminded `TAUGHT_REMINDERS` (5) times with zero in-session reoffense AND zero post-gate failures has taught its lesson — the agent changed behavior, so no success can ever heal it (the `wc -l` eternal-reminder loop). It retires softly to watching (logged `retired-taught`); re-promotion on new failures stays possible.
- **Flood guard prefers feedback-demoted victims** — proven-unteachable gates were the stickiest residents under the old lowest-count rule; they are evicted first now, and every eviction is logged (was invisible).
- **Lazy failure scan** — the full-output `detectFailure` scan is skipped on successful bash calls with exit metadata (hot-path cost).
- **doctor**: `REVIEW-FLAGGED` enforced-only (the flag never clears, healed gates would flag forever); `NOT TEACHING` baseline-relative (a human re-enforcement keeps its grace window); `GLOBAL_PROJECTS`/`DEMOTE_RECURRENCES` imported from store instead of hardcoded.

### Systemic lessons (how not to step on this class again)
- Every mechanical promotion/enforcement path must be audited against every demotion flag — a flag enforced in one path and ignored in another is a state-machine hole.
- Bypass markers must require unambiguous syntax (comment form); "strip quotes then regex" is not an annotation/data distinction.
- Policy checks over chains decide per-segment or all-segments — never "anywhere in the text".
- Fuzzy matching is for enforcement ATTRIBUTION; state mutations (heal, clear, consolidate) require exact identity.
- Locks are verified on release, not just acquired.
- Behavioral counters are lifecycle-scoped, not lifetime-cumulative: any retire/re-promote boundary resets them, or stale evidence from a previous lifecycle leaks into the next (oscillation, permanent lockouts). Lifecycle resets must clear ALL per-session enforcement state, not just counters — stale chains leak across lifecycle boundaries too.
- Feedback votes count only events the gate had a chance to influence (post-reminder failures, distinct sessions) — raw event counts let one bad session punish everyone.
- Chain-policy heuristics must treat paren groups as containers, not atoms — flatten whenever the decision needs command-level granularity.
- Nothing heavy (logging, nested locks) runs while holding the gates lock — lock hold time is contention cascade; diagnostics run outside the critical section.
- Diagnostic/report tooling must not mutate stores (quarantine) without the lock — it runs while the live plugin is open.

## 2.9.0 — 2026-08-30

### Added (the arms race, closed — negative-feedback loop completed)
- **Success clears the chain.** A success on an enforced gate now removes the succeeding session from its remind→block chain (`remindedSessions`/`failedSessions`). Before, a session that PROVED the fix (often via `dejavu:proceed`) stayed blocked forever and could only keep overriding — and the overrides then demoted the very gate the agent had just vindicated. Now: override once, succeed, the session is clean.
- **Iteration verbs remind-only.** `dart run`, `go run|build|test|vet`, `cargo run|build|test|clippy` join the diagnostic tier: their failures are the work itself (the agent is fixing the code they run). Blocking them produced the production arms races — dozens of overrides, zero teaching.
- **Doctor consumes the in-session metric.** New `REVIEW-FLAGGED` (mechanical `review: true`), `REMINDERS IGNORED` (`recurredAfterReminder >= 3` — the correction teaches nothing), and `TEACHING-WELL` notes; `recurredAfterReminder` is no longer a dead metric. `doctor --repair` now prunes TRUE-orphan index keys — safe only there, where every scope is visible at once.
- **analyze** shows reminding/feedback-demoted counts and discovers project stores from the global index (parity with doctor).

### Changed
- **Overrides count only against blocking gates.** On a reminding gate the marker merely skips one interrupting reminder — avoiding that is rational agent behavior, not friction with the teaching. The event is still logged.
- **Reminders are tier-truthful.** A reminding gate no longer promises to "harden into a block" (it never can) — teaching the agent a wrong model of enforcement.
- **Hook errors are visible.** Hook catches log rate-limited (1/min) client-log errors — a silently dead plugin was invisible before.
- The global index is no longer rewritten on the FIRST failure of a brand-new pattern (no escalation value) — machine-wide index churn drops while escalation evidence is preserved (anything indexed or recurring updates as before).
- Log rotation also runs on the TTL timer (multi-day sessions never rotated before).

### Fixed
- `exciseCorruptLogLines` reads the log INSIDE the log lock — the unlocked read + locked rewrite dropped every line another window appended between the two (concurrent OpenCode startups all reconcile at once).
- Unparseable `firstSeen`/`lastSeen` reset to now at parse time — a hand-edited garbage date made a gate immortal (`expire` compares `Date.parse < cutoff`; NaN never is).

### Release hygiene
- The npm package now ships `scripts/`, `command/`, `skills/` — doctor/analyze/migrate and the `/dejavu` command work on the recommended install path.

## 2.8.0 — 2026-08-30

### Added (roots, not symptoms — learned from 9 days of production data across 5 projects)
- **Behavioral feedback demotion.** Enforcement now has negative feedback (the twin of `healed`): an enforced gate that keeps failing after promotion (`DEMOTE_RECURRENCES` = 3) or keeps getting explicitly bypassed (`DEMOTE_OVERRIDES` = 5) is demoted to `watching` and marked `feedbackDemoted` — it never re-promotes mechanically; a human re-enforces by editing `gates.json`, and the gate gets a fresh grace window (`feedbackBaseline`) instead of re-demoting on the next failure. Overrides are now counted per gate (`overrideCount`), every demotion logs a `demoted` event, and `migrate()` catches up gates that already crossed the thresholds.
- **Residual-identity guard.** Signatures whose substance was entirely parameterized (`cmd <path> <str>`, `node <str> <n> >& <n>`, `& <str> -c @ <str> @`) can no longer enforce at any tier — they match whole command families. Generalizes the legacy bare-one-liner rule: any future normalization gap degrades to watching instead of blocking arbitrary calls.
- **PowerShell identity.** `cmd /c|/k "payload"` unwraps to the inner command — the wrapper no longer hides the real verb from the diagnostic policy, and `/c` no longer becomes `<path>`; interpreter one-liners recognize quoted exe paths and the call operator (`& "C:\...\python.exe" -c ...`) and here-string payloads (`@"..."@`) — code no longer leaks into signatures as raw tokens.
- **Control-character stripping.** ANSI/VT sequences and C0 junk are stripped before persistence (`stripControl`/`sanitizeForStore`) — PowerShell colored errors no longer corrupt snippets/corrections with raw `ESC[31;1m` garbage; historical gates are cleaned by `migrate()`.
- **mypy** joined the diagnostic verbs (remind-only tier; exit 1 is its normal "findings" outcome).
- **Noise filters**: grep_app "no results found" and the question tool's "user dismissed" are not failures.
- **doctor without arguments** discovers project stores from the global index's project list (before: cross-store checks ran global-only and reported hundreds of false INDEX ORPHANS).

### Changed
- `reconcileAll()` no longer prunes index orphans: one process sees ONE project store, so a key whose gate lives in another project is invisible, not dead — pruning destroyed cross-project escalation evidence. Rot is still bounded by the 60-day TTL sweep in `expireAll`; doctor reports true orphans (it now sees every scope).

### Fixed (adversarial review round)
- **`withLock` no longer deletes a foreign lock**: a waiter degrading to unlocked ran `unlink` unconditionally in `finally` — removing the lockfile the live holder owned and letting a third process enter the critical section concurrently. This is the root cause of the zero-byte corrupt log line seen in production.
- **Interpreter flag fragmentation**: regex alternatives run longest-first (`-command`/`-encodedcommand` before `-c`/`-e`) — before, `-command` matched as `-c` and swallowed `ommand` into the payload, fragmenting one call into different keys per spelling. Long flags converge to `-c` in the emitted signature.
- **Windows `py` launcher** one-liners are fingerprinted (before: `py - <n> -c <str>` — an enforceable over-generic shape).
- **Residual-identity guard bypasses closed**: `python -m <str>` (the module is the program, like `-c` — `-m`/`--module` are code-passing flags) and chains headed by `cd`/`pushd`/`popd`/`set-location`/`exit` (`cd <path> && python <path>` no longer borrows identity from the builtin).
- **Over-generic shapes never fuzzy-match**: an incoming signature without residual identity matches concrete gates exactly only — it no longer enforces via fuzzy or pollutes unrelated gates' evidence (`findGate` + `recordFailure` consolidation).
- **Chain bypass through `cmd /c`**: segment signatures recursively unfold the wrapper payload — a gate on the inner command fires even when the whole chain hides inside `cmd /c "a && gated"`; `dejavu:proceed` inside a LEADING `cmd /c "..."` payload is honored as an override (before, the wrapper quotes hid it like smuggled data).

### Data notes
- Production evidence (9 days, ~1000 gates, 5 projects): the global `wc -l` gate taught 10 sessions with zero recurrences — reminders work; script-runner gates (`dart run`, mypy behind wrappers, `cmd /c` gradle) produced arms races with dozens of `dejavu:proceed` overrides and zero teaching — feedback demotion ends that race mechanically.

## 2.7.0 — 2026-08-26

### Added (no more manual corrections)
- **Auto-corrections.** A promoted gate now always ships with a mechanical, overridable default correction (`suggestCorrection`), chosen by command family (stale `--check` artifacts, failing tests, type errors, network, installs) or from the captured error line — so a gate never sits "NOT TEACHING" awaiting a human. `migrate()` backfills existing enforced gates.
- **Richer snippets.** For exit-code failures whose output matched no signature, dejavu keeps the last non-empty output line (`failureSnippet`) instead of a bare "exit code N", giving corrections real context.

## 2.6.0 — 2026-08-26

### Added (only well-grounded triggers)
- **Gates heal.** dejavu previously only saw failures, so a gate kept reminding even after the underlying command was fixed (the `ruff check .` false positive). Now a SUCCESS matching an enforced gate increments `succeededAfterGate`; after `HEAL_SUCCESSES` (3) consecutive successes the gate retires to `watching` and logs `healed`, so fixed commands stop triggering. A failure resets the streak.

## 2.5.1 — 2026-08-26

### Fixed
- Cross-project index + forensic log now key on the gate's OWN key (post fuzzy-consolidation), not the raw failure key. Before, a failure that fuzzy-merged into an existing gate indexed a key with no gate — orphaning the entry and silently starving that gate's cross-project escalation (the "INDEX ORPHANS" you'd see in doctor).

## 2.5.0 — 2026-08-24

### Changed (the three known gaps, closed)
- **Diagnostics now signal.** Recurring test/lint/build-check failures (`tsc`, `pytest`, `curl`, ...) previously got zero enforcement. New gate tier `reminding`: they promote and REMIND like any gate, but NEVER block — a new status alongside `watching`/`blocking`, enforced everywhere (findGate, compaction, migrate/repair, doctor, TTL).
- **Repo-local verbs never escalate.** npm/yarn/pnpm/bun/npx, git, gradle/maven, cargo/go/pip/poetry/uv, docker, make/cmake/bazel failures are repo quirks, not agent habits — they stay project-scoped forever (`isRepoLocal`), so a broken `npm install` in one project can no longer block another. Doctor's MISSED-ESCALATION skips them.
- **Flag-aware fuzzy matching.** Commands with disjoint flag sets never merge (`train --lr` vs `train --epochs`); subset additions still do (`train` vs `train -v`), so enforcement doesn't fragment across harmless variants while different operations stay separate.

### Migration
- `migrate()` re-tiers legacy gates: over-blocking diagnostics → `reminding` (signal kept), and already-proven recurring diagnostics → `reminding` immediately (no waiting for the next failure).

## 2.4.0 — 2026-08-24

### Added
- Noise TTL: weak one-off patterns (below the promotion threshold, never enforced) expire after 7 days instead of 60 — memory is for recurring mistakes, not one-shot noise.
- Correction lifecycle signal: an expired gate that had a correction and zero recurrences after promotion logs `retired-healed` — the mechanical "the teaching worked"; doctor reports such gates as TEACHING.

### Notes
- V2 plugin API migration awaits upstream: `tool.execute.error` (opencode issue #27900) is drafted but unmerged — the event-stream scan remains the file-tool failure channel until then.

## 2.3.1 — 2026-08-24

### Fixed (adversarial + security review round)
- `mergeGate` now merges `remindedSessions`/`failedSessions` — escalation and dedupe no longer silently reset the remind→block chain.
- Fuzzy consolidation prefers the gate the session was already reminded about, keeping before/after hooks in sync when two blocking gates are near-duplicates; fuzzy merges no longer overwrite a gate's evidence snippet (a crafted near-duplicate cannot poison it).
- Quarantine resets the hot-path caches — no phantom gates served after a corrupt `gates.json` is quarantined.
- `failedSessions` became `sessionID -> timestamp` with the same 24h TTL as reminders — a stale block with no live session is a leak, not enforcement (legacy array shape coerces on load).

### Hardened
- Prompt-injection framing: snippets and corrections are labeled in remind/block/compaction messages as data/guidance, not instructions; corrections are truncated to 200 chars (context-pollution bound, enforced mechanically).
- Quarantined files and excised log lines are secret-scrubbed before being preserved.
- Overrides (`dejavu:proceed`) also emit a `warn`-level client log — mass-overriding must be noticeable.
- Store size bound: past 2000 gates the weakest watching gate is evicted (flood guard).
- `scrubSecrets` adds Hugging Face / DigitalOcean / Vercel / New Relic / SendGrid shapes and generic `key=<long value>` assignments (incl. lowercase keys).

## 2.3.0 — 2026-08-24

### Multi-process hardening (several OpenCode windows = several plugin processes on one store)
- Remind→block session state is persisted ON THE GATE (`remindedSessions`/`failedSessions`) instead of per-process memory: the escalation chain now survives process restarts and is visible to every window serving the session (before: two windows or a restart reset it to "remind forever, never block"). Enforcement reads fresh gate state under the store lock.
- Session state rots after 24h and is capped per gate; `session.deleted` cleans it from disk.

### Performance (hot path runs on every tool call)
- `fuzzySimilar`: O(1) length-band pre-filter (triangle inequality — zero false negatives) and a `FUZZY_MAX_LEN` cap — kills the Levenshtein explosion on long signatures (was 150-600ms/tool-call at scale).
- `GateStore`: O(1) key index + cached blocking subset for lookups; 1s TTL on the mtime cache so the hot path stops paying a `stat` per call (saves refresh the cache directly).
- Global log rotates at 2MB instead of 512KB — with several projects the aggregate forensics no longer vanish within a day.

### Fixed
- Init-storm TOCTOU: index orphan-pruning now keeps a 24h grace window, so a just-promoted gate's index entry cannot be pruned by a concurrent startup.
- After-hook escalation state is written under the store lock and follows the gate to the global store on escalation (previously lost in both cases).

### Added
- `doctor.ts` reports LOCK DEGRADATIONS (count of `degraded` log events) as an observability note — the evidence signal for whether the storage backend ever needs revisiting.

## 2.2.1 — 2026-08-24

### Fixed (adversarial-review round)
- Escalation order: the gate is written to the global store BEFORE being removed from the project store — a crash between the two writes leaves a duplicate (healed by migrate), never a hole.
- `dejavu:proceed` inside quoted strings no longer bypasses gates (`echo "dejavu:proceed" && gated-cmd` stays enforced); the marker is honored only outside quotes.
- Concurrent first-encounter race: calls dispatched in the same burst as a REMINDER (within 500ms) are reminded too instead of slipping through as a "retry".
- CRLF/CR commands normalize identically to LF; `splitChain` splits on CR — no more line-ending fragmentation.
- `normalizeCommand` is fully idempotent: quoted spans are parameterized BEFORE path rules (a `<str>` substitution inserts spaces that would expose an adjacent `/` to the path rule only on a second pass), fingerprint payloads are trimmed, and already-parameterized payloads are never re-fingerprinted.
- Interpreter flags glued to their payload (`node -e"code"`) fingerprint identically to the spaced form.
- Session state maps: inner key sets are capped — long sessions no longer grow unbounded.

### Added
- Lock degradation (contention > 3s) emits a `degraded` log event — the only window where concurrent writes can lose updates is now visible.
- `test/property.ts` — property-based tests for the normalization pipeline (idempotency, no nested tokens, output bound, one-liner distinctness, marker neutrality, splitChain atomicity).
- `test/fuzz.ts` — seeded mutation fuzzer with a metamorphic oracle and case shrinking; both harnesses run in CI. The harnesses caught the idempotency, marker-neutrality, glued-flag and nested-token-detector bugs above before production did.

## 2.2.0 — 2026-08-23

### Added
- Interpreter one-liner fingerprinting: `python -c` / `node -e` / `bun -e` and friends get their code payload hashed (`<code:sha1-8>`) instead of flattened to `<str>` — distinct scripts no longer share one gate, the same script failing repeatedly still converges.
- Global cross-project pattern index (`index.json`): counts distinct project dirs per failure key and now drives global escalation — a gate's own `projects` array only ever sees its own store, so escalation was dead code before.
- `mergeGate`: evidence merge for escalation and dedupe; never demotes a `blocking` gate.
- `isNoiseError()`: aborted/cancelled tool executions ("Tool execution aborted") are infrastructure noise and are no longer counted as failures.
- Self-healing stores (`src/validate.ts` invariant layer): every gate read from disk crosses strict parse + mechanical repair; `GateStore.reconcile()` quarantines unparseable gates.json (bytes preserved as `.corrupt-<ts>`), merges duplicate keys, excises unparseable log lines to `log.jsonl.corrupt`; `Stores.reconcileAll()` reconciles the index (prunes orphans, rebuilds missing entries, escalates gates proven in 2+ projects) — runs at every init.
- `doctor.ts [--repair]` now checks the full invariant set (shape, duplicates, temporal order, nested-token corruption, blocking without evidence, index consistency, stale project copies, missed escalation, log integrity) and heals on demand.

### Changed
- `canBlock()` rejects bare one-liner shapes (`-c <str>`); existing gates with them are auto-demoted by `migrate()`.
- Log appends and rotation run under their own lock with atomic writes — concurrent OpenCode windows no longer interleave broken JSONL lines.
- `migrate()` merges project-local copies of already-global keys into the global gate.
- `doctor.ts`: NOT-TEACHING/ANNOYING only flag gates that can actually block; non-blockable legacy gates no longer scream.

### Fixed
- All-digit `<code:...>` fingerprints are no longer re-parameterized by the number rule (~2.3% of payloads collapsed into one key).
- Signatures with different `<code:...>` fingerprints can no longer fuzzy-merge (random hashes differing in exactly 3 chars passed the distance rule and merged unrelated one-liners).
- `doctor.ts` no longer crashes on corrupt log lines; it now reports them as a CORRUPT LOG LINES pathology instead.
- Init failures (corrupt store, failed migrate) are logged instead of swallowed — a plugin starting on broken state is now visible.

## 2.1.0 — 2026-08-22

First public release.

### Added
- Gate enforcement state machine: remind on first same-session encounter, hard block after a reminded retry fails again; `dejavu:proceed` explicit escape hatch (logged as `override`).
- Two-scope store: project gates in `<repo>/.opencode/dejavu/`, escalation to global `~/.config/opencode/dejavu/` after 2+ distinct project dirs; lock order always project → global.
- Detection channels: `metadata.exit` (bash), line-by-line bash text scan, and `message.part.updated` event stream for tool-level errors; chain-segment matching so gates fire inside `a && gated` chains.
- Blocking policy: only non-diagnostic bash commands may block (`canBlock()`); probe tools use a higher promotion bar and never block.
- Secret scrubbing before any persistence (OpenAI/Anthropic/AWS/GitHub/Slack/Stripe/JWT/PEM/DB-conn/bearer/`root@host`, Google `AIza…`, full PEM blocks, `.env`-style `KEY=VALUE`).
- Near-duplicate consolidation via normalized Levenshtein ≤ 0.3 with an absolute floor of 3 edits.
- TTL expiry (60 days), log rotation, bounded in-memory session maps, `review: true` flagging, `recurredAfterGate` health metric.
- Observability: `log.jsonl` forensic events (`channel`, `via`, `exit`, `version`), `scripts/doctor.ts`, `scripts/analyze.ts`, `scripts/migrate.ts`.
- Companion agent skill (`skills/dejavu/`) and `/dejavu` status command (`command/dejavu.md`).
- `experimental.session.compacting` hook injecting active gates into compaction context.

### Fixed (post-review hardening, same release line)
- `pendingCalls` no longer leaks entries for aborted (reminded/blocked) calls; capped at 1000.
- Quoted-string parameterization regex rewritten as an unrolled loop (no catastrophic backtracking).
- `migrate()` now also secret-scrubs gate `correction` fields.
