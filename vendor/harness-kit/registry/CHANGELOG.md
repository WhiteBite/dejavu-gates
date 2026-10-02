# Registry changelog

Format: keep-a-changelog. `registryVersion` follows semver:
MAJOR removes/renames keys or changes meaning, MINOR adds harnesses or fields, PATCH is notes and typos.
Keys are never deleted - they are deprecated in place (forward compatibility for vendored consumers).

## 0.1.0

- Initial reconciled registry: 14 harness entries (claude, codex, opencode, gemini, qwen, cursor, windsurf, aider, cline, kiro, devin, copilot, crush, git) extracted from three independent implementations (dejavu-gates install-config/templates, stop-ai-slop install.mjs/pretool, repo-aeo skill.js) and reconciled to single canonical facts.
- Conventions block: ownership sidecar + substring fallback, owner-scoped strip-then-append merge, print-only user-scope default, LF/UTF-8, path placeholders.
- Statuses: qwen and crush experimental (shapes not empirically verified), copilot preview (upstream feature status), the rest stable (observed working in at least one family tool).
