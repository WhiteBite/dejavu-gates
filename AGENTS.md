# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-22 (refreshed 2026-09-26)
**Commit:** 2.39.0 (cross-harness port, npm `dejavu-gates`)
**Branch:** main

## OVERVIEW

dejavu — error gates for AI coding agents ("memory prosthesis with teeth"): mechanically detects recurring tool-call failures and promotes them into enforced gates (3 failures across 2 distinct sessions). Remind first, hard-block on same-session repeat offense. One harness-agnostic engine, two host forms: the OpenCode plugin (`index.ts`, long-lived process) and a hook-handler CLI (`src/cli.ts`, short-lived process per event) with adapters for Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro. TypeScript ESM, runs under Bun, ships as raw `.ts` (no build step). Repo/npm name: `dejavu-gates` (formerly `opencode-dejavu`).

## STRUCTURE

```
dejavu-gates/
├── index.ts            # OpenCode plugin host — exports Dejavu (Plugin factory); glue only since 2.39
├── src/
│   ├── patterns.ts     # Pure engine: signatures, normalization, secret scrub, detection, blocking policy
│   ├── store.ts        # GateStore/Stores: two-scope persistence, locks, promotion, TTL, migration, reconcile
│   ├── validate.ts     # Invariant layer: strict gate parsing + mechanical repair (parse-don't-validate boundary)
│   ├── types.ts        # Cross-harness contract: NormalizedEvent/Verdict/OutboundDecision/HarnessAdapter (types only, zero imports)
│   ├── enforce.ts      # Engine public surface (re-exports) + EnforceContext
│   ├── context.ts      # EphemeralState (+ CLI degradation contract), caps, cross-channel dedup helpers, shared retirement tunables
│   ├── before.ts       # enforceBefore — repeat block, guards, remind→block chain under the store lock
│   ├── after.ts        # enforceAfter — failure detection/attribution/recording, reminding NOTE production
│   ├── event.ts        # recordEventFailure + cleanupSession (event channel)
│   ├── guards.ts       # proactive guards (long-running/wait-loop/spawn/orphan-job) — messages verbatim
│   ├── repeat.ts       # repeat-series before-block (override FALLS THROUGH to gate processing)
│   ├── messages.ts     # remindMessage/remindNote/blockMessage — the teaching texts
│   ├── adapters/       # per-harness payload↔contract mapping: shared.ts + claude/codex/gemini/cursor/copilot/crush/devin/kiro.ts
│   ├── opencode-v2.ts  # OpenCode V2 host glue: v2Setup registers tool/event/compaction hooks on the V2 plugin Context
│   └── cli.ts          # hook-handler CLI: stdin JSON → engine → stdout decision JSON, exit 0/2/1, fail-open
├── test/               # smoke (plugin), enforce (engine), adapters, cli (e2e spawn), language-gaps, property, fuzz — plain bun scripts
├── scripts/            # doctor.ts, analyze.ts, migrate.ts, install-hooks.ts (+ templates/*.json per harness)
├── command/dejavu.md   # /dejavu slash-command definition (install → ~/.config/opencode/command/)
├── skills/dejavu/      # Companion agent-protocol skill (install → ~/.config/opencode/skills/)
└── .omo/, .codegraph/  # Tooling artifacts — not project code
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Gate enforcement (remind/block/override) | `src/before.ts` + `src/after.ts` (via `src/enforce.ts`) | hosts only glue: index.ts throws GateSignal on deny verdicts; cli.ts maps verdicts to harness dialects |
| Failure detection + recording | `src/after.ts` (exit/text) + `src/event.ts` (event channel) | cross-channel dedup guard counts one call once; external harnesses have NO exit codes → text channel only |
| Harness payload mapping | `src/adapters/<h>.ts` + `src/adapters/shared.ts` | tool aliases + arg-field normalization feed callSignature — signatures stay harness-neutral so gates travel |
| Hook config generation | `scripts/install-hooks.ts` + `scripts/templates/*.json` | idempotent merge, aborts on unparseable config, {{CLI}} placeholder |
| Signature/normalization | `src/patterns.ts` | `callSignature`, `normalizeCommand`, `parameterizeError` |
| Enforcement policy | `src/patterns.ts:canBlock()`/`canRemind()` | three tiers — bash non-diagnostics block, diagnostics + Unix viewers remind-only, everything else just watches |
| Persistence, locks, promotion, global escalation | `src/store.ts` | `Stores.recordFailure()` is the core; cross-project evidence lives in global `index.json` |
| Self-healing / reconcile | `src/store.ts` + `src/validate.ts` | `Stores.reconcileAll()` at every init; `doctor --repair` on demand |
| Tunables | `src/store.ts`, `src/context.ts`, `src/before.ts`, `src/repeat.ts`, `index.ts` | promote thresholds in store; retirement tunables + caps in context; review/race in before; repeat-block in repeat; TTL/transform-only in index |
| Pathology checks | `scripts/doctor.ts` | defect classes: unparseable/bad records, duplicate keys, temporal inversion, nested tokens, enforced-without-evidence, stale blocking/reminding, not-teaching, annoying, stale-correction, review-flagged, reminders-ignored, unsanitized, stale copies, corrupt logs, version drift, cross-store index checks, flappy, flood evictions, cross-channel double-count, quarantine artifacts, feedback-demoted, overridden, lock degradations; no-arg run discovers projects from the index |

## CODE MAP

Line numbers intentionally omitted — they rot every round; locate by symbol name.

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Dejavu` | Plugin factory | index.ts | V1 entry of a dual V1/V2 default export; wires 4 hooks |
| `v2Setup` | fn | src/opencode-v2.ts | OpenCode V2 host: registers execute.before/after (deny via throw), event.subscribe (session.deleted cleanup), and compaction hooks on the V2 plugin Context; reuses the same engine calls as the V1 host |
| `GateSignal` | class | index.ts | sentinel error — the ONLY error rethrown from hooks |
| `enforceBefore` / `enforceAfter` | fn | src/before.ts / src/after.ts | the engine's two hook entry points; return verdicts/outcomes, never throw GateSignal (hosts translate) |
| `recordEventFailure` / `cleanupSession` | fn | src/event.ts | event-channel failure recording + session teardown |
| `EnforceContext` / `EphemeralState` | interface / fn | src/context.ts | injected host dependencies (stores/log/onHookError/projectDir) + per-process state; `createEphemeralState()` JSDoc is the CLI degradation contract |
| `NormalizedEvent` / `Verdict` / `OutboundDecision` / `HarnessAdapter` | types | src/types.ts | the cross-harness contract; zero imports, types only |
| `internalTool` / `internalArgs` | fn | src/adapters/shared.ts | harness tool-name aliases + arg-field normalization → callSignature vocabulary |
| `ADAPTERS` registry | const | src/cli.ts | HarnessName → adapter; `CliHarness` excludes opencode (plugin host, not CLI) |
| `scrubSecrets` | fn | src/patterns.ts | secret redaction (half of the persistence boundary) |
| `stripControl` / `sanitizeForStore` | fn | src/patterns.ts | C0/ANSI strip; `sanitizeForStore` = stripControl + scrubSecrets — the persistence boundary |
| `hashInterpreterPayload` | fn | src/patterns.ts | `-c`/`-e` code payload → `<code:hash>` (identity of one-liners, incl. PowerShell here-strings + env prefixes) |
| `cmdWrapperPayload` / `unwrapCmdWrapper` | fn | src/patterns.ts | `cmd /c\|/k` payload extraction; unwrap normalizes the inner command |
| `normalizeCommand` | fn | src/patterns.ts | bash → signature; strips control chars, unwraps `cmd /c`, fingerprints one-liner payloads |
| `isIntendedNonzero` | fn | src/patterns.ts | exit-1 immunity for diagnostic chains (all segments diagnostic; paren groups flattened first) |
| `canBlock` / `canRemind` | fn | src/patterns.ts | blocking tier / remind-only tier (diagnostics + iteration verbs + Unix viewers via `isUnixViewerSignature`) |
| `isRepoLocal` | fn | src/patterns.ts | repo-local verbs that never escalate globally |
| `splitChain` / `bashSegmentSignatures` | fn | src/patterns.ts | quote/paren-aware chain split; per-segment signatures, unfolds `cmd /c` + `$(...)` + backticks (chain-bypass protection) |
| `callSignature` | fn | src/patterns.ts | stable call identity per tool (bash/read/edit/write/glob/grep) |
| `patternKey` | fn | src/patterns.ts | sha1 prefix-12 of signature — the gate key |
| `fuzzySimilar` | fn | src/patterns.ts | near-duplicate merge; length-band pre-filter + `FUZZY_MAX_LEN` cap |
| `detectFailure` / `failureSnippet` | fn | src/patterns.ts | line-by-line bash-output failure scan / evidence line selection (error-aware tail scan, never a success-shaped line) |
| `looksLikeSuccess` / `looksLikeFailure` | fn | src/patterns.ts | evidence-quality classifiers — a pass summary is never failure evidence |
| `isNoiseError` | fn | src/patterns.ts | infrastructure noise ≠ failure: aborted/cancelled/empty-result/dismissed + server-side unavailability (LSP daemon, MCP transport, non-2xx) |
| `suggestCorrection` | fn | src/patterns.ts | mechanical default corrections by command family; never quotes a success-shaped snippet |
| `nonTransparentProducers` | fn | src/patterns.ts | counts chain segments that can be the failing producer — single-producer rule for chain attribution |
| `hasResidualIdentity` | fn | src/patterns.ts | over-generic shape guard — gates every enforcement tier (flag-only wrapper shapes have no identity) |
| `GLOBAL_PROJECTS` | const | src/store.ts | cross-project escalation threshold |
| `GateStore` | class | src/store.ts | one scope: gates.json + index.json + log.jsonl, TTL caches, key index; `load()` read-only vs `loadForMutation()` (write-capable, under lock) |
| `mergeGate` | fn | src/store.ts | evidence merge for dedupe/escalation (rank-preserving, preserves session state + feedback marks) |
| `checkFeedbackDemotion` | fn | src/store.ts | negative feedback: recurrences (2+ reoffense sessions) / overrides (2+ bypassing sessions) → watching + `feedbackDemoted` |
| `retireTaught` / `retireAntiNag` | fn | src/store.ts | shared retirement mutations (taught = soft, anti-nag = feedbackDemoted + counter reset); conditions stay tier-explicit at the hook call sites |
| `levenshteinCapped` | fn | src/patterns.ts | early-exit edit distance for the fuzzy flood path (same verdicts as full Levenshtein) |
| `Stores` | class | src/store.ts | two-scope manager: findGate/recordFailure/recordSuccess/migrate/expireAll/reconcileAll/forgetSession |
| `recordSuccess` | method | src/store.ts | heal streak + session-chain clearing (exact matches only) |
| `coerceGateShape` | fn | src/validate.ts | strict parse of a persisted gate record (hopeless → null) |
| `repairGate` | fn | src/validate.ts | mechanical repair: inverted dates, truncation, re-sanitize, demote, session-state hygiene |
| `hasNestedTokens` | fn | src/validate.ts | nested-placeholder corruption fingerprint |
| `atomicWrite` / `withLock` | fn | src/store.ts | Windows-safe fs primitives (ownership-verified unlock) |

## CONVENTIONS

- ESM (`"type": "module"`) + Bun runtime; scripts run directly (`bun scripts/x.ts`); no build, no bundling
- No semicolons, double quotes, explicit return types on everything, `node:` prefix on builtins
- No linter/formatter config exists — style is maintained by hand, match neighboring code
- JSDoc `/** */` on exports; inline `//` comments explain WHY (design rationale), not WHAT — ONE line max; multi-line comment essays are AI slop and get deleted
- Catch blocks swallow deliberately with a rationale comment; only `GateSignal` is rethrown
- Tunables are named UPPER_SNAKE constants grouped under `// --- Section ---` dividers

