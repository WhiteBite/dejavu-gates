> [!IMPORTANT]
> **`opencode-dejavu` is DEPRECATED — the project continues as [`dejavu-gates`](https://www.npmjs.com/package/dejavu-gates).**
> Repo: [`github.com/WhiteBite/dejavu-gates`](https://github.com/WhiteBite/dejavu-gates) (the old repo URL redirects there).
> - **OpenCode config:** `{ "plugin": ["opencode-dejavu"] }` → `{ "plugin": ["dejavu-gates"] }`
> - This stub version re-exports the new engine, so an un-migrated config still runs the current dejavu — but it pulls an extra dependency hop; migrate and uninstall this package.
> - Versions ≤ 2.27.0 are the frozen OpenCode-only plugin; everything from 2.39.0 (cross-harness: Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush) lives in `dejavu-gates`.

# opencode-dejavu → dejavu-gates

Cross-session **error gates** for AI coding agents: detects recurring tool-call failures and promotes them into enforced gates — a reminder on the next attempt, a hard block on same-session repeat offense.

Install the real package:

```bash
npm install dejavu-gates
```

```jsonc
// ~/.config/opencode/opencode.json (global) or opencode.json (project)
{ "plugin": ["dejavu-gates"] }
```

Full docs, harness matrix and hook-CLI installer: [github.com/WhiteBite/dejavu-gates](https://github.com/WhiteBite/dejavu-gates).

## License

MIT
