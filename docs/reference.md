# dejavu-gates — reference

Deep dive for maintainers and curious users. The [README](../README.md) carries the essentials; this page carries the full mechanics. Everything here mirrors behavior that is pinned by the test suites — when the two disagree, the code and the tests win, and this page is a bug.

**Contents**

- [Enforcement policy](#enforcement-policy)
- [Proactive guards](#proactive-guards)
- [Payload hygiene channels](#payload-hygiene-channels)
- [Recovery channels (OpenCode, opt-in)](#recovery-channels-opencode-opt-in)
- [Data safety](#data-safety)
- [Gate lifecycle](#gate-lifecycle)
- [Harness installation notes](#harness-installation-notes)
- [Observability and maintenance](#observability-and-maintenance)

## Enforcement policy

- **Blocking policy** — only `bash` commands that are NOT diagnostics may ever become blocking gates. Diagnostics and iteration commands (tsc/eslint/mypy/pytest/phpunit/rspec/rubocop/gradle-test/`mvn test`/`dotnet test`/flutter/curl/grep, `dart run`, `go run|build|test|vet`, `cargo run|build|test|clippy`, `swift build|test`...) promote to `reminding` — they annotate the failing output with a `[dejavu] NOTE` (once per session) and never block or interrupt the run, so iterating on tests/builds is never punished. File probes (read/edit/write/glob/grep) stay `watching`: measured, visible in reports, never interrupting. Event-channel `tool-error` signatures (argless calls whose error text is the only identity) promote to `reminding` once their literal head carries enough identity — never `blocking`. `canBlock()`/`canRemind()` in `src/patterns.ts` are the single source of truth. Signatures without residual identity (see below) enforce at no tier.
- **One-liner identity** — for `python -c` / `node -e` / `bun -e` / `php -r` / `ruby -e` / `perl -e` / `julia -e` / `lua -e` / `Rscript -e` and PowerShell `-Command` the code payload IS the call, so it is fingerprinted (`<code:hash>`) instead of flattened to `<str>`: different scripts never share a gate, the same script failing repeatedly still converges. `-r` fingerprints only for php (node/ruby/perl `-r` is a preload flag). PowerShell shapes are covered — quoted exe paths (`& "C:\...\python.exe" -c ...`), here-string payloads, env-prefixed invocations (`PYTHONPATH=x python -c ...`). Legacy bare `-c <str>` shapes never enforce at any tier (residual-identity guard).
- **Wrapper unwrapping** — `cmd /c|/k "..."` normalizes to the INNER command: the gate key, identity and diagnostic tier all see the real call instead of a `cmd <path> <str>` shape matching every cmd invocation.
- **Chain-segment matching** — gates fire even when the gated command hides inside `x && gated-cmd` chains, `cmd /c "..."` wrappers, or `$(...)` / backtick substitutions. Failure attribution to a segment requires exactly one non-transparent producer; with several, the exit code does not say which one failed, so the failure records under the whole call.
- **Intended non-zero exits** — exit 1 from diagnostics is NOT a failure (that is their normal "found nothing / found issues" outcome). Exit ≥ 2 always counts.
- **Aborted ≠ failed** — cancelled/aborted tool executions ("Tool execution aborted") are infrastructure noise and are never counted as failures. Server-side unavailability (LSP daemon down, MCP transport, non-2xx) is noise as well; client-side errors (4xx, ENOENT, syntax) stay teachable.
- **File content is not command output** — in OpenCode, text failure signatures are scanned for `bash` only; `read`/`edit`/`write` failures come exclusively from the event channel (a file containing "TypeError" is not a failure). External harnesses deliver file-tool failures through their post hooks, where the tool's own error text (not file content) is the payload.
- **Near-duplicate consolidation** — new failures merge into existing patterns via normalized Levenshtein ≤ 0.3 with an absolute floor of 3 edits (replaces token Jaccard, which collapsed all `<str>` placeholders; the floor stops `git push` vs `git pull`-style merges). Strict flag additions with identical base text rescue onto an absolute distance budget even when the relative band rejects.

## Proactive guards

Shape-based interruptions in the before-hook; every one is bypassable with `# dejavu:proceed` (logged as an override) and none of them create or mutate gates.

- **Long-running guard** — a FOREGROUND dev-server/watcher start (`npm run dev`, `next dev`, `vite`, `flask run`, `uvicorn`, `python -m http.server`, `mvn spring-boot:run`, `gradle bootRun`, …) would block the bash call until its timeout and strand an orphan process. dejavu interrupts it in the before-hook with a "run detached" reminder (tmux / `nohup … &` / `Start-Process` / a startup script that spawns detached). Detached forms (trailing `&`, `nohup`, `tmux`, `Start-Process`) and one-shots/builds (`vite build`, `npm run build`) pass silently. The starter list is deliberately conservative (ambiguous `node <file>`, `go run`, `dotnet run` are not flagged).
- **Suppressed-spawn guard** — compensating measure for [anomalyco/opencode#29831](https://github.com/anomalyco/opencode) (remove when the upstream fix ships): a call that spawns a DETACHED daemon while piping/redirecting stdout (`… start | Out-Null`, `… start > $null`) hangs forever — opencode ends a bash call only on stdio EOF, and the living daemon keeps the pipe open. A static bounded list (`DETACHED_SPAWNERS`) is interrupted in the before-hook with the correction "run the spawn bare (1-3 lines of output) and poll status in a separate call". Bare spawns, non-spawn verbs, and stderr-only redirects (`2>`, `2>&1`) pass.
- **Inherited-spawn guard** — the second leak path of the same EOF semantics, empirically verified: `Start-Process -RedirectStandard*`/`-Wait` turns ON handle inheritance, so the spawned process receives the call's stdio pipes and holds them until it exits — a daemon that outlives the call (`-WindowStyle Hidden|Minimized`, or a known server starter as the spawned command) hangs the call forever, and redirecting all three streams does NOT help (a bare `Start-Process` leaks nothing). The before-hook interrupts that shape and teaches bare spawns (daemon writes its own logs) or a two-stage spawn (outer bare `Start-Process` of a pwsh one-liner that redirects inside).
- **Orphan-job guard** — `Start-Job` without an in-call wait runs inside the call's PowerShell and is killed silently when the call ends: "background" work that never survives, with no error anywhere. The before-hook interrupts it and teaches the detached bare-Start-Process pattern (or `Wait-Job`/`Receive-Job -Wait` for in-call results).
- **Snowball guard** — an agent re-issuing its own previous bash command verbatim as a strict prefix with a new section appended (command accretion) re-executes every already-answered query and floods the context with duplicate output (the incident: a research subagent issued 30+ growing calls, 46 minutes, no deliverable). The before-hook denies the third consecutive growth call and teaches: issue only the NEW query as a fresh command — the cd/setup prefix belongs in the bash tool's workdir parameter, independent questions are parallel tool calls. Identical re-sends stay the repeat channel's business.

## Payload hygiene channels

OpenCode-only transform-hook work: stateless scans of the OUTGOING payload that never touch the persistent store.

- **Repeat channel** — DashScope/Qwen hard-rejects a request whose history carries the same tool call (name + args byte-identical) in consecutive rounds (HTTP 400), and one rejection poisons the session forever. The transform hook scans every outgoing payload statelessly: occurrences past the first of an identical-consecutive series get a `_dejavu_repeat` marker (payload-only, never persisted), a series reaching the tail gets a `[dejavu] REPETITION` note on its last tool result, and a third identical call is hard-blocked in the before-hook. Windowed near-repeats earn a `[dejavu] SHAPE LOOP` note only when the normalized call shape repeats (bash trailing comments and rotating scratch-buffer temp paths collapse; numeric args, moving offsets and distinct temp files stay distinct — they are data) AND the last two results are meaningfully identical; the note is advisory and never escalates to an injection or a stop. Bypass: `_dejavu_proceed: true` in args (logged as override).
- **Loop break** — a model that keeps re-issuing the call past the REPEAT STOP message gets an automated user-role message appended to the outgoing payload (payload-only, marked `synthetic`). Blocked tool errors are an in-loop stimulus that weak models read as "retry"; a user-role turn is the one stimulus that reliably forces a text reply and ends the loop. The injection fires only while the same series owns the tail — a real user message or a text reply ends it — and logs `loop-break` once per series.

## Recovery channels (OpenCode, opt-in)

Two recovery passes for provider-side degeneration. Both default OFF; both enable with `DEJAVU_LEAK_RECOVERY=1` / `DEJAVU_LOOP_RECOVERY=1` (`1`/`true`/`yes`). No gates, no persistence, no promotion.

- **Leaked tool-call recovery** — an OpenAI-compatible gateway can intermittently leak tool-call serialization into the assistant message as plain text instead of a structured tool call, so the call never runs and every detection channel is blind. Three dialects are covered: the full `<|DSL|calls>…</|DSL|calls>` block (tail-anchored), a stream cut inside the payload, and malformed tool-call tags (`<dc@bash>…</dc@bash>`, `<dc@bash/>`, `</dc@bash>`) a model keeps re-emitting while trying to "issue the call" — one complete guard-passing tag pair counts as a leak, and three stray tags without any pair do too. Fenced examples, backtick-quoted spans and one-off inline mentions stay untouched. The repeat channel neutralizes the guard-passing blocks in the outgoing payload so the model never sees its own broken emissions back, and appends a synthetic user turn telling the model to re-issue the intended call as a proper tool call. Logs `leak-recovery` once per session.
- **Loop recovery** — a reasoning model can get stuck: lexical spam (a wall of one token) or a hedge-heavy deliberation loop that re-litigates one decision and never emits a tool call. The host watches the streaming reasoning/text, runs the pure `detectStuckReasoning` detector (letter-token run-length dominance, exact-duplicate lines, hedge density — Unicode-aware, digits excluded so numeric data never fires), aborts the session, and injects a corrective user turn; two consecutive positive checks confirm before the abort (a transient spike arms only), the quota/cooldown/log settle only on a landed abort+prompt (a failed attempt retries), capped at 2 landed injections per session with a 30s cooldown, logs `loop-recovery` once per session.
  - Documented detector limits: a bare (unfenced) listing of 100+ identical short lines can false-positive (confirmation mitigates transient, not persistent shapes); a loop with variation (duplicate ratio 0.5–0.8 without hedges) can slip through; the hedge set is English-only, so oscillation does not fire on non-English deliberation (token-dominance and exact-duplication work on any language).

## Data safety

- **Clean persistence** — terminal control characters (PowerShell VT colors, NULs) are stripped before anything touches disk; signatures, snippets and corrections never carry ANSI escapes. Harness payloads are external untrusted input and cross the same `sanitizeForStore()` boundary before anything is persisted.
- **Secret scrubbing** — every signature and snippet passes `scrubSecrets()` (OpenAI/Anthropic/AWS/GitHub/Slack/Stripe/JWT/bearer/DB-conn-string/PEM patterns + `root@host`) before touching disk. Historical data is cleaned by `migrate()` at init or via `bun scripts/migrate.ts <dirs...>` (also scrubs logs).
- **Concurrency** — gates.json mutations run under an exclusive lockfile; log appends and rotation take their own lock; writes are tmp+rename with EPERM/EACCES/EBUSY retry (Windows AV/indexer). NT long paths get the `\\?\` prefix. Parallel tool calls in the SAME process serialize on an in-process queue before ever touching the file lock. Across processes (several OpenCode windows, or parallel hook-CLI invocations from one harness), if a lock cannot be acquired within 3s the critical section degrades to unlocked (the tool pipeline must never hang) and emits a `degraded` log event. A transiently-unreadable store (AV lock, `EISDIR`) throws instead of parsing as empty, so a failed read can never let the next save clobber real gates.
- **Multi-process safe** — the remind→block escalation chain is persisted on the gate itself (`remindedSessions`/`failedSessions`), not in process memory: several windows, several harnesses, and short-lived hook-CLI processes on one store all see the same chain. Enforcement always reads fresh gate state under the store lock.
- **Bounded memory** — per-session maps are capped (50 entries per gate) and freed on session end; handled part IDs evict FIFO; TTL expiry and log rotation re-run every 6 h in long-lived processes (the CLI runs its idempotent init passes per invocation and flushes deferred log events before exit).
- **Migration** — gates outside the blocking policy are re-tiered automatically (diagnostics land in `reminding`, everything else in `watching`); already-proven recurring diagnostics start reminding immediately; project copies of already-global gates are merged into the global gate (evidence is consolidated, never deleted).
- **Self-healing** — every init reconciles the stores: an unparseable `gates.json` is quarantined (bytes preserved as `gates.json.corrupt-<ts>`), gate records are strictly parsed and mechanically repaired (inverted dates swapped, duplicate keys merged, secrets/control-chars re-sanitized, stale blocking demoted), unparseable log lines are excised to `log.jsonl.corrupt`, and the cross-project index is reconciled. Every repair is logged as a `repaired`/`quarantined` event.

## Gate lifecycle

- **Heal** — dejavu sees successes too: a SUCCESS matching an enforced gate grows `succeededAfterGate`, and after 3 in a row the gate retires to `watching` (logged `healed`), so a command you fixed stops triggering reminders. A failure resets the streak. Heal-aware: a blocking gate with a live heal streak does not interrupt the first run — it lets a likely-fixed command run and blocks only a repeat failure.
- **Demote** — the negative twin: a gate the agent keeps fighting (3+ post-gate recurrences across 2+ sessions that reoffended after a reminder, or 3+ explicit `dejavu:proceed` overrides across 2+ distinct sessions on a blocking gate; reminding gates demote on 5 distinct bypassing sessions, no raw-count bar — bypassing a gate that never interrupts is weaker friction) is friction, not teaching — it demotes itself to `watching` + `feedbackDemoted` (logged `demoted`) and never re-promotes mechanically. A single stubborn/injected session cannot disarm a gate: both votes need distinct sessions. A human re-enforces by setting `status` back and clearing `feedbackDemoted`; the gate gets a fresh grace window via `feedbackBaseline`.
- **Taught retirement** — a gate reminded 5+ times with zero reoffense has TAUGHT its lesson — it retires softly (logged `retired-taught`); re-promotion on new failures stays possible.
- **Chronic retirement** — reminders reaching 10 with 1–2 reoffenses (too ignored for taught, not ignored enough for demote) retire as chronic (logged `retired-chronic`).
- **Flappy terminal state** — a gate promoted and retired three times each never re-promotes mechanically (the promote→retire oscillation is terminal; `promotionCount`/`retiredCount` are lifetime counters). Retirement damping (`retireBaseline`) forces a full fresh bar of failures for every re-promotion.
- **Auto-corrections** — a promoted gate always ships with a mechanical, overridable default correction chosen by command family (stale `--check` artifacts, failing tests, type errors, network, installs, go/cargo/maven/dotnet/rspec/phpunit/make builds) or from the captured error line, so a gate never sits "NOT TEACHING" awaiting a human; a correction never quotes a success-shaped line. `migrate()` backfills existing gates.

## Harness installation notes

Mechanics per harness that the installer handles for you; read this only when something needs hand work.

- **Codex CLI**: hooks are a stable feature enabled by default; Pre/PostToolUse fire for every function tool with canonical hook names (`Bash` for shell, `apply_patch` for edits with `Write`/`Edit` matcher aliases, `spawn_agent`, MCP tools under flat names). dejavu's matcher covers `Bash` and `apply_patch`; a first-run trust prompt may still apply to project hooks.
- **Crush**: PreToolUse only (no AfterTool upstream) — dejavu runs degraded: blocking works, reminders can't annotate; the shared store still teaches Crush from gates learned elsewhere.
- **Devin CLI**: hooks live in `.devin/hooks.v1.json` where the file root IS the event map — the installer merges dejavu entries into it and strips them on uninstall, foreign events survive. Devin also auto-imports Claude-format hooks from `.claude/settings.json` (`read_config_from.claude`, on by default), so a Claude install already gates Devin sessions. No user-level hooks file is documented — project scope only.
- **Kiro**: hooks are standalone files under `.kiro/hooks/`; dejavu owns `dejavu-gates.json` there. Kiro blocks on any non-zero hook exit and injects a successful hook's stdout into agent context, so the reminding NOTE rides raw on stdout and an allow writes nothing. Kiro documents no user-level hooks path — project scope only.
- **Claude Code**: `PostToolUseFailure` is wired to the same post handler; payloads carry no exit codes, so failure detection runs on output text (the engine's text channel). The `SessionStart` hook injects a digest of the project's top enforced gates (blocking first, then reminding, lastSeen-desc, ~2000 chars) as `additionalContext`, so the agent knows the gated calls before losing a first one to a reminder.
- **Cline**: in-package plugin host (`src/cline-plugin.ts`); SDK/CLI/Kanban only — the VS Code and JetBrains extensions have no plugin system; no exit codes → text detection.
- **Zed, Aider**: no hook API to intercept tool calls — not portable. **Windsurf, Amp**: block-only / fire-and-forget surfaces; deferred until context injection exists.
- **Manual invocation** (any harness with command hooks):

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Bash","tool_input":{"command":"deploy.sh"},"cwd":"/repo"}' \
  | bun src/cli.ts pre --harness claude --store /repo
# exit 0 + {} = allow; exit 2 + stderr = blocked with a [dejavu] message
```

- **GitHub Packages mirror**: every release is also published as `@whitebite/dejavu-gates`. GitHub Packages requires a token even for public packages, so npmjs.com stays the recommended channel:

```ini
# .npmrc
@whitebite:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=<PAT with read:packages>
```

```bash
npm i -D @whitebite/dejavu-gates
```

## Observability and maintenance

- **Log events** — every `log.jsonl` gets an `init` event with `PLUGIN_VERSION`; `detected` events carry `channel` (`exit`/`text`/`event`), the raw exit code and the observing `harness`; `reminded`/`blocked` carry `via` (`exact`/`fuzzy`/`segment`). High-volume events (`detected`/`reminded`/`blocked`/`retry-allowed`/`recurred-after-gate`) stay in the project log; machine-salient events (`init`/`promoted`/`demoted`/`healed`/`retired-*`/`override`) reach the global log. A long-lived host that finds a store last written by a newer plugin self-surfaces the drift at boot — a warn line plus a `version-drift` log event.
- **doctor** — `bun scripts/doctor.ts [--repair] [projectDirs...]` (or `dejavu report`, the npm bin, for any harness): one-command report over every invariant the data model implies — gate shape, duplicate keys, temporal order, nested-token corruption, blocking without evidence, policy violations, index↔gates consistency, stale project copies, missed escalation, log integrity, secrets, version drift, flappy oscillation, flood evictions, cross-channel double-count, quarantine artifacts. `--repair` heals first (idempotent), then reports; `doctor --repair` sweeps orphan `*.tmp` files and stale `*.lock` files; `--prune-corrupt=<days>` opts into deleting quarantine artifacts past the age (default 30 days).
- **analyze** — `bun scripts/analyze.ts [projectDirs...]`: store summary — statuses, tools, top patterns.
- **lesson** — `dejavu lesson list` / `dejavu lesson set <key> "<one-line fix>"` — review gates whose `correction` is still the machine default and write a human correction onto an existing gate (cannot create gates; promotion stays mechanical). A `lesson set` also clears the gate's `review` flag — the rewrite is the review doctor asked for. `lesson list --all` includes watching gates; `lesson set --author owner|agent` records who wrote it; `lesson retire-when <key> <spec>` declares an external invalidation (`dep:<name>@>=<min>`, `path-present/absent:<p>`, `tag:<name>`) that `doctor` evaluates.
- **/dejavu command** (OpenCode): runs doctor first, then reports.
- **Debug** — set `DEJAVU_DEBUG=1` to see engine log lines on stderr (stdout always stays pure JSON).
