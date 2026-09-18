import { createHash } from "node:crypto"

/** Override marker stripped before normalization so bypassed failures land on the original pattern. */
const OVERRIDE_MARKER = /#?\s*dejavu:proceed/gi

/** Agent commentary lines ("# probing the api...") carry no signal — strip them. */
const COMMENT_LINE = /(^|\n)[ \t]*#[^\n]*/g

/** Quoted spans, toggled (PowerShell-first: backslash is NOT an escape char —
 * backtick is, and `""` doubles a literal quote, which toggling handles). Bash
 * `\"` escapes are a documented limitation: the same bytes mean different things
 * per shell dialect and the parser cannot know which. */
const QUOTED_SPAN = /"[^"]*"|'[^']*'/g

/** Replace quoted spans with a space — override-marker detection strips these
 * so data inside strings cannot smuggle `# dejavu:proceed`. */
export function stripQuotedSpans(text: string): string {
  return text.replace(QUOTED_SPAN, " ")
}

// --- Secret scrubbing --------------------------------------------------------

/**
 * Minimal curated secret/infrastructure patterns (~90% of real-world leaks,
 * zero deps). Applied to every signature and snippet BEFORE persistence.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-proj-\S*/gi, // OpenAI keys incl. fragmented PowerShell continuations ("sk-proj-\")
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI / Anthropic style keys
  /gh[pousr]_[A-Za-z0-9_]{36,}/g, // GitHub PATs
  /github_pat_[A-Za-z0-9_]{22,}[A-Za-z0-9_]{59}/g, // GitHub fine-grained
  /AKIA[A-Z0-9]{16}/g, // AWS access keys
  /xox[baprs]-[0-9A-Za-z-]{10,}/g, // Slack tokens
  /sk_(?:live|test)_[A-Za-z0-9]{24,}/g, // Stripe
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /npm_[A-Za-z0-9]{36}/g, // npm tokens
  /PMAK-[A-Za-z0-9-]{20,}/g, // Postman
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /Bearer\s+[A-Za-z0-9_.-]{20,}/gi, // bearer tokens
  /\b(?:mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/gi, // db conn strings
  /-----BEGIN\s+(?:[A-Z]+\s+)?PRIVATE KEY-----[\s\S]*?(?:-----END\s+(?:[A-Z]+\s+)?PRIVATE KEY-----|$)/g, // PEM private keys — full block incl. base64 body
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\b[A-Z][A-Z0-9_]{2,}=[A-Za-z0-9+=_-]{20,}/g, // .env-style KEY=<long-secret> assignments
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /hf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /dop_v1_[A-Za-z0-9]{20,}/g, // DigitalOcean
  /vercel_[A-Za-z0-9]{20,}/g, // Vercel
  /NRAK-[A-Z0-9]{20,}/g, // New Relic
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9+/_=.-]{16,}/gi, // generic key=<long value> assignments
  /\broot@[\w.-]+/gi, // ssh root@host — infrastructure exposure
]

export function scrubSecrets(text: string): string {
  let s = text
  for (const rule of SECRET_PATTERNS) {
    s = s.replace(rule, "<redacted>")
  }
  return s
}

/**
 * Terminal control characters (PowerShell VT-colored errors, bells, NULs)
 * carry no signal — persisted they corrupt snippets/corrections with raw
 * escape sequences (`ESC[31;1m...`) and fragmented identities when the
 * coloring varies between runs. ANSI sequences first (they end in a letter,
 * which bare C0 stripping would strand), then all C0 except LF/CR/TAB —
 * those three carry structure (multi-line commands, indentation).
 */