## ANTI-PATTERNS (THIS PROJECT)

- Do NOT scan read/edit/write output for failure text — it is file CONTENT, not command output (caused false gates); file-tool failures come exclusively from the event channel
- Do NOT surface a success-shaped line as failure evidence — `failureSnippet` scans from the end for a failure-shaped line, `looksLikeSuccess` rejects pass summaries, and `recordFailure` never overwrites a failure-shaped snippet with a success-shaped one; a gate that teaches "fix `17 passed`" is anti-teaching
- Do NOT quote a success-shaped or bare-`exit code` snippet in a correction — `suggestCorrection` falls back to family/generic text; `repairGate` re-derives machine template corrections that quoted a success line (human edits never match the fixed template and stay)
- Do NOT attribute a multi-producer chain failure to a single segment — the exit code does not say which producer failed; `nonTransparentProducers` must be exactly 1 or the failure records under the whole call (a diagnostic segment's gate must not be inflated by another producer's failure)
- Do NOT record noise as failure — `isNoiseError()` filters it on both channels: aborted/cancelled executions AND server-side unavailability (LSP daemon down, MCP transport, non-2xx) are not agent mistakes; client-side errors (4xx, ENOENT, syntax) stay teachable. Retroactively, `migrate()` backdates already-recorded noise gates to the epoch so the TTL sweep expires them
- Do NOT count exit 1 from diagnostic verbs (grep/tsc/pytest/curl/ls...) as failure — intended outcome; exit ≥ 2 always counts (OpenCode normalizes exits to 1, so discriminate by command shape)
- Do NOT flatten interpreter one-liner payloads (`python -c`, `node -e`, PowerShell `& "...\python.exe" -c @"..."@`) to `<str>` — the code IS the call; `hashInterpreterPayload` fingerprints it so distinct scripts never share a gate
- Do NOT enforce signatures without residual identity — if normalization parameterized the whole command away (`cmd <path> <str>`, `node <str> <n>`), it matches a command family; `hasResidualIdentity()` guards every tier, such shapes may only watch
- Do NOT keep `cmd /c` wrappers in signatures — `unwrapCmdWrapper()` normalizes the payload so identity and the diagnostic tier see the real verb
- Do NOT persist anything before `sanitizeForStore()` (control-char strip + secret scrub) — signatures, snippets, args, error text, logs; PowerShell VT colors in persisted text are a bug
- Do NOT throw from hooks except `GateSignal` — plugin bugs must never break the tool pipeline
- Do NOT let file-probe or diagnostic tools reach `blocking` status — `canBlock()` is the single source of truth; `migrate()` auto-demotes violations (diagnostics land in `reminding`, never `blocking`)
- Do NOT add Unix viewers (cat/head/tail/wc/less/more) to `DIAGNOSTIC_VERBS` — their exit 1 must stay RECORDABLE (a missing file / not-recognized is a real teachable failure, and `tail` as a terminal producer still counts); their never-block policy lives in `isUnixViewerSignature`
- Do NOT create gates manually — promotion is mechanical (3 failures × 2 sessions)
- Do NOT delete quarantine files (`gates.json.corrupt-*`, `log.jsonl.corrupt`) without inspection — they are the preserved forensic bytes of corrupted data
- Do NOT bypass the validation boundary — gates enter memory through `coerceGateShape`/`repairGate` (in `load()`/`loadForMutation()`) and structural healing through `reconcile()`; never hand-roll raw JSON reads/writes of store files. Use `loadForMutation()` (not a `load(true)` flag) inside locks — the write capability is in the name (`no-load-force-flag` ast-grep gate)
- Do NOT block in the post phase — the call already ran; `mapOutbound` canonical contract: post checks annotation FIRST (rides on allow, exit 0), only pre denies. An adapter that early-returns on `action === "allow"` before the annotation branch silently kills the reminding NOTE (the 2.39 pre-release bug)
- Do NOT write to stdout anywhere in `src/**` — the CLI's stdout is the harness's decision-JSON channel; diagnostics go to stderr (DEJAVU_DEBUG-gated in the CLI)
- Do NOT let adapters throw on malformed payloads — `mapInbound` returns `null` (CLI no-ops `{}` exit 0); harness JSON is untrusted external input and must cross `sanitizeForStore()` via the engine like everything else
- Do NOT make the CLI fail closed — any internal error prints `{}` and exits 0; a dejavu bug must never wedge the host's tool pipeline (usage errors exit 1, blocks exit 2)

