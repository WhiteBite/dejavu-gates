# Registry changelog

Format: keep-a-changelog. From package 0.10.0, `registryVersion` mirrors the package `version` (one version everywhere; `version:sync` sets it) and new entries are keyed by the package version. The semver contract below describes the historical registry-only versions (through 0.6.0):
MAJOR removes/renames keys or changes their meaning (a structural break that breaks consumer code), MINOR adds harnesses, fields or additive blocks and also covers fact VALUE changes (a moved path or corrected container - consumer code does not change, the lockfile/`diff` surfaces it), PATCH is notes and typos.
Keys are never deleted - they are deprecated in place (forward compatibility for vendored consumers).

## 0.6.0

- Add 2 experimental harness rows: `zcode` (ZCode - JSON config, 7 lifecycle hook events under `hooks.events`, skills roots, MCP under the nested `mcp.servers` key; hooks and MCP are print-only) and `deepseek` (DeepSeek Harness - Cordis YAML composition, no hook/MCP JSON file surface; skills roots only).
- Orca (stablyai/orca) is deliberately NOT a row: it is an agent orchestrator, not a config-host harness; its `orca.yaml` declares worktree-lifecycle hooks (setup/archive), not agent-event hooks.

## 0.5.0

- Add 9 experimental harness rows (goose, hermes, openhands, continue, junie, oh-my-pi, pi, kimi-code, amp) with sourced config/hook/MCP facts; MCP write enabled (`merge`) only for oh-my-pi and pi (json + `${VAR}` interpolation).

## 0.4.0

- Enable owner-scoped MCP server-map merge (`mergeMcpServers`); flips the 6 JSON env-interpolated mcp rows (claude, gemini, cursor, windsurf, kiro, factory) from `print-only` to `write: "merge"`.
- Non-JSON (codex toml, opencode jsonc) and literal-token/panel-managed rows (vscode, cline, roo, zed) stay `print-only`.

## 0.3.0

- Add `verified: { against, at }` provenance to harness rows (and to `mcp` blocks): where and when a fact was checked. `status: "stable"` rows must carry it, so an unverified fact cannot land silently (the class of bug behind the earlier wrong copilot dialect).
- Backfilled the 11 stable rows with `against: "observed in at least one family installer"`, `at: "2026-10-03"`. MCP blocks stay `experimental` (no `verified`).

## 0.2.0

- New `mcp` block per harness: MCP client config as a keyed map (config paths, format, container key, url field, type field/value, token-env syntax). All MCP blocks are `status: "experimental"` with a `source` (remote-devbox-mcp/home/rdm/prompt.py) and a `note` naming what to verify - none are verified against a live host yet.
- Added 8 `mcp` blocks to existing rows (claude, codex, opencode, gemini, cursor, windsurf, cline, kiro) and 4 MCP-only rows (vscode, roo, zed, factory), all `experimental`.
- Schema: tolerant `mcp` object; `format` is json|jsonc|toml; non-JSON formats are print-only by convention.

## 0.1.0

- Initial reconciled registry: 14 harness entries (claude, codex, opencode, gemini, qwen, cursor, windsurf, aider, cline, kiro, devin, copilot, crush, git) extracted from three independent implementations (dejavu-gates install-config/templates, stop-ai-slop install.mjs/pretool, repo-aeo skill.js) and reconciled to single canonical facts.
- Conventions block: ownership sidecar + substring fallback, owner-scoped strip-then-append merge, print-only user-scope default, LF/UTF-8, path placeholders.
- Statuses: qwen and crush experimental (shapes not empirically verified), copilot preview (upstream feature status), the rest stable (observed working in at least one family tool).