export function stripControl(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

/** The persistence boundary: control-char strip + secret scrub, in one call. */
export function sanitizeForStore(text: string): string {
  return scrubSecrets(stripControl(text))
}

// --- Normalization -----------------------------------------------------------

/**
 * Interpreter one-liners: the quoted argument IS the program. Parameterizing
 * it to <str> collapsed every script into one key — "python -c <str>" ended up
 * blocking ALL python -c calls after three unrelated failures. Fingerprint the
 * payload instead: same code = same key, different code = different key.
 * Secrets are scrubbed before hashing so they neither persist nor fragment.
 */
/**
 * PowerShell shapes included: call operator + QUOTED exe path
 * (`& "C:\...\python.exe" -c ...`) and bare interpreter alike. The quoted
 * path needs the quote in the prefix class and an optional closing quote,
 * otherwise `-c` never lines up and the payload escapes fingerprinting.
 * Leading env assignments (`PYTHONPATH=x python -c ...`) are allowed in the
 * anchor and stay in the prefix — without them the one-liner escaped
 * fingerprinting entirely. Flag alternatives run LONGEST FIRST: regex
 * alternatives are ordered, and `-c` matching inside `-command` swallowed
 * `ommand` into the payload — fragmenting keys across spellings of the same
 * call. The flag section tolerates long flags and flag+value pairs
 * (`-X utf8`, `node --import tsx`): a lookahead keeps it from swallowing the
 * code flag itself. `py` is the Windows Python launcher (`py -3 -c ...`).
 */
const INTERPRETER_ONELINER =
  /(?:^|[|;&(\n]\s*)(?:\w+=\S+\s+)*(?:["']?\S*[\\/])?(python3?|py|node|bun|deno|perl|ruby|pwsh|powershell)(?:\.exe)?["']?(?:\s+(?!-(?:encodedcommand|command|c|e)\b|--eval\b)--?\w+(?:\s+\S+)?)*\s+(-command|-encodedcommand|--eval|-c|-e)\s*/i

function hashInterpreterPayload(command: string): string {
  const match = INTERPRETER_ONELINER.exec(command)
  if (!match) return command
  // PowerShell here-string payloads (`@"..."@` / `@'...'@`) — the wrapper
  // markers are part of the payload and hash with it. Previously the `@`
  // markers survived normalization and the quoted body collapsed to <str>,
  // leaving raw code tokens leaking into signatures when quotes unbalanced.
  const payload = command.slice(match.index + match[0].length)
  if (payload.trim() === "") return command
  // Already fingerprinted (re-normalization) — keep the existing token so
  // normalizeCommand stays idempotent.
  if (/^<code:[0-9a-f]+>$/.test(payload.trim())) return command
  // Already-parameterized placeholders are data, not code — never hash them
  // (idempotency: a second pass must not fingerprint a <str>).
  if (/^(?:<(?:str|path|n|hash|uuid|sha|md5|ip|url|email|date)>\s*)+$/.test(payload.trim())) return command
  // For whole (unchained) commands the payload runs to end of string; chain
  // segments are normalized separately, so segment keys stay exact.
  // Trim before hashing: trailing whitespace (e.g. a stripped override marker)
  // is not part of the code's identity.
  const fingerprint = createHash("sha1").update(scrubSecrets(payload.trim())).digest("hex").slice(0, 8)
  // Long PowerShell flags converge to -c: `-command`/`-encodedcommand` are
  // spellings of the same one-liner call — one identity, not three families.
  const prefix = command.slice(0, match.index + match[0].length).replace(/-(?:command|encodedcommand)(\s*)$/i, "-c$1")
  return `${prefix}<code:${fingerprint}>`
}

/**
 * Windows wrapper verb: `cmd /c "real command"` — the payload IS the call.
 * Unwrapped, the payload normalizes with its own identity and its real verb
 * stays visible to the diagnostic policy; left wrapped, `/c` becomes `<path>`
 * and the payload becomes `<str>`, so `cmd <path> <str>` matched every cmd
 * invocation on the machine. Recursion terminates: the payload is strictly
 * shorter than the wrapper command.
 */
const CMD_WRAPPER = /^cmd(?:\.exe)?\s+(?:\/s\s+)?\/(c|k)\s+/i

/**
 * Raw payload of a `cmd /c|/k` wrapper, one wrapper-quote layer removed —
 * null when the command is not wrapped. Shared by normalization (unwrap),
 * segment expansion (inner chains) and override-marker visibility.
 */
export function cmdWrapperPayload(command: string): string | null {
  const match = CMD_WRAPPER.exec(command)
  if (!match) return null
  let payload = command.slice(match[0].length).trim()
  if ((payload.startsWith('"') && payload.endsWith('"') && payload.length >= 2) || (payload.startsWith("'") && payload.endsWith("'") && payload.length >= 2)) {
    payload = payload.slice(1, -1).trim()
  }
  return payload === "" ? null : payload
}

function unwrapCmdWrapper(command: string): string {
  const payload = cmdWrapperPayload(command)
  return payload === null ? command : normalizeCommand(payload)
}

/**
 * Normalize a bash command into a stable signature.
 * Paths, numbers, quoted strings, hashes and agent comments are abstracted
 * away so that "same failure, different instance" collapses into one pattern.
 */
export function normalizeCommand(command: string): string {
  // Terminal control characters (PowerShell VT colors) carry no identity and
  // fragmented signatures when coloring varied between runs — strip first.
  let s = stripControl(command)
  // CRLF/CR commands (Windows pastes, agent multi-line) normalize to LF —
  // otherwise the same command fragments across line-ending styles.
  s = s.replace(/\r\n?/g, "\n")
  s = s.replace(COMMENT_LINE, "$1").toLowerCase()
  s = unwrapCmdWrapper(s)
  s = hashInterpreterPayload(s)
  // Quoted spans come out FIRST: they are data, and removing them before the
  // path rules keeps normalization idempotent — a <str> replacement inserts
  // spaces that would otherwise expose an adjacent "/" to the path rule only
  // on a second pass.
  s = s.replace(QUOTED_SPAN, " <str> ")
  s = s.replace(/[a-z]:[\\/][^\s"']+/gi, " <path> ")
  s = s.replace(/(^|\s)\/[^\s"']+/g, "$1<path> ")
  // lookbehind: never re-parameterize the <code:...> fingerprint hex
  s = s.replace(/(?<!<code:)\b[0-9a-f]{7,64}\b/gi, " <hash> ")
  s = s.replace(/(?<!<code:)\b\d[\d.]*\b/g, " <n> ")
  s = s.replace(/\s+/g, " ").trim()
  return s
}

/**
 * Sentry-style parameterization for free-form error text (event channel).
 * Same root cause must collapse to one signature regardless of variable data.
 * Order matters: quoted strings first, then specific tokens, numbers last.
 */
const PARAM_RULES: [RegExp, string][] = [
  [/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, "<str>"], // unrolled loop: no catastrophic backtracking
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b[0-9a-f]{40}\b/gi, "<sha>"],
  [/\b[0-9a-f]{32}\b/gi, "<md5>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "<ip>"],
  [/\bhttps?:\/\/[^\s"'<>]+/gi, "<url>"],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "<email>"],
  [/\b\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?)?/gi, "<date>"],
  [/\b[a-z]:[\\/][^\s"'<>|]+/gi, "<path>"],
  [/(^|\s)\/[^\s"'<>|]+/g, "$1<path>"],
  [/\b[0-9a-f]{7,64}\b/gi, "<hash>"],
  [/\b\d{2,}\b/g, "<n>"],
]

export function parameterizeError(text: string): string {
  let s = stripControl(text).toLowerCase()
  for (const [rule, token] of PARAM_RULES) {
    s = s.replace(rule, token)
  }
  return s.replace(/\s+/g, " ").trim()
}

// --- Intended non-zero exits / diagnostic detection --------------------------

/**
 * Verb patterns of diagnostic commands: their exit 1 is a NORMAL, intended
 * outcome (no match / findings / failed tests during development), not a
 * mistake. Used both for raw commands (exit-code allowlist) and normalized
 * signatures (blocking policy), so there is one source of truth.
 */
const DIAGNOSTIC_VERBS: RegExp[] = [
  /(^|[\s|;&:])(grep|rg|findstr|select-string)\b/i,
  /\bgit grep\b/i,
  // Read-only git inspectors are diagnostics like `git grep`: their exit 1 is
  // usually a downstream filter finding nothing (`git show … | Select-String`),
  // not a mistake. Real git errors exit >= 2 and still count.
  /\bgit\s+(show|log|status|ls-tree|ls-files|blame|diff)\b/i,
  /(^|[\s|;&:])diff\b/i,
  /\b(pytest|jest|vitest|mocha|cucumbertest)\b/i,
  // npm/yarn/pnpm test / typecheck / lint scripts are iteration work — their
  // exit 1 is "tests failed / types wrong / lint found issues", not an
  // infrastructure error. The second rule covers flags between the package
  // manager and the verb (e.g. `pnpm --filter <pkg> typecheck`).
  /\b(npm|pnpm|yarn) (run )?(test|typecheck|lint)\b/i,
  /\b(npm|pnpm|yarn)\b[^\n;|&]*\b(typecheck|lint)\b/i,
  // `npm run check:*` / `verify:*` scripts are iteration work like test/lint —
  // their exit 1 is "found issues", not an infrastructure error.
  /\b(npm|pnpm|yarn|bun) (run )?(check|verify)\b/i,
  /\bplaywright test\b/i,
  /\bflutter (test|analyze)\b/i,
  /\bdart (analyze|format|fix)\b/i,
  // Iteration runners: `dart run <script>`, `go run|build`, `cargo run|build`
  // fail repeatedly WHILE the agent fixes the code — the failures are the
  // work itself. Blocking them produced arms races (dozens of overrides in
  // production data); they remind but never block, and their exit 1 is the
  // intended "still broken" outcome of iteration.
  /\bdart run\b/i,
  /\bgo (run|build|test|vet)\b/i,
  /\bcargo (run|build|test|clippy)\b/i,
  /\bgradlew\b[^\n;|&]*(test|compilejava|compiletestjava)/i,
  /\b(eslint|prettier --check)\b/i,
  /\btsc\b/i,
  /\bmypy\b/i,
  /\bcurl\b/i,
  /\bls\b/i,
  // Read-only PowerShell probes: non-zero exit is a probe result (no match, missing path), not a failed operation — the `ls` class.
  /\bget-(?:process|item|childitem|content)\b/i,
  /\b(?:test-path|resolve-path|measure-object)\b/i,
]

export function isDiagnosticText(text: string): boolean {
  return DIAGNOSTIC_VERBS.some((rule) => rule.test(text))
}

export function isDiagnosticSignature(signature: string): boolean {
  return isDiagnosticText(signature)
}

/** Pipeline formatters shape output but are never the failing producer WHEN
 * they are a pipe tail: PowerShell cmdlets don't set `$LASTEXITCODE` (it stays
 * with the producing native command), and unix head/tail/column/uniq tails exit
 * 0 on piped input. So piping a diagnostic into one (`tsc | Select-Object -Last
 * 5`, `vitest | head -5`) must not break the diagnostic's exit-1 immunity.
 * Position matters: a formatter standing alone or as the TERMINAL producer of a
 * sequence (`npm test && tail -5 missing.log`) IS the failing producer — its
 * exit must still count. isIntendedNonzero only grants the transparency to
 * segments splitChainTagged marks as pipe tails. */
const PIPE_FORMATTERS =
  /^\s*(select-object|sort-object|format-table|format-list|format-wide|format-custom|out-string|out-host|out-null|tee-object|foreach-object|where-object|measure-object|group-object|convertto-json|convertfrom-json|head|tail|column|uniq|tee)\b/i
/** Navigation changes directory, never the outcome — `cd X && <diagnostic>`
 * must not lose the diagnostic's exit-1 immunity to the `cd` segment. */
const NAVIGATION_VERBS = /^\s*(cd|set-location|pushd|popd)\b/i
/** Pure environment assignments (`$env:CI="true"`, `FOO=bar`) and sleeps only
 * prepare the session — they are never the failing producer, so they are
 * transparent to exit-1 immunity and chain attribution like navigation. */
const ENV_ASSIGNMENT_SEGMENT = /^\s*(?:\$env:)?[a-z_][a-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)\s*$/i
const INERT_VERBS = /^\s*start-sleep\b/i

/** Flatten subshell parens to `;` segment separators, but ONLY outside `{}`
 * script blocks and quotes. `(deploy && grep)` must split (a diagnostic inside
 * parens must not blanket-immunize a non-diagnostic verb), but method-call
 * parens inside a PowerShell script block (`ForEach-Object { $_.trim() }`) are
 * part of that segment and must NOT split it. */
function flattenSubshellParens(command: string): string {
  let result = ""
  let quote: string | null = null
  let braceDepth = 0
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i)
    if (quote !== null) {
      result += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      result += ch
      continue
    }
    if (ch === "{") {
      braceDepth += 1
      result += ch
      continue
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1)
      result += ch
      continue
    }
    if ((ch === "(" || ch === ")") && braceDepth === 0) {
      result += ";"
      continue
    }
    result += ch
  }
  return result
}

/** Like splitChain but tags each segment with whether it immediately follows a
 * pipe (`|`). Formatter transparency is position-dependent (pipe tail only), so
 * the immunity check needs this. `||` is a sequence (OR) separator, not a pipe:
 * the segment after it is a producer, NOT a pipe tail. */
function splitChainTagged(command: string): Array<{ text: string; pipeTail: boolean }> {
  const segments: Array<{ text: string; pipeTail: boolean }> = []
  let current = ""
  let quote: string | null = null
  let depth = 0
  let pipeTail = false
  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed !== "") segments.push({ text: trimmed, pipeTail })
    current = ""
  }
  let i = 0
  while (i < command.length) {
    const ch = command.charAt(i)
    const next = command.charAt(i + 1)
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i += 1
      continue
    }
    if (ch === "(") {
      depth += 1
      current += ch
      i += 1
      continue
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1)
      current += ch
      i += 1
      continue
    }
    if (depth === 0) {
      if (ch === ";" || ch === "\n" || ch === "\r") {
        flush()
        pipeTail = false
        i += 1
        continue
      }
      if (ch === "&" && next === "&") {
        flush()
        pipeTail = false
        i += 2
        continue
      }
      if (ch === "|") {
        flush()
        if (next === "|") {
          // `||` is a sequence (OR) separator — next segment is a producer.
          pipeTail = false
          i += 2
        } else if (next === "&") {
          // `|&` is bash's pipe-stdout-and-stderr — still a pipe, next is a tail.
          pipeTail = true
          i += 2
        } else {
          pipeTail = true
          i += 1
        }
        continue
      }
    }
    current += ch
    i += 1
  }
  flush()
  return segments
}

/**
 * OpenCode normalizes non-zero exits to 1 in metadata, so discriminate by
 * command shape. Exit-1 immunity requires EVERY producer segment to be
 * diagnostic: in `deploy --broken && grep done log.txt` the exit is deploy's
 * failure — granting immunity because grep appears later would hide it.
 * Two segment kinds are transparent because they cannot be the failing
 * producer: navigation (`cd`) — but ONLY when the segment is pure navigation,
 * so `cd <path> npx vitest run` (no separator) keeps the diagnostic instead of
 * being dropped wholesale — and pipe formatters, but the latter ONLY as a pipe
 * tail. A formatter standing alone or as the terminal producer of a sequence
 * (`npm test && tail -5 missing.log`) IS the producer, so its failure still
 * counts. A real non-diagnostic command still breaks immunity — `npm install |
 * select-object` still counts (npm install is not a diagnostic).
 * Subshell paren groups are flattened to segment separators (`;`), NOT spaces,
 * and only OUTSIDE `{}` script blocks: `(deploy && grep)` splits so a
 * diagnostic nested in parens can't blanket-immunize a non-diagnostic verb,
 * while method-call parens inside a script block (`ForEach-Object { $_.trim()
 * }`) stay part of their segment and don't split it.
 */
export function isIntendedNonzero(command: string, exitCode: number): boolean {
  if (exitCode !== 1) return false
  let sawProducer = false
  for (const { text, pipeTail } of splitChainTagged(flattenSubshellParens(command))) {
    // Navigation is transparent only when it is PURE navigation. A segment that
    // pairs a navigation verb with a diagnostic and no separator between them
    // (`cd <path> npx vitest run ...`) must keep that diagnostic — dropping the
    // whole segment as navigation would hide the command and break immunity.
    if (NAVIGATION_VERBS.test(text) && !isDiagnosticText(text)) continue
    // Session prep that cannot be the failing producer: a pure `$env:X=...` /
    // `FOO=bar` assignment, and start-sleep.
    if (ENV_ASSIGNMENT_SEGMENT.test(text)) continue
    if (INERT_VERBS.test(text)) continue
    if (pipeTail && PIPE_FORMATTERS.test(text)) continue
    if (!isDiagnosticText(text)) return false
    sawProducer = true
  }
  return sawProducer
}

/**
 * Count of non-transparent producer segments in a command chain — the segments
 * that could plausibly be the failing producer (everything except pure
 * navigation, pure env assignments, inert verbs, and pipe-tail formatters).
 * Chain attribution is only defensible when exactly ONE such producer exists;
 * with several, the exit code does not say which one failed, so attributing
 * the failure to any single known segment fabricates evidence (a diagnostic
 * segment's gate inflated by a non-diagnostic producer's failure).
 */
export function nonTransparentProducers(command: string): number {
  let count = 0
  for (const { text, pipeTail } of splitChainTagged(flattenSubshellParens(command))) {
    if (NAVIGATION_VERBS.test(text) && !isDiagnosticText(text)) continue
    if (ENV_ASSIGNMENT_SEGMENT.test(text)) continue
    if (INERT_VERBS.test(text)) continue
    if (pipeTail && PIPE_FORMATTERS.test(text)) continue
    count += 1
  }
  return count
}

// --- Residual identity (over-generic shape guard) ----------------------------

/** Placeholder tokens carry no identity — except `<code:...>`: the
 * fingerprint IS the identity of a one-liner payload. */
const PLACEHOLDER_TOKEN = /^<(?:str|path|n|hash|uuid|sha|md5|ip|url|email|date)>$/

/** Shell plumbing: redirections and here-string/call-operator debris. */
const OPERATOR_TOKENS = new Set(["&", "@", ">", "<", ">&", ">>", "2>&1", "2>"])

/** Tokens that pass code/module to an interpreter — structure, not identity.
 * `-m`/`--module` included: the NEXT token is the program, exactly like -c —
 * `python -m <str>` (quoted module) must not gain identity from the flag. */
const CODE_PASSING_FLAGS = new Set(["-c", "-e", "--eval", "-command", "-encodedcommand", "-m", "--module"])

/** Bare flag tokens (`-x`, `--foo`) are switches, not call identity — after a
 * wrapper head, a flag-only remainder matches an entire command family
 * (`cmd <path> <str> -f`), which must not enforce. */
const FLAG_TOKEN = /^--?[a-z]/i

/** Shell builtins that only position the session: a chain headed by one
 * (`cd <path> && python <path>`) must not borrow identity from the builtin —
 * the whole chain may be parameterized away. */
const NO_IDENTITY_HEADS = new Set(["cd", "pushd", "popd", "set-location", "exit"])

/** Pipe-stage cmdlets that only post-process output: a segment made of
 * plumbing (`... | select-object -last <n>`) contributes no identity. */
const PLUMBING_HEADS = new Set([
  "select-object",
  "select-string",
  "out-string",
  "out-file",
  "out-null",
  "foreach-object",
  "where-object",
  "sort-object",
  "measure-object",
  "tee-object",
  "write-host",
  "write-output",
  "more",
])

/** Wrappers whose bare name is not a call identity: their ARGUMENTS are the
 * call. If the arguments were all parameterized away, the signature matches
 * an entire command family — enforcing it would punish unrelated calls. */
const WRAPPER_BASENAMES = new Set(["cmd", "py", "node", "python", "python3", "bun", "deno", "perl", "ruby", "pwsh", "powershell"])

/** npx-launched runners: the runner package is the verb, the SCRIPT argument is
 * the call — `npx tsx <str>` matches every tsx invocation (a family). */
const NPX_RUNNERS = new Set(["tsx", "ts-node", "esno", "vite-node"])

/** Package-manager subcommands after a wrapper head (`bun run <str>`): the
 * subcommand is structure, not identity — identity must come from the script. */
const RUN_SUBCOMMANDS = new Set(["run", "test", "start", "dev"])

function baseName(token: string): string {
  const bare = token.replace(/^["']+|["']+$/g, "")
  const parts = bare.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? bare
  return last.toLowerCase().replace(/\.exe$/, "")
}

/** Identity scan over the arguments after a family/wrapper verb: a surviving
 * literal (path/script) or a <code:...> fingerprint is identity; flags,
 * placeholders and operators are structure. */
function hasIdentityAfter(tokens: string[], from: number): boolean {
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    if (token.startsWith("<code:")) return true
    if (PLACEHOLDER_TOKEN.test(token) || CODE_PASSING_FLAGS.has(token) || OPERATOR_TOKENS.has(token) || FLAG_TOKEN.test(token)) continue
    return true
  }
  return false
}

function segmentHasIdentity(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t !== "")
  let head = ""
  let headIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    if (PLACEHOLDER_TOKEN.test(token) || OPERATOR_TOKENS.has(token) || CODE_PASSING_FLAGS.has(token)) continue
    head = token
    headIdx = i
    break
  }
  if (head === "") return false
  if (head.startsWith("<code:")) return true
  if (PLUMBING_HEADS.has(head)) return false
  if (NO_IDENTITY_HEADS.has(head)) return false
  const headBase = baseName(head)
  // `git commit`: the message is always parameterized and the staged content is
  // invisible — the bare verb phrase matches EVERY commit (hook rejections are
  // content-dependent), so identity must come from a concrete argument (pathspec).
  if (headBase === "git" && (tokens[headIdx + 1] ?? "") === "commit") {
    return hasIdentityAfter(tokens, headIdx + 2)
  }
  // `npx tsx <str>`: the runner package is part of the verb, the script is the call.
  if (headBase === "npx" && NPX_RUNNERS.has(baseName(tokens[headIdx + 1] ?? ""))) {
    return hasIdentityAfter(tokens, headIdx + 2)
  }
  if (!WRAPPER_BASENAMES.has(headBase)) return true
  // Wrapper/interpreter head: identity must come from a surviving argument
  // (a literal path/script, or a <code:...> fingerprint). Flags are switches,
  // not identity — a flag-only remainder is an over-generic command family.
  // A package-manager subcommand right after the head (`bun run <str>`) is
  // structure too — identity must come from the script it runs.
  let argStart = headIdx + 1
  if (RUN_SUBCOMMANDS.has((tokens[argStart] ?? "").toLowerCase())) argStart += 1
  return hasIdentityAfter(tokens, argStart)
}

/**
 * A signature keeps residual identity when at least one chain segment names
 * a concrete call. Signatures whose substance was entirely parameterized —
 * `cmd <path> <str>`, `node <str> <n> >& <n>`, `& <str> -c @ <str> @`,
 * chains starting with an unknown `<str>` head — match whole command
 * families: they may be measured (watching) but never enforced. This
 * generalizes the legacy bare-one-liner guard: ANY future normalization gap
 * degrades to watching instead of blocking arbitrary calls.
 */
export function hasResidualIdentity(signature: string): boolean {
  const body = signature.startsWith("bash:") ? signature.slice("bash:".length) : signature
  return body.split(/\s*(?:\|\||&&|[|;&])\s*|\n+/).some((segment) => segmentHasIdentity(segment))
}

/** Unix read-only viewers habitually typed into PowerShell: their failures stay
 * RECORDED (a missing file / not-recognized is teachable), but they never BLOCK —
 * a read-only habit punished with a hard stop and a generic correction produced
 * pure friction (production data: `cat <str> | head - <n>` blocking). The `:` in
 * the prefix class covers the `bash:` signature prefix; the lookahead keeps
 * `git push origin head:refs/...` refspecs out. */
const UNIX_VIEWER_VERBS: RegExp[] = [
  /(^|[\s|;&(:])(?:cat|wc|less)\b/i,
  /(^|[\s|;&(:])(?:head|tail|more)\b(?!:)/i,
]

export function isUnixViewerSignature(signature: string): boolean {
  return UNIX_VIEWER_VERBS.some((rule) => rule.test(signature))
}

/**
 * Blocking policy: only bash commands that are NOT diagnostics may ever
 * become enforced gates. File probes and diagnostic queries are measured
 * (watching) but never interrupt the agent — the data showed blocking them
 * punishes normal work. Unix read-only viewers never block either (teach the
 * PowerShell-native form via reminder instead). Signatures without residual
 * identity never enforce at any tier — they are too broad to interrupt anything.
 */
export function canBlock(tool: string, signature: string): boolean {
  if (tool !== "bash") return false
  if (!hasResidualIdentity(signature)) return false
  if (isUnixViewerSignature(signature)) return false
  return !isDiagnosticSignature(signature)
}

/**
 * Remind-only policy: diagnostic bash commands still surface a REMINDER when
 * they recur (the old behavior gave them zero signal), but they NEVER block —
 * blocking a test/lint the agent is iterating on punishes normal work. Unix
 * viewers join this tier: their exit-1 stays recordable (unlike diagnostics),
 * and the reminder teaches the PowerShell-native equivalent.
 */
export function canRemind(tool: string, signature: string): boolean {
  if (tool !== "bash") return false
  if (!hasResidualIdentity(signature)) return false
  return isDiagnosticSignature(signature) || isUnixViewerSignature(signature)
}

/**
 * Repo-local verbs: their success depends on THIS repo's state (deps, lockfile,
 * remote, build cache), not on agent behavior — so a failure is a repo quirk,
 * not an agent habit, and must never escalate to the global store (an
 * `npm install` that broke in project A would otherwise block project B).
 */
const REPO_LOCAL_VERBS: RegExp[] = [
  /\b(npm|yarn|pnpm|bun|npx)\b/i,
  /\bgit\b/i,
  /\b(gradlew|gradle|mvn|maven)\b/i,
  /\b(cargo|go|pip3?|poetry|uv)\b/i,
  /\bdocker(-compose)?\b/i,
  /\b(make|cmake|bazel)\b/i,
]

export function isRepoLocal(signature: string): boolean {
  return REPO_LOCAL_VERBS.some((rule) => rule.test(signature))
}

// --- Chain splitting ---------------------------------------------------------

/**
 * Quote- and paren-aware split of a command chain: &&, ||, ;, | and newlines
 * separate segments ONLY at paren depth 0. A gate on a single command must
 * also fire when that command hides inside "git status && rm -rf /", but
 * "(cd /tmp && ls)" stays one segment.
 */
export function splitChain(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | null = null
  let depth = 0
  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed !== "") segments.push(trimmed)
    current = ""
  }
  let i = 0
  while (i < command.length) {
    const ch = command.charAt(i)
    const next = command.charAt(i + 1)
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i += 1
      continue
    }
    if (ch === "(") {
      depth += 1
      current += ch
      i += 1
      continue
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1)
      current += ch
      i += 1
      continue
    }
    if (depth === 0) {
      if (ch === ";" || ch === "\n" || ch === "\r") {
        flush()
        i += 1
        continue
      }
      if (ch === "&" && next === "&") {
        flush()
        i += 2
        continue
      }
      if (ch === "|") {
        flush()
        // `||` (OR) and `|&` (bash pipe stdout+stderr) are 2-char; bare `|` is 1.
        i += next === "|" || next === "&" ? 2 : 1
        continue
      }
    }
    current += ch
    i += 1
  }
  flush()
  return segments
}

/** $(...) and `...` payloads, quote-aware (toggled — see QUOTED_SPAN for the
 * PowerShell-first escaping rationale). Both shells expand $() inside DOUBLE
 * quotes, so those are scanned too; single-quoted spans are inert in bash and
 * PowerShell alike. Unbalanced input yields nothing (the enclosing segment
 * still signs as a whole). Backtick substitution is bash-shaped; in PowerShell
 * a backtick is an escape char, so a stray pair may over-extract — extraction
 * only ADDS candidate signatures (fail-safe: an extra candidate matches a gate
 * only on exact/fuzzy identity), never removes one. */
function extractSubstitutions(text: string): string[] {
  const out: string[] = []
  let quote: string | null = null
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    const next = text.charAt(i + 1)
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        i += 1
        continue
      }
      // $() and backticks still expand inside DOUBLE quotes (both shells)
      if (quote !== '"') {
        i += 1
        continue
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === "$" && next === "(") {
      let depth = 1
      let q: string | null = null
      let j = i + 2
      while (j < text.length && depth > 0) {
        const c = text.charAt(j)
        if (q !== null) {
          if (c === q) q = null
          j += 1
          continue
        }
        if (c === '"' || c === "'") {
          q = c
          j += 1
          continue
        }
        if (c === "(") depth += 1
        else if (c === ")") {
          depth -= 1
          if (depth === 0) break
        }
        j += 1
      }
      if (depth === 0 && j > i + 2) {
        out.push(text.slice(i + 2, j))
        i = j + 1
        continue
      }
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1)
      if (close > i + 1) {
        out.push(text.slice(i + 1, close))
        i = close + 1
        continue
      }
    }
    i += 1
  }
  return out
}