## UNIQUE STYLES

- Two host forms, one engine: the OpenCode plugin (long-lived process, all channels incl. transform/compacting hooks) and the hook CLI (one short-lived process per hook event; fresh EphemeralState per invocation — repeat-series/pending-calls/dedup-window/iteration-discriminator degrade per-process BY DESIGN, gate enforcement does NOT: the remind→block chain is persisted on the gate). `createEphemeralState()` JSDoc is the contract
- Unified cross-harness store: adapters normalize tool names/arg fields BEFORE callSignature, so signatures are harness-neutral — a gate learned in Claude Code fires in OpenCode/Cursor/etc.; all hosts share `.opencode/dejavu/` + `~/.config/opencode/dejavu/` (paths are historical, the store is harness-neutral)
- Two-scope store: project gates in `<repo>/.opencode/dejavu/` (committable) escalate to global `~/.config/opencode/dejavu/` after appearing in 2+ project dirs (agent habits vs repo quirks) — except repo-local verbs (npm/git/gradle/docker/...), which are repo quirks by nature and stay project-scoped forever
- Three enforcement tiers: `blocking` (remind-abort, then hard-block on same-session repeat), `reminding` (diagnostics + Unix viewers — annotate the failing output, never interrupt), `watching` (evidence only); `fuzzySimilar` never merges disjoint flag sets but allows subset additions
- Self-healing stores: every init runs `reconcileAll()` — unparseable files are quarantined (bytes preserved in `*.corrupt-*`, never deleted), records are strictly parsed + mechanically repaired, index is reconciled, and every repair is logged (`repaired`/`quarantined` events); `doctor --repair` does the same on demand — one command replaces hand-debugging. The init-storm version-stamp skip is a STARTUP optimization only: `doctor --repair` and the migrate script call `migrate(force)` so an explicit repair always applies the full per-gate healing, even on a same-version re-run
- Multi-window safe: the remind→block chain is persisted on the gate, not in process memory — several OpenCode windows (each its own process on the shared store) and process restarts all see the same escalation; hot-path reads use a 1s TTL cache + O(1) key index
- `dejavu:proceed` escape hatch: trailing marker comment, matched with word boundaries, stripped before normalization so bypassed failures land on the original pattern
- `recurredAfterGate` is THE health metric — gates that fire without killing the error get `review: true`; its mirror `succeededAfterGate` heals gates — 3 consecutive successes on an enforced gate retire it to `watching`, so a fixed command stops reminding
- Enforcement has negative feedback: 3+ post-gate recurrences (across 2+ reoffense sessions) or 3+ explicit overrides (across 2+ distinct bypassing sessions) demote a gate to `watching` + `feedbackDemoted` (never re-promotes mechanically; `feedbackBaseline` gives a human re-enforcement a fresh grace window) — a gate the agent keeps fighting is friction, not teaching; BOTH votes need distinct sessions so one stubborn/injected session can't disarm a gate; overrides are counted on the gate (`overrideCount`/`overrideSessions`, blocking gates only), demotions log `demoted`
- The loop closes on success: a SUCCESS on an enforced gate clears that session from the remind→block chain (override + prove-the-fix leaves the session clean) and grows the heal streak — enforcement listens to behavior in both directions; iteration runners (`dart run`, `go run|build|test|vet`, `cargo run|build|test|clippy`) annotate the failing output but never interrupt or block
- Taught retirement: a gate reminded 5+ times with zero reoffense has taught its lesson (no success can ever heal it — the agent changed behavior) and retires to watching (`retired-taught`); re-promotion on new failures stays possible. Blocking fires it in the before-hook (`recurredAfterGate === 0`); reminding fires it in the after-hook at one reminder higher (`recurredAfterGate` grows structurally there, so only `recurredAfterReminder === 0` is the teachability signal) — the extra round keeps it from preempting anti-nag evidence
- Retirement damping: a healed/taught-retired gate keeps its lifetime `count`/`sessions`, which alone would clear the promotion bar and re-promote it on the very next single failure (a promote→heal→promote loop). Retirement captures `retireBaseline.count`; re-promotion needs a full fresh bar of failures since retirement (`count − retireBaseline.count ≥ threshold`). Doctor's FLAPPY report watches for the oscillation
- `promotionCount` is the lifetime promotion counter (never reset, merge-summed) — the rot-proof FLAPPY signal; doctor escalates it at `>= 3`. `lastInitVersion` is stamped by `save()` with the writer's own version — the durable version-drift signal (log init events rotate away)
- Cross-channel dedup: one tool call must never be counted twice — the after-hook (exit/text) and the event stream (error parts) are disjoint by construction, but a runtime guard keyed on (key, session) + channel-mismatch window counts a double-firing call once (doctor's CROSS-CHANNEL DOUBLE-COUNT is the observable tripwire). The dedup key is the WHOLE-CALL signature, not the segment-attributed key — the event channel signs the entire call, so a chained command must dedup on one shared identity or it slips through on mismatched keys
- Global forensics for deferred events: deferred events bypass `logAll`'s routing, so the project store mirrors its salient deferred events (`demoted`/`retired-healed`) into the global log via `routeSalientTo` — direct events are not mirrored there (logAll already routes them)
- Windows-first fs: `\\?\` long-path prefix, tmp+rename with EPERM/EACCES/EBUSY backoff, lockfile with stale-steal and 3s degrade-to-unlocked (never hang the tool pipeline). Same-process callers (parallel tool calls in one window) serialize on an in-process queue BEFORE the file lock and never degrade — the 3s degrade is cross-process only. A transiently-unreadable store (EISDIR/EPERM/AV lock, not ENOENT) THROWS instead of parsing as empty, so a failed read can never let the next save clobber real gates

## GIT HOOKS

- commit-msg hygiene hook: `scripts/githooks/commit-msg` — header ≤100 chars, no emoji, no AI attribution trailers; matches trailer structure, so plain tool-name mentions pass
- Activate once per clone: `git config core.hooksPath scripts/githooks`

## COMMANDS

```bash
bun install
bun run typecheck            # tsc --noEmit — covers index.ts, src/**, scripts/**, test/**
bun test/smoke.ts            # full behavioral test; exit 1 on any failure
bun test/enforce.ts          # engine characterization (harness-agnostic core)
bun test/adapters.ts         # adapter mapping + decision dialects
bun test/cli.ts              # CLI end-to-end (spawn, promotion, block/annotate, fail-open)
bun test/language-gaps.ts    # language-ecosystem coverage of patterns.ts
bun test/guards.ts           # proactive guards characterization (fire shapes, precedence, bypass warnings)
bun test/messages.ts         # teaching-text framing (tier-truthful, data-label, storeDir-derived path)
bun test/property.ts         # seeded-generator invariants (normalization, capped-fuzzy equivalence, substitutions)
bun test/fuzz.ts             # mutation fuzz: no crash, no invariant break
bun test/install.ts          # installer e2e (install/uninstall/hooks --check, backup, foreign-hook survival)
bun test/v2-host.ts          # OpenCode V2 dual-export characterization (server() parity with V1 Dejavu)
bun test/cline-plugin.ts     # Cline plugin host characterization (beforeTool skip/afterTool appendContext over a temp store)
bun run lint:ast             # ast-grep structural gates (.ast-grep/rules/); needs ast-grep on PATH
bun scripts/doctor.ts [projectDirs...]
bun scripts/analyze.ts [projectDirs...]
bun scripts/migrate.ts <projectDirs...>
bun scripts/install-hooks.ts --harness <claude|codex|gemini|cursor|copilot|crush|devin|kiro> [--user|--project] [--dry-run]
```

## NOTES

- `tsconfig.json` covers `index.ts`, `src/**`, `scripts/**`, `test/**` — everything typechecks
- CI: GitHub Actions (`bun install --frozen-lockfile` + typecheck + smoke + enforce + adapters + cli + language-gaps + guards + messages + property + fuzz + install + v2-host + cline-plugin + `ast-grep scan`) on every push/PR
- Structural gates live in `.ast-grep/rules/` + `sgconfig.yml`: `no-load-force-flag` forbids `load(true)`/`loadIndex(true)` (use the named `loadForMutation()`/`loadIndexForMutation()`). Add a gate here when a bug class is structurally repeatable; sabotage-test it (introduce the bug shape → gate must fire)
- Install = npm (`{ "plugin": ["dejavu-gates"] }`) or clone + re-export from `~/.config/opencode/plugins/dejavu.ts` (see README); other harnesses via `scripts/install-hooks.ts`
- `DEJAVU_HOME` env var overrides the global store dir — smoke test and scripts rely on it
- Bump `PLUGIN_VERSION` (src/store.ts) on behavior changes — doctor detects version drift via `init` log events — AND keep `package.json` `version` in sync (npm publish uses the package version)
- gates.json files are human-editable by design: delete a gate object to disable, edit `correction` to teach
