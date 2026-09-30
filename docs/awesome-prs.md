# awesome-list PRs: text + fork strategy

Canonical repo for all entries: `https://github.com/WhiteBite/dejavu-gates` (npm `dejavu-gates`, current release 2.43.0). Old name `opencode-dejavu` redirects; do not use it in new listings.

Positioning line (consistent with README): cross-session error gates for AI coding agents. Mechanical recurrence detection, remind to block escalation, one store across 10 harnesses.

All facts below verified against upstream repos via the GitHub API on 2026-09-30. No PRs/forks/issues were created from this repo.

## Coverage matrix

| List | Harness | Mode | Status (verified) | Entry ready |
|---|---|---|---|---|
| awesome-opencode/awesome-opencode | OpenCode | PR (`data/plugins/*.yaml`) | stalled since 2026-07-03; ~378 open PRs, last merge 2026-07-03; our PR #637 open since 2026-08-23, CI run failed, unreviewed | yes (rewrite, see section) |
| ccplugins/awesome-claude-code-plugins | Claude Code | PR (README bullet) | last merge 2026-08-12, ~243 open PRs backlog | yes |
| hashgraph-online/awesome-codex-plugins | Codex CLI | PR (+ scanner gate) | active, merges daily | yes, gated on repo prep |
| RoggeOhta/awesome-codex-cli | Codex CLI | issue or PR | slow intake, 272 open issues | yes |
| Piebald-AI/awesome-gemini-cli-extensions | Gemini CLI | PR (README bullet) | very active, merges within days | yes |
| Piebald-AI/awesome-gemini-cli | Gemini CLI | PR (README bullet) | very active | yes |
| Official Gemini gallery (geminicli.com) | Gemini CLI | GitHub topic, no PR | auto-crawl; we are invisible today | action: add topic |
| github/awesome-copilot | Copilot CLI | issue form (external plugin), never PR | active, heavy governance | yes (form payload) |
| hao-ji-xing/awesome-cursor | Cursor | PR (README bullet) | alive (pushed 2026-09-07), small (90★) | yes |
| cline/marketplace | Cline | PR (`registry/plugins/<slug>/entry.json`) | official org, active (last merge 2026-09-18) | yes (entry.json draft) |
| kirodotdev-labs/awesome-kiro | Kiro | PR (README bullet) | quiet since 2026-05-02, open PRs since June unmerged | yes |
| bradAGI/awesome-cli-coding-agents | general (all CLIs) | PR (README bullet) | active (updated 2026-09-28) | likely out of scope |
| hesreallyhim/awesome-claude-code | Claude Code | web-form issue only, PRs forbidden | active, huge (54.8k★) | yes (form payload) |
| anthropics/claude-plugins-official | Claude Code | external form (clau.de) | official directory | form exists |
| Crush | — | none | no list exists; Discussions on charmbracelet/crush only | n/a |
| Devin CLI | — | none | no list exists (name traps below) | n/a |
| Official OpenAI plugin directory | Codex CLI | dashboard ZIP upload | hooks plugins currently cannot be submitted | blocked upstream |