/**
 * Per-segment signatures for a bash command (bypass protection for chains).
 * cmd wrappers expand recursively: quote-aware splitChain keeps
 * `cmd /c "a && gated"` as ONE segment, so the inner chain must unfold here —
 * a gate on the inner command must fire through the wrapper. $(...) and
 * backtick payloads unfold too: splitChain keeps a substitution inside its
 * enclosing segment, so `echo $(gated)` would otherwise hide the gate.
 * Depth-bounded: nested wrappers/substitutions are pathological.
 */
export function bashSegmentSignatures(command: string): string[] {
  const clean = command.replace(OVERRIDE_MARKER, "")
  const signatures: string[] = []
  const expand = (text: string, depth: number): void => {
    for (const segment of splitChain(text)) {
      const payload = depth < 3 ? cmdWrapperPayload(segment) : null
      if (payload !== null) {
        expand(payload, depth + 1)
        continue
      }
      signatures.push(`bash:${normalizeCommand(segment)}`)
      if (depth < 3) {
        for (const sub of extractSubstitutions(segment)) expand(sub, depth + 1)
      }
    }
  }
  expand(clean, 0)
  return signatures
}

/** Normalize a file path: keep basename + extension, drop directories. */
export function normalizeFilePath(filePath: string): string {
  const unified = filePath.replace(/\\/g, "/")
  const base = unified.split("/").pop() ?? unified
  return base.toLowerCase()
}

