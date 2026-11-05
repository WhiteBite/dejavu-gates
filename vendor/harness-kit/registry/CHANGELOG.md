# Registry changelog

Format: keep-a-changelog. `registryVersion` follows semver:
MAJOR removes/renames keys or changes their meaning (a structural break that breaks consumer code), MINOR adds harnesses, fields or additive blocks and also covers fact VALUE changes (a moved path or corrected container - consumer code does not change, the lockfile/`diff` surfaces it), PATCH is notes and typos.
Keys are never deleted - they are deprecated in place (forward compatibility for vendored consumers).

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
