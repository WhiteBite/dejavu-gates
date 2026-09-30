# awesome-list PRs: text + fork strategy

Target repos:

- https://github.com/awesome-opencode/awesome-opencode (PLUGINS section)
- https://github.com/ccplugins/awesome-claude-code-plugins (Workflow Orchestration section)

Canonical repo for both entries: `https://github.com/WhiteBite/dejavu-gates` (npm `dejavu-gates`, current release 2.42.1). Old name `opencode-dejavu` redirects; do not use it in new listings.

Positioning line (consistent with README): cross-session error gates for AI coding agents. Mechanical recurrence detection, remind to block escalation, one store across 10 harnesses.

## Format verification (fetched upstream READMEs)

### awesome-opencode

List format is NOT a flat bullet list. Each plugin is a collapsible `<details>` block inside an open `<details><summary>🧩 PLUGINS</summary>` wrapper. Verbatim skeleton of a neighboring entry:

```html
<details>
  <summary><b>Handoff</b> <img src="https://badgen.net/github/stars/joshuadavidthomas/opencode-handoff" height="14"/> - <i>Session handoff prompts</i></summary>
  <blockquote>
    Creates focused handoff prompts for continuing work in a new session.
    <br><br>
    <a href="https://github.com/joshuadavidthomas/opencode-handoff">🔗 <b>View Repository</b></a>
  </blockquote>
</details>
```

Conventions observed:

- summary: bold display name, badgen stars img (`height="14"`), ` - `, italic one-line tagline
- blockquote: 1-3 sentence description, then `<br><br>`, then `🔗 <b>View Repository</b>` link
- ordering: case-insensitive alphabetical by display name (live D-block: Devcontainers, Direnv, Dodo Payments, Dynamic Context Pruning). Dejavu slots after CrewBee, before Devcontainers ("dej" < "dev").
- Official Repositories table at top is separate (stars-column table); plugins are not in it.

### ccplugins/awesome-claude-code-plugins

Bullet list under category headings (`### Workflow Orchestration` etc.), no star badges, no tables in the Plugins sections. Two delimiter styles coexist; hyphen ` - ` is the plurality style:

```markdown
- [claude-recap](https://github.com/hatawong/claude-recap) — Per-topic session memory using Shell hooks — archives each conversation topic as a separate Markdown summary. Two hooks, bash + Node.js, 100% local.
```

Conventions observed:

- `- [name](url) - one-line description` — both delimiters are used in practice: em-dash ` — ` entries include claude-brain, claude-recap, nexus-agents, magebyte-power, Claude Forge, bobusang, devforge-ai; hyphen ` - ` is the plurality (agent-triforce, artel, equilateral-agents, now-next-methodology, pro-workflow, claude-memory-manager). Our entry uses the hyphen.
- Within-category ordering is loose (not strictly alphabetical); append at end of the chosen category block
- Category choice: Workflow Orchestration (memory/hooks across sessions fits there; Code Quality Testing is the alternative if maintainers prefer)
- Contributing section says contributions welcome; no explicit PR template found in README

## PR body 1: awesome-opencode

Title: `Add dejavu (error gates for AI coding agents)`

Body:

````markdown
Adds dejavu to PLUGINS.

<details>
  <summary><b>Dejavu</b> <img src="https://badgen.net/github/stars/WhiteBite/dejavu-gates" height="14"/> - <i>Cross-session error gates: recurring tool-call failures become enforced reminders and blocks</i></summary>
  <blockquote>
    Detects repeated tool-call failures mechanically (3 failures across 2 sessions promote a gate), then reminds on the next attempt and hard-blocks same-session repeats. Gates persist across sessions and share one store across OpenCode, Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro and Cline, so a pattern learned in one harness enforces in all. TypeScript + Bun, ships as source, no build step. Install: { "plugin": ["dejavu-gates"] } in opencode.json.
    <br><br>
    <a href="https://github.com/WhiteBite/dejavu-gates">🔗 <b>View Repository</b></a>
  </blockquote>
</details>