/**
 * Stable identity of a planned tool call for recurrence matching.
 * For bash this is the WHOLE command; use bashSegmentSignatures() in
 * addition when matching gates. Returns null for tools we do not track.
 */
export function callSignature(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "bash": {
      const command = args.command
      return typeof command === "string" && command.trim() !== ""
        ? `bash:${normalizeCommand(command.replace(OVERRIDE_MARKER, ""))}`
        : null
    }
    case "read":
    case "edit":
    case "write": {
      const filePath = args.filePath
      return typeof filePath === "string" && filePath.trim() !== ""
        ? `${tool}:${normalizeFilePath(filePath)}`
        : null
    }
    case "glob":
    case "grep": {
      const pattern = args.pattern
      return typeof pattern === "string" && pattern.trim() !== ""
        ? `${tool}:${pattern.toLowerCase().replace(/\s+/g, " ").trim()}`
        : null
    }
    default:
      return null
  }
}

export function patternKey(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 12)
}

// --- Fuzzy matching ----------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    const ca = a.charAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charAt(j - 1) ? 0 : 1
      const del = (prev[j] ?? 0) + 1
      const ins = (curr[j - 1] ?? 0) + 1
      const sub = (prev[j - 1] ?? 0) + cost
      curr[j] = Math.min(del, ins, sub)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n] ?? 0
}

/** Levenshtein with an early exit: returns the distance, or maxDist+1 once
 * every cell of a row exceeds maxDist (no later row can lower it). The flood
 * path calls fuzzySimilar per gate under the gates lock — the exit turns the
 * DP cost cliff on long dissimilar pairs into a partial scan. */
export function levenshteinCapped(a: string, b: string, maxDist: number): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  if (Math.abs(m - n) > maxDist) return maxDist + 1
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    const ca = a.charAt(i - 1)
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charAt(j - 1) ? 0 : 1
      const del = (prev[j] ?? 0) + 1
      const ins = (curr[j - 1] ?? 0) + 1
      const sub = (prev[j - 1] ?? 0) + cost
      const v = Math.min(del, ins, sub)
      curr[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > maxDist) return maxDist + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n] ?? 0
}

/** Code fingerprints are IDENTITY, not data — they must match exactly. The
 * residue shape of a failed fingerprint (`-c <str>`, `--eval <str>`) is
 * identity-bearing too: a one-liner family must never fuzzy-match a plain
 * argument (`<path>`) — production misfire: an unrelated `python -X utf8 -c`
 * one-liner inherited a script-path gate's enforcement. */