Rejected / closed to external entries:
- PatrickJS/awesome-cursorrules (40.8k★) — rules-only; PR checklist explicitly: "This is not a standalone external tool, product, directory, marketplace, or service listing." Also blocks PRs from accounts younger than 30 days.
- sanjeed5/awesome-cursor-rules-mdc — `.mdc` rule files only.
- spencerpauly/awesome-cursor-skills — Plugins section scoped to official-marketplace vendor integrations.
- cline/mcp-marketplace — MCP servers only, stale (~15 months).
- e2b-dev/awesome-devins — "Devin-inspired agents", not the Devin CLI. detailobsessed/awesome-devin — actually a Windsurf list (name trap).
- milisp/awesome-codex-cli — paid placement ($29/mo) + maintainer self-featuring; skip on integrity grounds.
- All skills/subagents lists (composio-community/awesome-codex-skills, VoltAgent/*, jshsakura/awesome-opencode-skills) — SKILL.md format only, wrong shape.
- Official OpenAI plugin directory — lifecycle-hooks plugins "cannot currently be submitted" per docs.

## Format verification (fetched upstream READMEs)

### awesome-opencode

IMPORTANT correction vs the first draft of this doc: the list moved to a data-driven pipeline. README is auto-generated; contributors do NOT edit it. Per `contributing.md` (lowercase filename): add a kebab-case YAML file under `data/plugins/`, fields `name`, `repo`, `tagline` (max 120 chars), `description`; commit message style `docs: add <name> to plugins`. Schema at `data/schema.json` also allows optional `scope` (global/project), `tags`, `min_version`, `homepage`, `installation`.

Health warning: last merged PR 2026-07-03 (#408); since then maintainers mass-close without merging (recent closed PRs #784/#783/#698 all unmerged), ~378 open PRs pending. Most validation runs sit in `action_required` (first-time-contributor workflow approval), some fail. Our existing PR #637 (opened 2026-08-23, old hand-edited README era, later converted to `data/plugins/opencode-dejavu.yaml`) sits open with a failed CI run and zero reviews. Treat any new submission here as a lottery ticket, not a channel.

PR #637 problems to fix in a replacement (close #637 yourself, open fresh):
1. YAML points at the deprecated `opencode-dejavu` URL — must be `https://github.com/WhiteBite/dejavu-gates`.
2. The Validate PR YAML Files run concluded `failure` — the entry needs a local schema check before resubmission (`node scripts/validate.js data/plugins/dejavu-gates.yaml` after `npm ci` in a clone; ajv+js-yaml are the deps).
3. File should be renamed `dejavu-gates.yaml` (kebab-case matching the project).

Replacement `data/plugins/dejavu-gates.yaml`:

```yaml
name: dejavu
repo: https://github.com/WhiteBite/dejavu-gates
tagline: Cross-session error gates for recurring tool-call failures
description: >-
  Mechanically detects recurring tool-call failures (3 failures across 2 distinct sessions
  promote a gate) and enforces them: reminder on the next attempt, hard block on same-session
  repeat offense. Diagnostics never block, they annotate. Two-scope store with secret scrubbing
  and control-char stripping before persistence, 60-day TTL, self-healing reconcile, doctor
  report. One harness-neutral store shared with Claude Code, Codex CLI, Gemini CLI, Cursor,
  Copilot CLI, Crush, Devin CLI, Kiro and Cline. TypeScript + Bun, ships as source, no build step.
installation: |
  { "plugin": ["dejavu-gates"] } in opencode.json (V1 key "plugin", V2 key "plugins")
```

### ccplugins/awesome-claude-code-plugins

Bullet list under category headings (`### Workflow Orchestration` etc.), no star badges. Two delimiter styles coexist; hyphen ` - ` is the plurality style:

```markdown
- [claude-recap](https://github.com/hatawong/claude-recap) — Per-topic session memory using Shell hooks — archives each conversation topic as a separate Markdown summary. Two hooks, bash + Node.js, 100% local.
```

Conventions observed:

- `- [name](url) - one-line description` — both delimiters used in practice; our entry uses the hyphen.
- Within-category ordering is loose; append at end of the chosen category block.
- Category choice: Workflow Orchestration (sibling memory/session entries live there). Note: an "Add metodo plugin (Workflow Orchestration)" PR (#577) was opened 2026-09-29 — expect competition for the slot position, harmless for us.
- Health: last merge 2026-08-12, ~243 open PRs. Slowing but not dead; budget for weeks of latency.

Entry text (unchanged from PR body 2 below).

### hashgraph-online/awesome-codex-plugins (Codex)

1,103★, merges daily (e.g. #452/#453 merged 2026-09-28). Contribution = one README line under a category, alphabetical by display name (CI-enforced), single sentence, link to repo root:

```markdown
- [done-gate](https://github.com/kuroudo-ai/done-gate) - Stop hook that blocks "fixed/done" claims when no test output or exit code appeared in that turn (Claude Code & Codex, MIT).
```

Category: Development & Workflow (host-side peers: Agent Guard, Anchor, done-gate). Ordering is alphabetical by display name within the section — locate the exact "Dejavu" slot against the live README at PR time.

Hard gate — the HOL AI Plugin Scanner. The catalog clones OUR source repo (`git clone owner/repo` → `plugin_dir: $RUNNER_TEMP/contributed`, `min_score: 80`, `fail_on_severity: high`); mirrored copies under `plugins/` are generator output and irrelevant to scoring. Required in the source repo:

- `.codex-plugin/plugin.json` — valid manifest: `name` (kebab-case), semver `version`, `description`, `repository`, `license`, plus `interface.displayName`, `interface.shortDescription`, `interface.composerIcon`. Strictly required; no hooks-only alternative.
- `SECURITY.md` (we have one locally, untracked — commit it), `LICENSE` (have), `README.md` (have).
- Icon ≤50KB referenced from the manifest.
- Points also scored (not pass/fail alone): SHA-pinned Actions, Dependabot config, lockfiles, no secrets, no `eval`/shell-injection patterns. Total 130, threshold ≥80 normalized.

Local reproduction: `pipx install --force "plugin-scanner==3.12.2"` then `plugin-scanner scan . --format text`. Known false-positive classes documented in their issue #390 (prose SQL keywords, documented prohibitions naming sensitive paths) — if the score looks unearned, cite that issue rather than contorting code. Remediation loop closes on source-repo commits + centralized re-sweep (cron or maintainer rerun); example: PR #457 went 75→83 after source fixes.

Prep work in dejavu-gates before submitting (out of scope for this doc, tracked here as prerequisite): add `.codex-plugin/plugin.json` + `assets/icon.svg`, commit SECURITY.md, pin Actions SHAs, add dependabot.yml. Root `plugin.json` (Codex-style, currently version-stale at 2.42.1) suggests the packaging intent already exists; the scanner wants the `.codex-plugin/` path specifically.

Draft entry (post-prep):

```markdown
- [dejavu-gates](https://github.com/WhiteBite/dejavu-gates) - Cross-session error gates that detect recurring tool-call failures and escalate remind to block, with one shared store across Codex, Claude Code, OpenCode, Gemini CLI, Cursor and more (MIT).
```

### RoggeOhta/awesome-codex-cli (Codex)

537★, pushed 2026-09-06. Dedicated **Hooks** section ("User-defined shell scripts that run at specific points in the agentic loop") — exact fit. Format requires `owner/repo` label + shields.io star badge:

```markdown
- [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) - OmX (Oh My codeX) - add hooks, agent teams, HUDs, and more to your Codex CLI. The most popular hooks framework. ![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-codex?style=flat-square)
```

Mode: issue ("Open an issue with the link and a brief description of why it's awesome") or fork+PR; maintainer merges in batches. Red flags: 272 open issues, several open unmerged PRs — slow. Explicit rejection rule: "Self-promotion without substance — your project needs real users or a clear unique value." With 6 repo stars the honest play is the issue route framed on unique value (cross-harness gate store is genuinely unoccupied), not volume.

Draft Hooks entry:

```markdown
- [WhiteBite/dejavu-gates](https://github.com/WhiteBite/dejavu-gates) - Error gates for Codex CLI hooks: recurring tool-call failures are promoted into enforced remind/block gates sharing one store with 9 other agent harnesses. ![GitHub stars](https://img.shields.io/github/stars/WhiteBite/dejavu-gates?style=flat-square)
```

Draft issue (title `Add dejavu-gates (hooks-based error gates)`):

```markdown
Link: https://github.com/WhiteBite/dejavu-gates

Why: hooks that learn. Existing hook collections run static, human-authored policies; dejavu watches PostToolUse failures, promotes a pattern after 3 failures across 2 sessions, and blocks repeats in-session. Signatures are harness-neutral, so a gate learned in Claude Code fires in Codex and vice versa (shared store). PreToolUse deny + PostToolUse annotation both exercised via the claude-compatible dialect Codex speaks. Install: `npx -y dejavu-gates install --harness codex`. MIT, TypeScript + Bun, no build step.
```

### Piebald-AI/awesome-gemini-cli-extensions (Gemini CLI)

68★ but the fastest-moving target found: PRs merged within 1-2 days (#45-#47 merged 2026-09-26..28). CONTRIBUTING: format `- [**Project Name**](URL) - Description` (bold-name variant), append to bottom of section; entries must be actual installable extensions (`gemini-extension.json` at root — we ship it). Hook-based extensions live under **Development** (peer: Aegis-DevOps BeforeTool-hook entry).

Draft entry:

```markdown
- [**dejavu**](https://github.com/WhiteBite/dejavu-gates) - Cross-session error gates: recurring tool-call failures become enforced remind-first, block-on-repeat gates via BeforeTool/AfterTool hooks. One store shared with Claude Code, Codex, OpenCode, Cursor and more. Install: `gemini extensions install https://github.com/WhiteBite/dejavu-gates`.
```

### Piebald-AI/awesome-gemini-cli (Gemini CLI)

511★, merges same cadence. Plain-name format `- [Project Name](URL) - Description`, append to bottom of section. Best section: **Commands & Extensions** (peer precedent: ArmorGemini, a BeforeTool/AfterTool policy enforcer). Same entry text minus the bold.

### Official Gemini gallery (no PR needed)

Listing is automatic: public repo + GitHub topic `gemini-cli-extension` + root `gemini-extension.json` (we have the manifest; the topic is MISSING — repo topics today: ai-agents, bun, coding-agent, developer-tools, error-handling, llm-agents, opencode, opencode-plugin, reliability, typescript). Action item: `gh api -X PUT /repos/WhiteBite/dejavu-gates/topics` adding `gemini-cli-extension` (plus a git tag helps crawl/validation). Zero-submission-effort listing; do this regardless of the two PRs above.

### github/awesome-copilot (Copilot CLI)

39.5k★, GitHub-org-run, daily activity. External plugins (hosted in our repo) must NOT come as PRs: "Do not open a pull request that directly adds a third-party plugin to `plugins/external.json`." Route = issue form `.github/ISSUE_TEMPLATE/external-plugin.yml` → automated quality gates (vally lint + install smoke test via Copilot CLI) → maintainer `/approve` → bot opens the listing PR. Requirements: public GitHub repo, immutable `ref` (release tag) and/or full `sha`, semver, SPDX license, lowercase-hyphenated keywords, plugin structure discoverable (ours: root `plugin.json` with `"hooks": "./hooks/claude.json"`, so `source.path` = repository root). Rejections are terminal (new issue required); approved listings get six-month re-review.

Form payload:

- Plugin name: `dejavu-gates`
- Short description: `Cross-session error gates for AI coding agents: recurring tool-call failures are promoted into enforced remind-first, block-on-repeat gates via Copilot CLI hooks.`
- GitHub repository: `WhiteBite/dejavu-gates`
- Plugin path: (empty — root)
- Ref to review: latest release tag (currently `v2.43.0`)
- Commit SHA: the tag's full 40-char SHA
- Version: `2.43.0` — License: `MIT` — Author: `WhiteBite`
- Keywords: `error-gates, hooks, guardrails, copilot-cli, reliability, ai-agents`

Prereq: root `plugin.json` version field lags releases (says 2.42.1 while HEAD is 2.43.0) — sync it before submitting; the install smoke test evaluates what the ref points at.

### Cursor

No genuine hooks/plugin registry exists. Official Cursor marketplace distribution is business-development curated (Partner Integrations table), no public submission path. Of the community lists:

- PatrickJS/awesome-cursorrules (40.8k★): REJECTS tool listings (PR checklist verbatim: "This is not a standalone external tool, product, directory, marketplace, or service listing"). Skip.
- spencerpauly/awesome-cursor-skills (823★): Plugins section = official-marketplace vendor bundles only. Skip.
- hao-ji-xing/awesome-cursor (90★, pushed 2026-09-07): `## Projects` section accepts third-party tooling (peers: cursor-tools, Coco). Format uses colon delimiter + star badge:

```markdown
- [Cursor tools](https://github.com/eastlondoner/cursor-tools): Give Cursor Agent an AI Team and Advanced Skills  ![GitHub Repo stars](https://img.shields.io/github/stars/eastlondoner/cursor-tools) 
```

Draft entry:

```markdown
- [dejavu-gates](https://github.com/WhiteBite/dejavu-gates): Cross-session error gates for AI coding agents — recurring tool-call failures become enforced remind/block gates, shared store across Cursor, Claude Code, Codex and 7 more harnesses.  ![GitHub Repo stars](https://img.shields.io/github/stars/WhiteBite/dejavu-gates)
```

Low reach; opportunistic only.

### Cline — cline/marketplace (official org)

The best structural fit in the survey: `registry/plugins/` hosts exactly our category (hook guardrails: env-blocker, branch-protector, gitignore-read-files-guard). Mode: PR adding `registry/plugins/<slug>/entry.json` (+ optional icon.svg), validated by `npm run validate`. Tag vocabulary fixed (`security`, `software`, ...); `verified: false` mandatory for submissions; kebab-case id == folder name.

Open question (verify before PR): every existing plugin entry points `repo`/`homepage` at `github.com/cline/plugins/tree/main/plugins/<slug>` and installs by bare slug — the code lives in Cline's own plugins monorepo. If third-party sources are accepted, `install.args` would be `["--npm", "dejavu-gates"]` (our README's documented CLI form); otherwise the plugin must first land in cline/plugins. Check `cline/plugins` repo for a third-party precedent or ask in their Discord before opening the PR.

Draft `registry/plugins/dejavu-gates/entry.json` (monorepo-variant shown; swap homepage/repo/install.args per resolution above):

```json
{
  "$schema": "../../../schemas/plugin.schema.json",
  "id": "dejavu-gates",
  "type": "plugin",
  "name": "dejavu",
  "tagline": "Error gates that turn recurring tool-call failures into enforced reminders and blocks",
  "description": "Registers a `beforeTool` hook that blocks repeated failing tool calls once a pattern has been promoted (3 failures across 2 sessions) and an `afterTool` hook that records failures and annotates diagnostic output. Corrections teach what to do instead; diagnostics never interrupt. Gates persist across sessions and share one harness-neutral store with OpenCode, Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI and Kiro.",
  "author": { "name": "WhiteBite", "url": "https://github.com/WhiteBite" },
  "homepage": "https://github.com/WhiteBite/dejavu-gates",
  "repo": "https://github.com/WhiteBite/dejavu-gates",
  "icon": "./icon.svg",
  "tags": ["security", "software"],
  "license": "MIT",
  "verified": false,
  "featured": false,
  "install": {
    "args": ["--npm", "dejavu-gates"]
  }
}
```

Copy `logo/icon.svg` into the entry folder as `icon.svg`.

### Kiro — kirodotdev-labs/awesome-kiro

65★ community list (explicitly not Amazon-endorsed). Section `Skills, Steering and Hooks`. CONTRIBUTING: one project per PR, append to END of section (not alphabetical), format `- [Project Name](url) - One-line description. License as of YYYY-MM-DD`, period at end. Quality bar: Kiro-specific, runnable, commit within 6 months, public license. We qualify (adapter `src/adapters/kiro.ts`, installer writes `.kiro/hooks/dejavu-gates.json`).

Health caveat: last merge 2026-05-02; open PRs from June onward unmerged (#20/#19/#18...). Low-cost submit, low expectation.

Draft entry:

```markdown
- [dejavu](https://github.com/WhiteBite/dejavu-gates) - Cross-session error gates: recurring tool-call failures become enforced remind/block gates via Kiro hooks, sharing one store with 9 other agent harnesses. MIT license as of 2026-09-30
```

(neighbors carry no trailing period in practice despite the rule; match the section's prevailing style at PR time.)

### hesreallyhim/awesome-claude-code (general Claude Code, 54.8k★)

NOT a PR target. Verbatim: "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE, OR YOU RISK BEING RESTRICTED... Do not open a PR. Just fill out the form. It is not possible to submit a resource recommendation using the `gh` CLI." Recommendations must be authored by humans (agent-written resources are fine). Ground rules: repo ≥14 days old with active development, or ≥100 stars — we pass on age (created 2026-08-23, 38 days, active). One resource at a time. Bot auto-discovers license; descriptions: one line, 10-500 chars, descriptive not promotional, no emoji, don't address the reader. There is a required honesty checkbox and a honeypot checkbox that must stay UNCHECKED.

Category dropdown: choose `Security` (peers there: Agent Guard, Parry-guard, TDD Guard — hooks-driven blockers). Form fields: Display Name `dejavu`, Link `https://github.com/WhiteBite/dejavu-gates`, Author `WhiteBite`.

Draft description (fits 10-500 chars, one line):

```
Cross-session error gates for AI coding agents: mechanically promotes recurring tool-call failures into enforced gates (remind, then block on same-session repeat), with one harness-neutral store shared across Claude Code, OpenCode, Codex, Gemini CLI, Cursor and more. MIT.
```

Note the form's "specific to Claude Code" checkbox — dejavu is cross-harness; answer truthfully per the form's wording (it gates Claude Code sessions; the shared store is described in the text). Review is best-effort with no response guarantee.

### anthropics/claude-plugins-official (37.2k★)

Official Anthropic-managed directory; external submissions go through the plugin-directory form at https://clau.de/plugin-directory-submission (not a GitHub PR). Quality/security standards apply; the marketplace slug is immutable once published. Worth one submission given we already ship `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`. Fill the form from the README install section; no draft text pre-committed since field set is behind the form.

### General multi-harness lists

- bradAGI/awesome-cli-coding-agents (1.3k★, updated 2026-09-28): lists CLI *agents* and *harnesses* (session managers, orchestrators, infra). Inclusion requirement: "Must have a CLI or terminal interface... Must be able to read/write code or run commands autonomously." dejavu is neither an agent nor an orchestrator — closest peer hcom (multi-harness hook bus) sits in Agent infrastructure. Borderline; submit only if maintainers accept extension-tooling entries (open an issue to ask first). Not drafted.
- michielhdoteth/awesome-ai-agent-tools (30★): machine-readable catalogs (`plugins/catalog.json`, `hooks/catalog.json`), PR or issue, explicitly cross-platform. Small reach; JSON entry mirrors existing schema fields (id/name/category/platform/stars/description/installCommand/license). Opportunistic extra, skip unless doing a bulk sweep.
- rohitg00/awesome-claude-code-toolkit, ai-for-developers/awesome-ai-coding-tools: generic/large dumps, low signal-to-noise; not worth maintenance cost.

### Closed channels (documented so nobody re-explores)

- Official OpenAI Codex plugin directory (platform.openai.com/plugins): dashboard ZIP upload + identity-verified review; docs state plugin ZIPs containing lifecycle hooks "cannot currently be submitted" — dejavu is a hooks plugin, ineligible today. Revisit if OpenAI lifts the restriction.
- Crush: no awesome list exists (nixpt/awesome-crush is a 0★ empty stub). Only exposure: post in charmbracelet/crush Discussions. No index, no gate.
- Devin CLI: no list exists. Traps: detailobsessed/awesome-devin is a Windsurf list; e2b-dev/awesome-devins is Devin-*inspired agents*. teramotodaiki/awesome-devin-tools is a dead 1★ stub.
- Zed/Aider/Windsurf/Amp: unsupported harnesses anyway (see README table); nothing to submit.

## PR body 1: awesome-opencode

Superseded by the YAML pipeline (see coverage section). Current state: PR #637 open with deprecated URL and failed CI. Plan: push corrected `data/plugins/dejavu-gates.yaml` to the existing fork branch (rename file, update URL) so #637 becomes reviewable, comment requesting the workflow-approval run; if no movement in ~2 weeks, close #637 and treat the channel as dead.

Title (if replaced): `docs: add dejavu-gates to plugins`

Body:

````markdown
Adds `data/plugins/dejavu-gates.yaml` (schema-validated locally with `node scripts/validate.js`).

Replaces #637: corrects the repo URL to the canonical `WhiteBite/dejavu-gates` (the project was renamed; npm package is `dejavu-gates`).
````

## PR body 2: ccplugins/awesome-claude-code-plugins

Title: `Add dejavu-gates to Workflow Orchestration`

Body:

````markdown
Adds one entry under Workflow Orchestration:

- [dejavu-gates](https://github.com/WhiteBite/dejavu-gates) - Cross-session error gates for AI coding agents. Mechanically detects recurring tool-call failures, escalates remind to block within a session, and shares one gate store across Claude Code, OpenCode, Codex, Gemini CLI, Cursor, Copilot CLI, Crush, Devin CLI, Kiro and Cline. Install: `claude plugin marketplace add WhiteBite/dejavu-gates` then `claude plugin install dejavu-gates@dejavu-marketplace`.

One-line diff, no reformatting.
````

Diff shape: one bullet appended to the `### Workflow Orchestration` block.

## Fork strategy

### Why one repo cannot PR into multiple upstreams

A GitHub pull request is defined structurally as "merge this branch *from a repository in the target's fork network*". Every fork descends from exactly one parent (the network is a tree rooted at the source repo), so `WhiteBite/dejavu-gates` can only ever be a head repo for PRs targeting dejavu-gates itself — it is not inside awesome-opencode's fork network, and pushing a branch there changes nothing about PR eligibility. The only ways to contribute to N unrelated upstreams are: (a) N forks, one per parent — the standard route; (b) direct write access (branch in-upstream, rare); (c) issues/forms where no branch is involved. Hence the inventory below: one throwaway fork per PR-target, deletable after merge.

### Fork inventory (create only when executing; none created yet)

| Fork to create | Upstream | Deliverable |
|---|---|---|
| WhiteBite/awesome-opencode | awesome-opencode/awesome-opencode | exists already (PR #637) — reuse, fix branch |
| WhiteBite/awesome-claude-code-plugins | ccplugins/awesome-claude-code-plugins | README bullet |
| WhiteBite/awesome-codex-plugins | hashgraph-online/awesome-codex-plugins | README bullet (after scanner prep) |
| WhiteBite/awesome-codex-cli | RoggeOhta/awesome-codex-cli | Hooks bullet (or skip fork, use issue) |
| WhiteBite/awesome-gemini-cli-extensions | Piebald-AI/awesome-gemini-cli-extensions | README bullet |
| WhiteBite/awesome-gemini-cli | Piebald-AI/awesome-gemini-cli | README bullet |
| WhiteBite/awesome-cursor | hao-ji-xing/awesome-cursor | README bullet |
| WhiteBite/marketplace | cline/marketplace | entry.json + icon |
| WhiteBite/awesome-kiro | kirodotdev-labs/awesome-kiro | README bullet |

No fork needed: github/awesome-copilot (issue form), hesreallyhim/awesome-claude-code (web form), anthropics/claude-plugins-official (external form), RoggeOhta issue route, Gemini gallery (topic), OpenAI directory (blocked).

Execution pattern (identical per row; shown for the two original targets):

```powershell
# PR 1: awesome-opencode (fork already exists; refresh branch instead)
gh repo sync WhiteBite/awesome-opencode
cd awesome-opencode   # existing clone, or re-clone
git checkout add-dejavu
git rm data/plugins/opencode-dejavu.yaml
# add data/plugins/dejavu-gates.yaml from the section above
git add -A && git commit -m "docs: add dejavu-gates to plugins"
git push --force-with-lease origin add-dejavu

# PR 2: ccplugins/awesome-claude-code-plugins
cd ..
gh repo fork ccplugins/awesome-claude-code-plugins --clone=true --remote=true
cd awesome-claude-code-plugins
git checkout -b add-dejavu-gates
# edit README.md: append the dejavu-gates bullet to Workflow Orchestration
git add README.md
git commit -m "add dejavu-gates to workflow orchestration"
git push -u origin add-dejavu-gates
gh pr create --title "Add dejavu-gates to Workflow Orchestration" --body-file dejavu-body.md
```

Keep branches fresh while PRs are open (inside each fork clone):

```powershell
git fetch upstream main
git rebase upstream/main   # resolve any alphabet-position drift
git push --force-with-lease origin <branch>
```

Cleanup after merge/close: `gh repo delete <fork> --yes` (each fork is disposable; nothing accumulates in them).

## PR etiquette

- One-line / one-block / one-file diff. Never reformat or reorder existing entries, even inconsistent ones.
- Insert at the correct alphabetical slot where CI enforces it (hashgraph-online); append-at-bottom where the list says so (both Piebald lists, Kiro, ccplugins); match the section's prevailing delimiter style at PR time.
- Entry text: factual, no superlatives, no emoji except a list's own fixed conventions (awesome-opencode renders badges automatically from YAML — nothing to hand-write anymore).
- Star-badge URLs must point at the canonical `WhiteBite/dejavu-gates`, never the deprecated redirect.
- One resource at a time on hesreallyhim (their rule); space submissions so we never hold two pending recommendations there.
- If a maintainer requests changes, amend on the same branch and `--force-with-lease`; do not open a second PR (exception: awesome-opencode #637 is being corrected in place, not duplicated).
- Account hygiene: several lists reject brand-new accounts or young repos (awesome-cursorrules: account <30 days blocked; hesreallyhim: 14-day repo rule). The WhiteBite account and repo both clear these bars as of 2026-09-30.

## Concerns / residual risk

- awesome-opencode is effectively stalled (mass-close regime since July). Budget zero expectation; the YAML fix makes #637 *eligible*, not merged.
- hashgraph-online admission depends on source-repo packaging work (`.codex-plugin/plugin.json`, icon, pinned CI, scanner score ≥80). Until that lands, the Codex PR will fail its gate deterministically. Their scanner has documented false-positive classes (#390); argue via their issue tracker, don't distort code.
- cline/marketplace may require vendoring the plugin into cline/plugins first (all existing entries are monorepo-hosted). Verify before drafting the final entry.json; the npm-install args variant is untested against their validator.
- github/awesome-copilot runs an install smoke test against our ref — root `plugin.json` still says 2.42.1 (version drift vs 2.43.0 releases); sync manifests before submitting anything that pins a ref.
- RoggeOhta and kirodotdev-labs backlogs move slowly; entries may sit for months. Cost is one issue/PR, so still worth queuing.
- hesreallyhim review is best-effort with no response guarantee; their own docs warn submitters to have a backup plan.
- Both original bodies remain final text; extract each into its own file (e.g. `dejavu-body.md`) before `gh pr create --body-file`.
