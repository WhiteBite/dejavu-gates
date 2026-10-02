---
name: dejavu
description: Protocol for working with the dejavu error-gate plugin. Use when a tool call is answered with a "[dejavu] REMINDER" or "[dejavu] BLOCKED" message, when the same tool call fails repeatedly, or when you discover the root cause of a gated failure. Covers how to react to reminders, what BLOCKED means, the dejavu:proceed escape hatch, and how to improve gate corrections in .opencode/dejavu/gates.json.
---

# dejavu — recurring-error gates

dejavu is an OpenCode plugin that watches tool calls fail, counts recurrences across sessions, and promotes frequent failures into **gates**. It is your external long-term memory for mistakes: what failed before will not silently fail again.

You do not manage dejavu's detection — it is mechanical. Your job is to react correctly and to improve gate quality when you learn something.

## When you get `[dejavu] REMINDER`

The call you were about to make has failed repeatedly in the past. The call was aborted before execution.

1. **Do not retry the identical call.** That is exactly the behavior the gate exists to prevent.
2. Read `Last failure:` and `Correction:` in the message.
3. Diagnose the root cause (read the relevant file, check the environment, run a diagnostic command).
4. Retry with a **changed** approach — a different command, fixed arguments, or a prerequisite step first.
5. If you are confident the situation changed (e.g. you just installed the missing dependency), retry as-is — a SUCCESS clears your session from the gate's chain. On a blocking gate, a repeated failure after a reminder escalates it to a hard block within this session; a reminding gate (diagnostics/iteration commands) never blocks, it only reminds.
6. `dejavu:proceed` (as a trailing COMMENT inside the call — `# dejavu:proceed`) bypasses the gate. Use it ONLY when the user explicitly asked you to force the operation, or you have concrete proof the gate is stale. Every override is logged; on blocking gates it is ALSO counted on the gate, and repeated overrides demote the gate (your bypasses are feedback: a gate everyone works around retires itself). If you override and the call SUCCEEDS, say so when improving the gate — that proves it stale.

## When you get `[dejavu] BLOCKED`

You were reminded, retried, and it failed again. The gate is now hard in this session.

- Do not attempt the same call again in any form that matches the pattern.
- Tell the user what is blocked and why (the message contains evidence and the gate file path).
- Choose a fundamentally different approach to reach the goal.
- If you discover the root cause, record it as a one-line `correction` on that gate (the block message points at it): `dejavu lesson set <key> "<fix>"`.

## Improving gates (your one write privilege)

Gates live in `.opencode/dejavu/gates.json` (project) and `~/.config/opencode/dejavu/gates.json` (global agent habits). The files are human- and agent-editable.

When you discover the **root cause** of a gated failure, update the gate's `correction` field with a one-line actionable instruction (what to do instead, not what to avoid). Example: `"correction": "Use 'npm install --legacy-peer-deps' — this repo has conflicting peer deps"`.

The supported way to review and write that field without hand-editing JSON is `dejavu lesson list` (shows which corrections are still machine-generated) and `dejavu lesson --author agent set <key> "<fix>"` (you are the agent, not the owner) — it can only write onto an existing gate, never create one.

Do NOT:
- create gates manually (promotion is mechanical: 3 failures across 2 sessions),
- weaken or delete gates without telling the user,
- stuff prose into `correction` — one actionable line only.

## What dejavu tracks

- `bash` commands that exit non-zero or print error signatures (normalized: paths/numbers/hashes abstracted)
- `read`/`edit`/`write` failures on files (via tool-level error events)
- counts, distinct sessions, distinct projects; patterns seen in 2+ projects become global (they are your habits, not the repo's quirks)

Gates expire after 60 days without recurrence. Gates listen to behavior in both directions: a gate whose error keeps recurring under enforcement (3+ times) or that gets overridden repeatedly (3+ overrides across 2+ distinct sessions on blocking gates) demotes itself to `watching` + `feedbackDemoted` and stops enforcing — if you later learn it was right, a human re-enforces it by setting its `status` back to `blocking`/`reminding` AND clearing `feedbackDemoted` in gates.json (the gate gets a fresh grace window). A gate blocked 10+ times is flagged `review: true` in its file. A gate that taught its lesson (reminded 5+ times, never reoffended) retires softly too — if a retired gate starts failing again, it re-promotes on its own.

## Bash hygiene (avoid hangs)

- Never pipe/redirect the stdout of a spawn/start command (`… start | Out-Null`, `… start > $null`): the spawned process keeps the stdio handle open and the call only ends on stdio EOF — it hangs until its timeout. Run the spawn bare (it prints 1-3 lines) and poll status in a SEPARATE call.
- Long suites: pass an explicit `timeout` close to the expected wall time, not a padded one. A call killed at its timeout is recorded as a failure and will gate itself — with a correction teaching exactly this.

## When you get `[dejavu] REPETITION` (note) or `[dejavu] REPEAT BLOCKED`

You issued the identical tool call (same tool, same arguments) in several consecutive rounds. DashScope/Qwen hard-rejects such histories (HTTP 400), and one rejection poisons the session permanently — dejavu mutates the outgoing payload to prevent that and now asks you to break the loop.

1. Do NOT re-issue the identical call. Change the arguments (readers: `since_message_id` / `from_end` / `limit`) or take a different approach entirely.
2. Never poll background tasks with identical calls - wait for the completion notification instead.
3. `_dejavu_proceed: true` in the call args bypasses a REPEAT BLOCK (logged). Use it only when the user explicitly asked you to force the operation.

## When you get `[dejavu] REPEAT STOP`

The same call was already blocked several times in a row. The plugin is telling you the session-level truth: retrying cannot succeed.

1. STOP this line of work entirely. Do not re-issue the call, do not rename it, do not work around it.
2. Finish with what you already have and report partial results to whoever launched you (orchestrator/user).