const CODE_FINGERPRINTS = /<code:[0-9a-f]+>|-(?:encodedcommand|command|c|e)\s+<str>|--eval\s+<str>/gi

/** Flag tokens ("-x", "--foo") are the operation's switches. Two commands with
 * DISJOINT flag sets are different operations and must never fuzzy-merge
 * ("train --lr <n>" vs "train --epochs <n>"). A subset IS allowed — extra
 * switches on the same operation ("gradlew test --no-daemon") still belong to
 * the same gate, otherwise enforcement fragments across harmless variants.
 * Cached: the flood path calls fuzzySimilar per gate under the gates lock and
 * would otherwise re-split/sort the SAME incoming signature on every pair. */
const FLAG_TOKEN_CACHE_CAP = 512
const flagTokenCache = new Map<string, string[]>()
function flagTokens(signature: string): string[] {
  const cached = flagTokenCache.get(signature)
  if (cached !== undefined) return cached
  const tokens = signature
    .split(/\s+/)
    .filter((token) => token.startsWith("-"))
    .sort()
  if (flagTokenCache.size >= FLAG_TOKEN_CACHE_CAP) {
    // Evict an arbitrary (oldest-inserted) entry to bound memory.
    const oldest = flagTokenCache.keys().next().value
    if (oldest !== undefined) flagTokenCache.delete(oldest)
  }
  flagTokenCache.set(signature, tokens)
  return tokens
}

function flagSubset(a: string[], b: string[]): boolean {
  const set = new Set(b)
  return a.every((token) => set.has(token))
}

/** Signatures longer than this match exactly only: a 300-char normalized
 * command is already specific enough that "30% near" is meaningless, and
 * Levenshtein on long signatures is the hot-path cost cliff. */
export const FUZZY_MAX_LEN = 300

/**
 * Near-duplicate match: normalized edit distance <= 30% AND absolute distance
 * >= 3. Unlike token-set Jaccard, this does not collapse commands that merely
 * share placeholder tokens; the absolute floor stops verb-level-different
 * commands ("git push <str>" vs "git pull <str>" = distance 2) from merging.
 * Signatures carrying <code:...> fingerprints only match if the fingerprints
 * are identical — random hashes differing in 3 chars would otherwise pass the
 * distance rule and merge unrelated one-liners into one gate. Flag sets must
 * also be comparable (one a subset of the other) — disjoint switches mean
 * different operations.
 */
export function fuzzySimilar(a: string, b: string): boolean {
  if (a === b) return true
  // Cheapest rejects FIRST: the length band is O(1) with zero allocation and
  // zero false negatives — it must run before any regex/flag work, because
  // the flood path calls this per gate under the gates lock.
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return true
  if (maxLen > FUZZY_MAX_LEN) return false
  // Triangle inequality: distance >= |lenA - lenB|. If even that floor
  // exceeds the ratio threshold, no Levenshtein result can pass — an O(1)
  // pre-filter with zero false negatives that skips most DP computations.
  if (Math.abs(a.length - b.length) / maxLen > 0.3) return false
  const codesA = a.match(CODE_FINGERPRINTS)
  const codesB = b.match(CODE_FINGERPRINTS)
  if (codesA !== null || codesB !== null) {
    if (codesA === null || codesB === null || codesA.join("\u0000") !== codesB.join("\u0000")) return false
  }
  const flagsA = flagTokens(a)
  const flagsB = flagTokens(b)
  if (!flagSubset(flagsA, flagsB) && !flagSubset(flagsB, flagsA)) return false
  // distance/maxLen <= 0.3 ⟺ distance <= floor(0.3*maxLen) for integer
  // distances; below 3 the ratio bar and the absolute floor cannot both hold.
  const cutoff = Math.floor(maxLen * 0.3)
  if (cutoff < 3) return false
  const distance = levenshteinCapped(a, b, cutoff)
  return distance >= 3 && distance <= cutoff
}

// --- Failure detection -------------------------------------------------------

export interface FailureDetection {
  matched: boolean
  snippet: string
}

/**
 * Conservative failure signatures scanned line-by-line in BASH output only.
 * File-tool output is file CONTENT — scanning it for "TypeError" produced
 * dozens of false gates on legitimate reads; file tools are covered by the
 * event channel instead.
 */
const FAILURE_SIGNATURES: RegExp[] = [
  /exit (?:code|status):?\s*[1-9]\d*/i,
  /\berror TS\d+\b/,
  /\bENOENT\b|\bEACCES\b|\bEPERM\b/,
  /command not found/i,
  // cmd AND PowerShell wordings of "unknown command" — pwsh phrasing was
  // uncovered, so head/tail/wc gates stored the "Check the spelling" boilerplate
  // tail instead of the cause line.
  /is not recognized as (?:an internal or external command|the name of a cmdlet)/i,
  /\b(SyntaxError|TypeError|ReferenceError|AssertionError)\b/,
  /Tests:\s+\d+\s+failed/i,
  // Runner summaries, language-agnostic. Count-bearing forms require a NON-ZERO
  // count in EITHER order ("1 failed" / "Failed: 1" / "Failures: 1") so a pass
  // tally ("0 failed", "Failed: 0") never reads as a failure. Covers pytest/
  // playwright/vitest/jest ("N failed"), RSpec/Elixir/minitest ("N failure(s)"),
  // dotnet/Maven/sbt/unittest ("Failed: N", "Failures: N", "failures=N").
  /\b[1-9]\d*\s+fail(?:ed|ures?)\b/i,
  /\bfail(?:ed|ures?)\s*[:=]\s*[1-9]\d*\b/i,
  /no tests? (?:found|matched|run|were executed)/i,
  // Generic error prefix (Playwright "Error: No tests found", Node, tracebacks).
  /^error:/i,
  // Compiler/tool error prefixes that carry a bracket before the colon:
  // Rust "error[E0308]:" and Maven/SBT "[ERROR] ...".
  /^\s*error\s*\[/i,
  /^\s*\[ERROR\]/i,
  // Go: "--- FAIL: TestName", "FAIL\tpkg", standalone "FAIL" (uppercase; pass is
  // "ok\tpkg"). \b keeps it off "FAILED"/"FAILURE".
  /\bFAIL\b/,
  // Build-level status words that never appear in a pass summary: Maven
  // "BUILD FAILURE", Gradle "BUILD FAILED" / "FAILURE: Build failed", sbt
  // "*** 1 TEST FAILED ***", dotnet build "Build FAILED.".
  /\bBUILD\s+(?:FAILURE|FAILED)\b/i,
  /\bFAILURE\b/i,
  /\bTESTS?\s+FAILED\b/i,
  // TAP ("node --test") failure marker.
  /^not ok\b/i,
  /thread '[^']*' panicked/,
  /\bpanic:/i,
  /\bFATAL\b/,
]

/** Lines that read like a SUCCESS summary. Quoting one as a failure's "last
 * error" teaches the agent to fix something that worked — the store held
 * "17 passed (3.1m)" as evidence for a failing gate (MidasAI). Matched as a
 * SUBSTRING so decorated summaries ("==== 10 passed ====", "ok\tpkg 0.3s",
 * "BUILD SUCCESSFUL") are caught too — the pass shape need not start the line. */
const SUCCESS_SHAPED: RegExp[] = [
  /\b\d+\s+passed\b/i,
  /\b\d+\s+(?:tests?|specs?|examples?)\s+passed\b/i,
  /\ball tests passed\b/i,
  /\bBUILD SUCCESS(?:FUL)?\b/i,
  /\btest result: ok\b/i,
  /\bOK\s*\(\s*\d+\s+tests?/i,
  /^ok\s+\S/i,
  // dotnet: pass summaries lead with "Passed!" ("Failed!" = failure) or say
  // "Build succeeded." / "Test Run Successful."
  /^Passed!/i,
  /\bBuild succeeded\b/i,
  /\bTest Run Successful\b/i,
  /\bno offenses detected\b/i,
  /\b0 issues\b/i,
  // gradle/node noise that is never failure evidence: task summary, config-cache
  // note, node version banner (printed at the tail of a crash, it is not the cause).
  /\b\d+\s+actionable tasks?\b/i,
  /\bConfiguration cache entry\b/i,
  /^Node\.js v\d+\./i,
  // PowerShell table rows (Get-Process / Get-Item / Get-ChildItem data): a probe
  // RESULT line is never failure evidence, even when the exit code says otherwise
  // (SilentlyContinue probes exit non-zero on empty result sets).
  /^\s*\d+\s+\S+\s{2,}\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\s+\d{1,2}:\d{2}:\d{2}\s*$/,
  /^\s*[A-Za-z]:[\\/]\S+\s{2,}\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}[.,]?\s+\d{1,2}:\d{2}:\d{2}\s*$/,
  /^\s*[d-][a-z-]{4,}\s+\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/,
]

export function looksLikeSuccess(line: string): boolean {
  // A line that reports failures is not a success even when it also tallies
  // passes ("1 failed, 1780 passed", "Failed: 1"). Non-zero count in either
  // order, mirroring the failure signatures.
  if (/\b[1-9]\d*\s+fail(?:ed|ures?)\b/i.test(line)) return false
  if (/\bfail(?:ed|ures?)\s*[:=]\s*[1-9]\d*\b/i.test(line)) return false
  return SUCCESS_SHAPED.some((rule) => rule.test(line))
}