Insert after the CrewBee entry, before Devcontainers (alphabetical by display name).
````

Diff shape: one `<details>` block, no reformatting of surrounding entries.

## PR body 2: ccplugins/awesome-claude-code-plugins

Title: `Add dejavu-gates to Workflow Orchestration`

Body:

````markdown
Adds one entry under Workflow Orchestration:

- [dejavu-gates](https://github.com/WhiteBite/dejavu-gates) - Cross-session error gates for AI coding agents. Mechanically detects recurring tool-call failures, escalates remind to block within a session, and shares one gate store across Claude Code, OpenCode, Codex, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro and Cline. Install: `claude plugin marketplace add WhiteBite/dejavu-gates` then `claude plugin install dejavu-gates@dejavu-marketplace`.

One-line diff, no reformatting.
````

Diff shape: one bullet appended to the `### Workflow Orchestration` block.

## Fork strategy (two real forks)

PRs to a GitHub repo must come from a fork in that repo's fork network — a branch pushed to an unrelated repo can't open a PR, and a `--private` repo can't PR to a public upstream at all. So: one real fork per upstream, created with `gh repo fork`.

```powershell
# PR 1: awesome-opencode
gh repo fork awesome-opencode/awesome-opencode --clone=true --remote=true
cd awesome-opencode
# default branch is already main; gh added origin=fork + upstream=source
git checkout -b add-dejavu
# edit README.md: insert the Dejavu <details> block after CrewBee, before Devcontainers
git add README.md
git commit -m "add dejavu to plugins list"
git push -u origin add-dejavu
gh pr create --title "Add dejavu (error gates for AI coding agents)" `
  --body-file dejavu-body.md   # extract PR body 1 section first

# PR 2: ccplugins/awesome-claude-code-plugins
cd ..
gh repo fork ccplugins/awesome-claude-code-plugins --clone=true --remote=true
cd awesome-claude-code-plugins
git checkout -b add-dejavu-gates
# edit README.md: append the dejavu-gates bullet to Workflow Orchestration
git add README.md
git commit -m "add dejavu-gates to workflow orchestration"
git push -u origin add-dejavu-gates
gh pr create --title "Add dejavu-gates to Workflow Orchestration" `
  --body-file dejavu-body.md   # extract PR body 2 section first
```

`gh repo fork` prints the created fork name (`WhiteBite/awesome-opencode`, `WhiteBite/awesome-claude-code-plugins`) and sets `upstream` to the source repo, so no manual `git remote add` is needed. None of the above was executed from this repo.

Keep branches fresh while PRs are open (run inside each fork clone):

```powershell
git fetch upstream main
git rebase upstream/main   # resolve any alphabet-position drift
git push --force-with-lease origin add-dejavu
```

## PR etiquette

- One-line / one-block diff. Never reformat or reorder existing entries, even if their style is inconsistent (both lists have mixed em-dash vs hyphen delimiters; match the neighbors, don't fix them).
- Insert at the correct alphabetical slot in awesome-opencode (case-insensitive by display name); append at end of the category block in ccplugins (ordering there is loose).
- Entry text: factual, no superlatives, no emoji except the list's own fixed `🔗 View Repository` convention in awesome-opencode.
- Stars badge URL must point at the canonical repo (`WhiteBite/dejavu-gates`), not the deprecated `opencode-dejavu` redirect.
- Link the repo in the entry itself; PR body stays minimal (what + where inserted).
- If a maintainer requests changes, amend on the same branch and `--force-with-lease`; do not open a second PR.

## Concerns / residual risk

- awesome-opencode entries carry live star badges; nothing to sync, but the badge URL breaks if the repo is renamed again. The rename notice in our README should stay valid until both PRs merge.
- ccplugins README has duplicate-ish categories (Thinking & Knowledge Management vs Knowledge Management); Workflow Orchestration was chosen because sibling memory/session entries (claude-recap, claude-memory-manager) live there. Maintainer may relocate; low cost.
- Both bodies above are final text; extract each into its own file (e.g. `dejavu-body.md`) before running `gh pr create --body-file`.