/** Leading decorations runners wrap summaries in ("====", "---", "[info]",
 * "✔") — stripped before matching so a pattern needs not anticipate every
 * tool's framing. Bounded so a real line is never eaten whole. */
const LEADING_DECORATION = /^[\s=\-─—_*#•»>]{0,40}/

export function looksLikeFailure(line: string): boolean {
  if (line.trim() === "" || looksLikeSuccess(line)) return false
  const bare = line.replace(LEADING_DECORATION, "")
  return FAILURE_SIGNATURES.some((rule) => rule.test(line) || rule.test(bare))
}

export function detectFailure(outputText: string): FailureDetection {
  // PowerShell colors errors with VT sequences — strip before scanning, or
  // the escapes persist into snippets/corrections shown to the agent.
  for (const line of stripControl(outputText).split("\n")) {
    for (const signature of FAILURE_SIGNATURES) {
      if (signature.test(line)) {
        return { matched: true, snippet: line.trim().slice(0, 200) }
      }
    }
  }
  return { matched: false, snippet: "" }
}

/**
 * For exit-code failures whose output matched no signature, a bare
 * "exit code N" gives a human/agent nothing to write a correction from.
 * Bash output is command output (safe to surface). Scan from the END for a
 * failure-shaped line — compilers/test runners print their summary last, but a
 * SUCCESS-shaped tail ("17 passed") is never failure evidence: chained commands
 * and `Select-Object -Last N` pipelines put another shard's pass summary there.
 * Prefer the last real error line, then the last non-success line, then the exit code.
 */
export function failureSnippet(outputText: string, exitCode: number | null): string {
  const lines = stripControl(outputText)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
  if (exitCode !== null && exitCode !== 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? ""
      if (looksLikeFailure(line)) return line.slice(0, 200)
    }
    // No failure-shaped line: the last non-success line beats a bare exit code.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? ""
      if (!looksLikeSuccess(line)) return line.slice(0, 200)
    }
    return `exit code ${exitCode}`
  }
  const tail = lines[lines.length - 1]
  if (tail !== undefined && tail !== "") return tail.slice(0, 200)
  return `exit code ${exitCode}`
}

// --- Noise filtering ----------------------------------------------------------

/**
 * Infrastructure noise, not agent mistakes: aborted/cancelled executions
 * (user hit stop, background task reaped) teach nothing and fragmented the
 * store with unactionable patterns. Aborted != failed.
 * Boundary: SERVER-side unavailability (daemon down, transport errors, 5xx)
 * is noise — the agent cannot learn from "the service was down". CLIENT-side
 * mistakes (4xx, wrong path, syntax) stay teachable and are NOT matched here.
 */
const NOISE_ERRORS: RegExp[] = [
  /tool execution aborted/i,
  /execution was aborted/i,
  /\baborted by user\b/i,
  /\bcancelled by user\b/i,
  /\bcanceled by user\b/i,
  /no results found for your query/i, // grep_app empty search: the tool worked, nothing matched
  /user dismissed this question/i, // question tool: the user's choice, not a failure
  // Infrastructure unavailability: the service, not the command, failed.
  /lsp (?:server|daemon|process)[^.\n]*(?:unreachable|not running|disconnected|crashed|did not become reachable)/i,
  /\b(?:daemon|server)\b[^.\n]*(?:unreachable|did not become reachable)/i,
  /streamable ?http ?error/i, // MCP streamable-http transport failure
  /\bmcp error\b/i, // MCP transport/protocol errors
  /non.?2xx status code/i, // webfetch HTTP failure: the endpoint answered, the URL fetch didn't
  /\btransport error\b/i, // webfetch/gRPC transport failure: the connection itself never completed
  // Browser automation: the page/context/browser was already closed when the
  // action ran — a transient startup/state hiccup fixed by relaunching, not an
  // agent habit (and a non-bash tool error could only ever watch anyway).
  /target page, context or browser has been closed/i,
  // LSP too slow to answer a diagnostics request in the window — a latency
  // hiccup, not an agent mistake (and lsp_* tools only ever watch anyway).
  /timed out waiting for (?:fresh )?diagnostics/i,
]

export function isNoiseError(errorText: string): boolean {
  return NOISE_ERRORS.some((rule) => rule.test(errorText))
}

// --- Long-running command guard ------------------------------------------------

/**
 * High-confidence dev-server / watcher starters. Running one in FOREGROUND bash
 * blocks the tool call until its timeout (~2 min) and strands an orphan process.
 * Deliberately conservative: only unambiguous starters are listed (ambiguous
 * `node <file>`, `go run`, `dotnet run` are NOT here — they may be one-shots).
 * This is a bounded, recognizable class, unlike open-ended error detection.
 */
const SERVER_STARTERS: RegExp[] = [
  // `start` included: `npm start` is the canonical dev-server script (CRA et al).
  // `workspace <name>` covers monorepo `yarn workspace app dev`.
  /\b(npm|yarn|pnpm|bun)\s+(run\s+|workspace\s+\S+\s+)?(dev|serve|watch|start)\b/i,
  /\b(next|nuxt|astro)\s+dev\b/i,
  /\bng\s+serve\b/i, // Angular
  // `vite` as a command: not in a filename ("vite.config.ts"), not "vitest", not a
  // `build:` script target ("npm run build:vite"), and not followed by a bare
  // `build` (one-shot). `vite build --watch` is a watcher (separate rule).
  /(?<![:\w])vite\b(?![.\w])(?![^\n]*\bbuild\b)/i,
  /\bvite\s+build\b[^\n]*\bwatch\b/i,
  // Flask 2.3+ puts `--app X` between the binary and `run`.
  /\b(flask|streamlit)\b[^\n|;&]*\brun\b/i,
  // Require an arg (module:var or flag) so `pip install uvicorn gunicorn` and
  // `grep uvicorn` (mention/install) don't read as starting a server.
  /\b(uvicorn|gunicorn)\s+(?:--?\w[^\s]*|\S+:\S+)/i,
  /\bpython\d?(?:\.\d+)?\s+-m\s+http\.server\b/i,
  /\b(python\d?(?:\.\d+)?\s+)?manage\.py\s+runserver\b/i, // Django
  /\bdjango-admin\s+runserver\b/i,
  // Python scripts named like servers (Flask/FastAPI entrypoints).
  // Negative lookahead for `\s+cli\b`: `python …/server.py cli …` is a one-shot
  // CLI invocation (e.g. muffin-supervisor), not a foreground server start.
  /\bpython\d?(?:\.\d+)?\s+(?:\S*[\/\\])?(?:app|server|main|run|wsgi|asgi)\.py\b(?!\s+cli\b)/i,
  /\bphp\s+(-S|artisan\s+serve)\b/i, // built-in / Laravel
  /\bjupyter\s+(lab|notebook)\b/i,
  /\b(webpack-dev-server|webpack\s+serve)\b/i,
  /\b(http-server|live-server)\b/i,
  // Docker foreground services: `compose up` / `run` WITHOUT -d/--detach block.
  // `docker run` constrained to server-ish flags (-p/--publish/-it) to avoid
  // flagging one-shot containers (`docker run --rm alpine echo hi`).
  /\bdocker(?:-compose)?\s+compose\s+up\b(?![^\n]*\s(?:-d|--detach)\b)/i,
  /\bdocker\s+run\b(?![^\n]*\s(?:-d|--detach)\b)(?=[^\n]*\s(?:-p|--publish|-it)\b)/i,
  // Built-in runtime watchers (Node 18+ / Bun): unambiguous long-running.
  /\bnode\s+--watch\b/i,
  /\bbun\s+--watch\b/i,
  /\bmvn\b[^\n]*\bspring-boot:run\b/i,
  /\bgradlew?\b[^\n]*\bbootRun\b/i,
  /\bdotnet\s+watch\b/i, // `dotnet run` stays excluded (ambiguous one-shot vs server)
  /\brails\s+(s|server)\b/i,
  /\bhugo\s+server\b/i,
  /\bjekyll\s+serve\b/i,
  /\bmkdocs\s+serve\b/i,
  /\bmix\s+phx\.server\b/i, // Elixir/Phoenix
  /\biex\s+-S\s+mix\b/i,
  /\bnodemon\b/i,
  /\b(expo|react-native)\s+start\b/i,
  /\bollama\s+serve\b/i,
]

/** Markers that mean the process is already detached / backgrounded. */
function isDetached(command: string): boolean {
  // Start-Process detaches UNLESS -Wait (blocks for exit) or -NoNewWindow
  // (runs in the caller's window, effectively foreground).
  if (/\bStart-Process\b/i.test(command)) return !/\s-(?:Wait|NoNewWindow)\b/i.test(command)
  // Self-detaching managers/sessions.
  if (/\b(Start-Job|pm2|forever|daemonize|systemd-run|setsid)\b/i.test(command)) return true
  if (/\btmux\s+(new-session|new)\b/i.test(command)) return true
  // `screen -dmS`/`-d -m` start detached; a bare `screen -S name` is foreground.
  if (/\bscreen\s+-(d|m)/i.test(command)) return true
  if (/\bstart\s+\/b\b/i.test(command)) return true // cmd.exe background
  // A standalone background `&` (not part of `&&`), anywhere — trailing,
  // mid-chain, or closing a subshell (`(cmd &)`). `&&` chains stay foreground.
  // BUT `& … wait` blocks until the background job finishes, and `nohup X`
  // without `&` still runs in the foreground — both are NOT detached.
  if (/(^|[^&])&([^&]|$)/.test(command.trim())) return !/\bwait\b/i.test(command)
  if (/\b(nohup|disown)\b/i.test(command)) return false // needs `&` to detach; handled above
  return false
}

export function isLongRunningCommand(command: string): boolean {
  return SERVER_STARTERS.some((rule) => rule.test(command))
}

/** Warn only for a foreground server start; a detached one is fine. */
export function shouldWarnLongRunning(command: string): boolean {
  return isLongRunningCommand(command) && !isDetached(command)
}

/**
 * Agent-written polling loops with no timeout guard. These are NOT servers —
 * they hang in a while/until/for loop waiting for a condition (usually a health
 * endpoint) that may never arrive, until the bash timeout kills them.
 */
const WAIT_LOOP: RegExp[] = [
  // `-Milliseconds 500` / `-Seconds 1` spellings: the unit parameter sits
  // between the cmdlet and the number — a bare `\s+\d` missed the whole family.
  /\b(?:while|until)\b[^\n]*\b(?:sleep|Start-Sleep)\s+(?:-[A-Za-z]+\s+)?\d/i,
  // Multi-line loops: infinite condition ($true/true) or a network/health/file
  // probe, with a sleep anywhere in the body (possibly on later lines).
  /\b(?:while|until)\b[^\n]*(?:\$true|\btrue\b|\bTest-Connection\b|\bTest-Path\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bcurl\b|\bwget\b)[\s\S]{0,500}?\b(?:sleep|Start-Sleep)\b/i,
  /\bfor\s*\([^\n]*\)\s*\{[\s\S]{0,400}?\b(?:sleep|Start-Sleep)\s+\d/i,
]

export function shouldWarnWaitLoop(command: string): boolean {
  return WAIT_LOOP.some((rule) => rule.test(command))
}

// --- Detached spawn + suppressed stdout guard ---------------------------------

/**
 * Compensating measure for anomalyco/opencode#29831 (+ #42756): opencode ends
 * a bash call only on stdio EOF, so a call that spawns a DETACHED daemon while
 * piping/redirecting stdout hands the open pipe to the living daemon — the call
 * hangs forever. Static, bounded class like SERVER_STARTERS. REMOVE this guard
 * when the upstream fix ships. The spawner matches the RAW statement (quoted
 * spans included), so `echo "siphon-supervisor.mjs start" > log` flags — rare,
 * accepted, same raw-match philosophy as the long-running guard.
 */
const DETACHED_SPAWNERS: RegExp[] = [/\bsiphon-supervisor\.mjs["']?\s+(?:start|restart)\b/i] // quoted exe/script paths are the norm on Windows

/** stdout redirects (`>`, `>>`, `1>`, `1>>`) — never `2>`/`2>&1` (the digit
 * lookbehind), never `>&1` (the lookahead). Runs on the quote-stripped
 * statement so `"log > file"` inside a string is not a redirect. */
const STDOUT_REDIRECT = /(?<![\d>&])1?>>?(?![>&])/

/** True when ONE statement (chain segments + their pipe tails) contains both a
 * known detached-spawner and stdout suppression — the exact hang shape. A pipe
 * anywhere in the statement counts (it keeps a stdout handle open); `2>`/`2>&1`
 * alone do not. */
export function shouldWarnSuppressedSpawn(command: string): boolean {
  let stmt = ""
  let hasPipe = false
  const flagged = (): boolean =>
    stmt !== "" && DETACHED_SPAWNERS.some((rule) => rule.test(stmt)) && (hasPipe || STDOUT_REDIRECT.test(stripQuotedSpans(stmt)))
  for (const segment of splitChainTagged(command)) {
    if (segment.pipeTail && stmt !== "") {
      stmt += " | " + segment.text
      hasPipe = true
      continue
    }
    if (flagged()) return true
    stmt = segment.text
    hasPipe = false
  }
  return flagged()
}

// --- Inherited-spawn guard (Start-Process handle leak) ------------------------

/**
 * The second leak path of anomalyco/opencode#29831: `Start-Process` with
 * `-RedirectStandard*` (or `-Wait`) turns ON handle inheritance — the spawned
 * process receives THIS call's stdio pipes among the inheritable handles, and
 * opencode ends a bash call only on stdio EOF, so a child that outlives the
 * call holds the pipes open forever. Empirically verified on this machine:
 * redirecting ALL THREE streams still hangs; a BARE `Start-Process` (no
 * -Redirect*, no pipe/redirect on the spawn statement) leaks nothing and
 * returns at once; with a short-lived child the call merely waits its
 * lifetime. Daemon intent comes from `-WindowStyle Hidden|Minimized` or a known
 * server starter as the spawned command (both production hangs carried the
 * hidden window); a detached-but-bare spawn is safe and stays unflagged.
 */
const START_PROCESS_STMT = /Start-Process\b/i
/** Daemon-intent markers: a hidden/minimized window or a known server starter
 * as the spawned command — both outlive the call, which is what turns the
 * handle leak into a forever hang. A redirected one-shot child merely delays
 * the call by its lifetime, so redirect-only statements stay unflagged. */
const OUTLIVES_CALL = /-WindowStyle\s+(?:Hidden|Minimized)/i
// No leading \b on -Wait: a space-to-dash transition is not a word boundary; the trailing \b still rejects -Waiting-style tails.
const SPAWN_LEAK = /-RedirectStandard\w+|-Wait\b/i

export function shouldWarnInheritedSpawn(command: string): boolean {
  let stmt = ""
  let hasPipe = false
  const flagged = (): boolean =>
    START_PROCESS_STMT.test(stmt) &&
    (SPAWN_LEAK.test(stmt) || hasPipe || STDOUT_REDIRECT.test(stripQuotedSpans(stmt))) &&
    (OUTLIVES_CALL.test(stmt) || SERVER_STARTERS.some((rule) => rule.test(stmt)))
  for (const segment of splitChainTagged(command)) {
    if (segment.pipeTail && stmt !== "") {
      stmt += " | " + segment.text
      hasPipe = true
      continue
    }
    if (flagged()) return true
    stmt = segment.text
    hasPipe = false
  }
  return flagged()
}

// --- Orphan-job guard (Start-Job dies with the call) ---------------------------

/** Start-Job runs inside THIS call's PowerShell: the job is killed silently
 * when the call ends, so "background" work never survives it — a correctness
 * trap (lost work, no error), not a hang. An in-call wait makes it synchronous
 * and safe. */
export function shouldWarnOrphanJob(command: string): boolean {
  // No leading \b before -Wait: a space-to-dash transition is not a word boundary.
  return /\bStart-Job\b/i.test(command) && !/\bWait-Job\b|\bReceive-Job\b[^;|&\n]*-Wait\b/i.test(command)
}

// --- Default corrections ------------------------------------------------------

const UNIX_TOOL_CORRECTION =
  "Unix tool, not a PowerShell command — use the native equivalent: Select-Object -First/-Last for head/tail, Get-Content for cat, Select-String for grep, (Get-Content <file>).Count for wc -l."

/**
 * Mechanical, overridable default correction chosen by command family, so a
 * promoted gate always ships with SOME teaching text instead of sitting
 * "NOT TEACHING" until a human writes one. Rules, not an LLM — the hot path
 * stays mechanical; a human/agent may refine the text later.
 */
export function suggestCorrection(signature: string, snippet: string): string {
  // A timeout kill is evidence about the CALL SHAPE (orphaned stdio holder or
  // a genuinely long run) — it must outrank every command-family guess: a
  // vitest suite killed at the timeout is not "a failing test".
  if (/terminated command after exceeding timeout/i.test(snippet)) {
    return "Killed at the bash timeout — the call ends only on stdio EOF, so SOMETHING held the pipe open. Read the killed run's output: if the command's own completion marker is there (test summary / BUILD SUCCESSFUL / final report), the command FINISHED and the leak is a child it spawned that never exited (worker pool, dev server, watch mode — often in the code under test, not the call shape) — fix that child's shutdown; retrying the same call will hang again. If there is no completion marker, the run itself was long: spawn/pipe/redirect shapes run bare + poll separately, and set an explicit timeout near the expected wall time."
  }
  if (/(^|\s)(--check|--dry-run|verify|check)\b/i.test(signature) && /dart run|generate|sync/i.test(signature)) {
    return "Generated artifacts are stale — run the same script WITHOUT the check flag to regenerate, then commit the result."
  }
  if (/\b(pytest|jest|vitest|mocha|cucumbertest|flutter test|npm test|gradlew\b[^\n]*test|dart test)\b/i.test(signature)) {
    return "A test is failing — read the failing assertion in the output and fix the code or the expectation; do not re-run the suite blindly."
  }
  if (/\b(tsc|typecheck|type-check)\b/i.test(signature)) {
    return "Type errors — run the compiler, read the reported file:line diagnostics, and fix the types before retrying."
  }
  if (/\b(curl|wget)\b/i.test(signature)) {
    return "Network/endpoint failure — verify the URL is reachable, check rate limits and timeouts; retry with backoff, not immediately."
  }
  if (/\b(npm|yarn|pnpm|bun)\s+(install|ci)\b/i.test(signature)) {
    return "Dependency install failed — inspect the resolver error; try the lockfile/legacy-peer-deps route the repo documents."
  }
  // Unix tools absent from PowerShell: a missing-command failure on one is a platform habit, teach the native form.
  if (/\b(head|tail|cat|wc|grep|sed|awk|cut|sort|uniq|tr|xargs|less)\b/i.test(signature) && /not recognized|command not found|Check the spelling of the name/i.test(snippet)) {
    return UNIX_TOOL_CORRECTION
  }
  // On Windows, head/tail/wc/... have no pwsh alias at all: a bare exit-code
  // failure on one is command-not-found even when the snippet lost the cmdlet
  // wording (OpenCode normalizes exits to 1). cat/grep/sort/tr are excluded —
  // they have pwsh aliases or common installs, so their exit 1 may be real.
  if (
    process.platform === "win32" &&
    /(^|[\s|;&(:])(?:head|tail|wc|sed|awk|cut|uniq|xargs|less)\b(?!:)/i.test(signature) &&
    /^exit code \d+$/i.test(snippet.trim())
  ) {
    return UNIX_TOOL_CORRECTION
  }
  // File-tool probes: not-found means a wrong path guess — locate the file
  // instead of retrying guessed path variants.
  if (/^(read|edit|write):/i.test(signature) && /ENOENT|no such file|not found/i.test(snippet)) {
    return "The file does not exist at that path — locate the real path with glob/grep before reading/editing; do not guess path variants."
  }
  // Missing command on this machine — install it or pick an available tool.
  if (/^bash:/i.test(signature) && /command not found|not recognized/i.test(snippet)) {
    return "The command is not installed on this machine — install it first, or use an alternative tool that is already available."
  }
  // A success-shaped snippet is never an error — quoting it ("Last error:
  // '17 passed'") teaches the agent to fix something that worked. Likewise a
  // bare exit code carries nothing to quote. Fall through to the generic text.
  if (snippet !== "" && !/^exit code \d+$/i.test(snippet) && !looksLikeSuccess(snippet)) {
    return `Last error: "${snippet}" — address that specific error before retrying this exact call.`
  }
  return "This exact call keeps failing — inspect the last output line and change approach before retrying."
}

// --- Repeat channel (outgoing-payload series detection) -------------------------

/** Marker keys the repeat channel injects into outgoing payloads (sanitize) and
 * accepts as a bypass (block tier) — stripped from identity so a model mimicking
 * a seen marker cannot defeat detection. */
export const REPEAT_MARKER = "_dejavu_repeat"
export const REPEAT_PROCEED = "_dejavu_proceed"

/** Stable identity for a call's args: sorted-keys JSON stringify with the
 * repeat-channel marker keys removed. NOT the same as callSignature — no
 * placeholder normalization (the provider checks byte-identity). Nested
 * objects are NOT recursively sorted — args are flat for all realistic tools. */
export function canonicalArgs(args: Record<string, unknown>): string {
  const rebuilt: Record<string, unknown> = {}
  for (const key of Object.keys(args)
    .filter((k) => k !== REPEAT_MARKER && k !== REPEAT_PROCEED)
    .sort()) {
    rebuilt[key] = args[key]
  }
  return JSON.stringify(rebuilt)
}

/** Series key shared by detectRepeatSeries and the before-hook block — one
 * formula in one place, or the two tiers silently disagree. */
export function signRepeatedCall(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${canonicalArgs(args)}`
}

export interface RepeatOccurrence {
  /** index into the messages array */
  messageIndex: number
  /** index into that message's parts array */
  partIndex: number
}

export interface RepeatSeries {
  /** `${tool}:${canonicalArgs}` */
  key: string
  tool: string
  occurrences: RepeatOccurrence[]
  /** true when the last occurrence sits in the LAST assistant message of the history */
  reachesTail: boolean
}

export interface RepeatScan {
  /** session of the history (first message's info.sessionID), null when absent */
  sessionID: string | null
  /** all series with 2+ consecutive rounds */
  series: RepeatSeries[]
}

export interface RepeatWindow {
  key: string
  tool: string
  count: number
  /** last occurrence (for NOTE attachment) */
  lastOccurrence: RepeatOccurrence
  /** previous occurrence (for failure-form comparison), null when count is 1 */
  prevOccurrence: RepeatOccurrence | null
}

export interface RepeatWindowScan {
  sessionID: string | null
  windows: RepeatWindow[]
}

/** Windowed repeats: the same call ≥ min times across the last `window`
 * assistant rounds, regardless of adjacency — interleaved loops (analysis
 * rounds between retries) never form a consecutive series but burn rounds just
 * the same. Tail-anchored: the last occurrence must sit in the last assistant
 * round (the model just did it again). Detection only — the caller decides
 * what failure-form stability means. */
export function detectRepeatWindows(
  messages: ReadonlyArray<{
    info: { role: string; sessionID?: string }
    parts: ReadonlyArray<{ type: string; tool?: string; state?: { input?: Record<string, unknown> } }>
  }>,
  opts?: { window?: number; min?: number },
): RepeatWindowScan {
  const window = opts?.window ?? 12
  const min = opts?.min ?? 3
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info.role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return { sessionID: messages[0]?.info.sessionID ?? null, windows: [] }
  const counts = new Map<string, { tool: string; occurrences: RepeatOccurrence[] }>()
  let roundsSeen = 0
  for (let i = lastAssistant; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined) continue
    if (msg.info.role !== "assistant") continue
    roundsSeen += 1
    if (roundsSeen > window) break
    // parallel duplicates inside one message are one round — first part wins
    const roundKeys = new Map<string, { tool: string; partIndex: number }>()
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool" || typeof part.tool !== "string" || part.state?.input == null) continue
      const key = signRepeatedCall(part.tool, part.state.input)
      if (!roundKeys.has(key)) roundKeys.set(key, { tool: part.tool, partIndex: p })
    }
    for (const [key, found] of roundKeys) {
      const entry = counts.get(key) ?? { tool: found.tool, occurrences: [] }
      entry.occurrences.push({ messageIndex: i, partIndex: found.partIndex })
      counts.set(key, entry)
    }
  }
  const windows: RepeatWindow[] = []
  for (const [key, entry] of counts) {
    if (entry.occurrences.length < min) continue
    entry.occurrences.sort((a, b) => a.messageIndex - b.messageIndex || a.partIndex - b.partIndex)
    const lastOcc = entry.occurrences[entry.occurrences.length - 1]
    if (lastOcc === undefined || lastOcc.messageIndex !== lastAssistant) continue
    windows.push({ key, tool: entry.tool, count: entry.occurrences.length, lastOccurrence: lastOcc, prevOccurrence: entry.occurrences[entry.occurrences.length - 2] ?? null })
  }
  return { sessionID: messages[0]?.info.sessionID ?? null, windows }
}

/** Detect series of byte-identical tool calls across consecutive assistant
 * rounds (DashScope rejects those in an outgoing payload, so the transform hook
 * sanitizes them). Parallel duplicates inside one message count as ONE round;
 * a non-assistant message — or an assistant message missing the key — breaks
 * the run. Pure: reads the payload shape, touches nothing else. */
export function detectRepeatSeries(
  messages: ReadonlyArray<{
    info: { role: string; sessionID?: string }
    parts: ReadonlyArray<{ type: string; tool?: string; state?: { input?: Record<string, unknown> } }>
  }>,
): RepeatScan {  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info.role === "assistant") {
      lastAssistant = i
      break
    }
  }
  interface Run {
    tool: string
    occurrences: RepeatOccurrence[]
    lastMessageIndex: number
  }
  const open = new Map<string, Run>()
  const series: RepeatSeries[] = []
  const close = (key: string, run: Run): void => {
    if (run.occurrences.length >= 2) {
      series.push({
        key,
        tool: run.tool,
        occurrences: run.occurrences,
        reachesTail: run.lastMessageIndex === lastAssistant,
      })
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.info.role !== "assistant") {
      // a user message interrupts every open run
      for (const [key, run] of open) close(key, run)
      open.clear()
      continue
    }
    // parallel duplicates inside one message are one round - first part wins
    const round = new Map<string, { tool: string; partIndex: number }>()
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool" || typeof part.tool !== "string" || part.state?.input == null) continue
      const key = signRepeatedCall(part.tool, part.state.input ?? {})
      if (!round.has(key)) round.set(key, { tool: part.tool, partIndex: p })
    }
    for (const [key, run] of open) {
      if (!round.has(key)) {
        close(key, run)
        open.delete(key)
      }
    }
    for (const [key, found] of round) {
      const run = open.get(key)
      if (run) {
        run.occurrences.push({ messageIndex: i, partIndex: found.partIndex })
        run.lastMessageIndex = i
      } else {
        open.set(key, { tool: found.tool, occurrences: [{ messageIndex: i, partIndex: found.partIndex }], lastMessageIndex: i })
      }
    }
  }
  for (const [key, run] of open) close(key, run)
  return { sessionID: messages[0]?.info.sessionID ?? null, series }
}
