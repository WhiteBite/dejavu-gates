/**
 * Property-based tests for the normalization pipeline — no framework needed.
 * A seeded generator composes bash-like commands from structural fragments
 * (chains, quotes, one-liners, paths, hashes, comments, markers); every
 * generated input must satisfy the mechanical invariants below. These are the
 * invariants the escaping edge cases kept violating before they were found.
 *
 * Run: bun test/property.ts
 */
import { join } from "node:path"
import {
  bashSegmentSignatures,
  callSignature,
  fuzzySimilar,
  hasGenericResidualIdentity,
  isRepoLocal,
  levenshtein,
  normalizeCommand,
  normalizeFilePath,
  parameterizeError,
  scrubSecrets,
  splitChain,
} from "../src/patterns"
import { hasNestedTokens } from "../src/validate"

// --- seeded RNG (reproducible) -----------------------------------------------

let seed = 20260824
function rnd(): number {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}
function rint(max: number): number {
  return Math.floor(rnd() * max)
}
function pick<T>(arr: readonly T[]): T {
  return arr[rint(arr.length)] as T
}

// --- generator ----------------------------------------------------------------

const VERBS = [
  "npm run build",
  "git status",
  "./gradlew test",
  "python main.py",
  "bun install",
  "cargo build",
  "curl -s http://localhost:3000/api",
  "docker compose up",
  "npx tsc --noEmit",
  "flutter analyze",
  "grep -n foo bar.txt",
]
const CHAINS = [" && ", " || ", " | ", "; ", "\n", "\r\n"]
const QUOTED = ['"hello world"', "'single'", '"with spaces"', '"a;b"', '"nested \\"quote\\""', "'it''s'"]
const ONELINERS = [
  'python -c "print(1)"',
  'node -e "process.exit(1)"',
  'bun -e "throw new Error(1)"',
  'python -c "import os; print(os.name)"',
  'pwsh -Command "Get-Process"',
  "python3 -u -c \"open('f').read()\"",
  'php -r "echo 1;"',
  'julia -e "println(1)"',
  'lua -e "print(1)"',
  'Rscript -e "cat(1)"',
  'php -d memory_limit=256M -r "exit(1);"',
  "node -r ts-node/register server.js",
  "python -m http.server",
]
const PATHS = ["C:\\Users\\dev\\project\\file.ts", "/usr/local/bin/tool", "./relative/path.txt", "D:\\Sources\\AI\\repo\\src\\index.ts"]
const HEXES = ["abc123def456", "7f3a9b2c", "deadbeefcafe0123", "1234567"]
const NUMS = ["0", "1", "42", "3.14", "8080", "192.168.1.100"]
const COMMENTS = ["# probe", "# dejavu:proceed", "# comment with 'quotes'"]
const SECRETS = ["sk-proj-" + "ABCDEFGHIJKLMNOPQRSTuv012345", "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234"]

function genCommand(): string {
  const parts: string[] = []
  const n = 1 + rint(4)
  for (let i = 0; i < n; i++) {
    const roll = rnd()
    if (roll < 0.25) parts.push(pick(VERBS))
    else if (roll < 0.4) parts.push(`${pick(VERBS)} ${pick(QUOTED)}`)
    else if (roll < 0.55) parts.push(pick(ONELINERS))
    else if (roll < 0.7) parts.push(`cd ${pick(PATHS)}`)
    else if (roll < 0.8) parts.push(`echo ${pick(NUMS)}`)
    else if (roll < 0.9) parts.push(`git log ${pick(HEXES)}`)
    else if (roll < 0.95) parts.push(`echo $(${pick(VERBS)})`)
    else parts.push(pick(COMMENTS))
  }
  let cmd = parts.join(pick(CHAINS))
  if (rnd() < 0.1) cmd += ` ${pick(COMMENTS)}`
  return cmd
}

function genErrorText(): string {
  const templates = [
    "ENOENT: no such file or directory, open '/tmp/x'",
    "Error: connect ECONNREFUSED 192.168.1.100:3000",
    "error TS2322: Type 'string' is not assignable to type 'number'",
    "Cannot find module 'lodash' at C:\\x\\y.ts",
    "timeout after 30000ms",
    "AssertionError: assert 'a' == 'b'",
    "exit code 1: command not found",
  ]
  return pick(templates)
}

// --- runner ---------------------------------------------------------------------

let failures = 0
function fail(name: string, detail: string): void {
  failures += 1
  if (failures <= 10) console.error(`FAIL - ${name}\n       ${detail}`)
}

const RUNS = 3000

for (let i = 0; i < RUNS; i++) {
  const cmd = genCommand()

  let norm: string
  try {
    norm = normalizeCommand(cmd)
  } catch (error) {
    fail("normalizeCommand threw", `${String(error)} on ${JSON.stringify(cmd)}`)
    continue
  }
  if (normalizeCommand(norm) !== norm) {
    fail("normalizeCommand not idempotent", `${JSON.stringify(cmd)} -> ${JSON.stringify(norm)} -> ${JSON.stringify(normalizeCommand(norm))}`)
  }
  if (hasNestedTokens(norm)) {
    fail("nested placeholder tokens", `${JSON.stringify(cmd)} -> ${JSON.stringify(norm)}`)
  }
  if (norm.length > cmd.length * 5 + 64) {
    fail("output explosion", `${JSON.stringify(cmd)} (${cmd.length}) -> ${norm.length} chars`)
  }

  // splitChain: no empty segments; every segment is atomic (re-splits to itself)
  const segments = splitChain(cmd)
  for (const seg of segments) {
    if (seg.trim() === "") fail("splitChain produced empty segment", JSON.stringify(cmd))
    if (splitChain(seg).length !== 1) {
      fail("segment is not atomic under re-split", `${JSON.stringify(cmd)} -> segment ${JSON.stringify(seg)} -> ${JSON.stringify(splitChain(seg))}`)
    }
  }
}

// one-liner identity: different code = different key, same code = same key
const oneLinerA = 'python -c "fetch(\'alpha\')"'
const oneLinerB = 'python -c "fetch(\'beta\')"'
if (callSignature("bash", { command: oneLinerA }) === callSignature("bash", { command: oneLinerB })) {
  fail("one-liner distinctness", "different payloads collapsed to one signature")
}
if (callSignature("bash", { command: oneLinerA }) !== callSignature("bash", { command: oneLinerA })) {
  fail("one-liner determinism", "same payload produced different signatures")
}
if (!/<code:[0-9a-f]{8}>/.test(callSignature("bash", { command: oneLinerA }) ?? "")) {
  fail("one-liner fingerprint shape", callSignature("bash", { command: oneLinerA }) ?? "(null)")
}

// quote equivalence: the same code in double/single/bare spelling is ONE key
const pyDouble = 'python -c "print(1)"'
const pySingle = "python -c 'print(1)'"
const pyBare = "python -c print(1)"
if (
  callSignature("bash", { command: pyDouble }) !== callSignature("bash", { command: pySingle }) ||
  callSignature("bash", { command: pyDouble }) !== callSignature("bash", { command: pyBare })
) {
  fail(
    "one-liner quote equivalence",
    `${pyDouble} / ${pySingle} / ${pyBare} -> ${callSignature("bash", { command: pyDouble })} / ${callSignature("bash", { command: pySingle })} / ${callSignature("bash", { command: pyBare })}`,
  )
}
const pyFlagged = 'python -c "print(1)" --flag'
const pyFlaggedOnce = normalizeCommand(pyFlagged)
if (normalizeCommand(pyFlaggedOnce) !== pyFlaggedOnce) {
  fail("one-liner with trailing flags not idempotent", `${pyFlagged} -> ${pyFlaggedOnce} -> ${normalizeCommand(pyFlaggedOnce)}`)
}
if (callSignature("bash", { command: pyFlagged }) === callSignature("bash", { command: pyDouble })) {
  fail("one-liner trailing flag must change the signature", `${pyFlagged} and ${pyDouble} collapsed`)
}
const pyHere = 'pwsh -c @"\nprint(1)\n"@'
const pyHereSig = callSignature("bash", { command: pyHere })
if (pyHereSig === null || !/^bash:pwsh -c <code:[0-9a-f]{8}>$/.test(pyHereSig)) {
  fail("here-string fingerprint shape", pyHereSig ?? "(null)")
}
if (pyHereSig === callSignature("bash", { command: pyBare.replace("python", "pwsh") })) {
  fail("here-string markers must participate in the fingerprint", "markers stripped from the hash")
}

// package-runner canonicalization is idempotent — a second pass must not rewrite it again
const PACKAGE_RUNNER_FORMS = [
  "npm run build",
  "pnpm run build",
  "yarn run build",
  "bun run build",
  "npx tsc --noEmit",
  "pnpm dlx tsc --noEmit",
  "pnpm exec tsc --noEmit",
  "yarn dlx tsc --noEmit",
  "bunx tsc --noEmit",
]
for (const cmd of PACKAGE_RUNNER_FORMS) {
  const once = normalizeCommand(cmd)
  if (normalizeCommand(once) !== once) {
    fail("package-runner canonicalization not idempotent", `${JSON.stringify(cmd)} -> ${JSON.stringify(once)}`)
  }
}

// override marker neutrality: appending the marker never changes the signature
for (let i = 0; i < 200; i++) {
  const cmd = genCommand()
  const plain = callSignature("bash", { command: cmd })
  const marked = callSignature("bash", { command: `${cmd} # dejavu:proceed` })
  if (plain !== marked) {
    fail("override marker changed the signature", `${JSON.stringify(cmd)}: ${plain} vs ${marked}`)
    break
  }
}

// secrets must never survive the normalize+scrub pipeline
for (const secret of SECRETS) {
  const cmd = `curl -H "Authorization: ${secret}" https://api.example.com`
  const out = scrubSecrets(normalizeCommand(cmd))
  if (out.includes(secret)) fail("secret survived normalize+scrub", JSON.stringify(cmd))
}

// parameterizeError: idempotent and collapses variable parts
for (let i = 0; i < 500; i++) {
  const text = genErrorText()
  const once = parameterizeError(text)
  if (parameterizeError(once) !== once) {
    fail("parameterizeError not idempotent", `${JSON.stringify(text)} -> ${JSON.stringify(once)}`)
    break
  }
}
if (
  parameterizeError("fail 7c1811ed-e98f-4c9c-a9f9-58c757ff494f.json") !==
  parameterizeError("fail 0751007c-1234-5678-9abc-def012345678.json")
) {
  fail("parameterizeError uuid collapse", "distinct uuids produced distinct signatures")
}

// fuzzy similarity is symmetric
for (let i = 0; i < 500; i++) {
  const a = `bash:${genCommand()}`
  const b = `bash:${genCommand()}`
  if (fuzzySimilar(a, b) !== fuzzySimilar(b, a)) {
    fail("fuzzySimilar not symmetric", `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
    break
  }
}

// capped-DP fuzzy must be indistinguishable from the reference semantics
// (full Levenshtein + ratio rule) — the early exit may only skip work, never
// change verdicts. Mutated pairs sit near the distance/ratio boundary.
function refFuzzySimilar(a: string, b: string): boolean {
  if (a === b) return true
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return true
  if (maxLen > 300) return false
  const codesA = a.match(/<code:[0-9a-f]+>/g)
  const codesB = b.match(/<code:[0-9a-f]+>/g)
  if (codesA !== null || codesB !== null) {
    if (codesA === null || codesB === null || codesA.join("\u0000") !== codesB.join("\u0000")) return false
  }
  const flags = (s: string): string[] => s.split(/\s+/).filter((t) => t.startsWith("-")).sort()
  const subset = (x: string[], y: string[]): boolean => {
    const set = new Set(y)
    return x.every((t) => set.has(t))
  }
  const fa = flags(a)
  const fb = flags(b)
  if (!subset(fa, fb) && !subset(fb, fa)) return false
  const nonFlag = (s: string): string => s.split(/\s+/).filter((t) => !t.startsWith("-")).join(" ")
  const setEqual = (x: string[], y: string[]): boolean => {
    const setY = new Set(y)
    return new Set(x).size === setY.size && x.every((t) => setY.has(t))
  }
  const strictFlagAdd = !setEqual(fa, fb) && nonFlag(a) === nonFlag(b)
  if (!strictFlagAdd && Math.abs(a.length - b.length) / maxLen > 0.3) return false
  const distance = levenshtein(a, b)
  if (strictFlagAdd) return distance >= 3 && distance <= Math.max(Math.floor(maxLen * 0.3), 24)
  return distance >= 3 && distance / maxLen <= 0.3
}
function mutate(s: string): string {
  let out = s
  const k = 1 + rint(8)
  for (let j = 0; j < k; j++) {
    const op = rint(3)
    const pos = out.length > 0 ? rint(out.length) : 0
    if (op === 0) out = out.slice(0, pos) + pick(["x", "-", " ", "7"]) + out.slice(pos)
    else if (op === 1 && out.length > 1) out = out.slice(0, pos) + out.slice(pos + 1)
    else if (out.length > 0) out = out.slice(0, pos) + pick(["y", "_", "Q"]) + out.slice(pos + 1)
  }
  return out
}
for (let i = 0; i < 2000; i++) {
  const a = `bash:${genCommand()}`
  const b = i % 2 === 0 ? mutate(a) : `bash:${genCommand()}`
  if (fuzzySimilar(a, b) !== refFuzzySimilar(a, b)) {
    fail("capped fuzzy diverges from reference", `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
    break
  }
}

// a command hidden inside $(...) or backticks must still surface as a segment
// signature — substitutions are a chain-bypass hole if the scanner misses them
for (const verb of VERBS) {
  const inner = callSignature("bash", { command: verb })
  if (inner === null) continue
  const wrapped = [`echo prefix $(${verb}) suffix-more`, "echo prefix `" + verb + "` suffix-more", `X=$(${verb}) && echo done`, `echo "$(${verb})" | tee log.txt`]
  for (const w of wrapped) {
    if (!bashSegmentSignatures(w).includes(inner)) {
      fail("substitution hid a gated command", `${JSON.stringify(w)} -> ${JSON.stringify(bashSegmentSignatures(w))}`)
    }
  }
}

const projectDir = process.platform === "win32" ? "C:\\work\\project" : "/work/project"
const FILES = ["src/x.ts", "lib/y.py", "a/b/z.json", "missing.ts"]
for (let i = 0; i < 400; i++) {
  const rel = pick(FILES)
  const abs = join(projectDir, rel)
  const winRel = rel.replace(/\//g, "\\")
  const norm = normalizeFilePath(abs, projectDir)
  if (norm !== rel) fail("absolute path did not normalize to repo-relative", `${JSON.stringify(abs)} -> ${JSON.stringify(norm)}`)
  if (normalizeFilePath(rel, projectDir) !== norm) fail("relative spelling diverged from absolute", `${JSON.stringify(rel)} vs ${JSON.stringify(abs)}`)
  if (normalizeFilePath(winRel, projectDir) !== norm) fail("windows separators diverged", `${JSON.stringify(winRel)} vs ${JSON.stringify(rel)}`)
  if (normalizeFilePath(abs) !== rel.split("/").pop()) fail("missing projectDir did not fall back to basename", `${JSON.stringify(abs)}`)
  const outside = join(projectDir, "..", "elsewhere", rel.split("/").pop() ?? rel)
  if (normalizeFilePath(outside, projectDir) !== (rel.split("/").pop() ?? rel)) fail("out-of-repo path did not fall back to basename", JSON.stringify(outside))
}

if (isRepoLocal("read:src/git/x.ts")) fail("non-bash signature treated as repo-local", "read:src/git/x.ts")
if (!isRepoLocal("bash:git status")) fail("bash repo-local verb lost", "bash:git status")

// generic (unknown) tool signatures: deterministic, key-order-independent, bounded
const GENERIC_TOOLS = ["mcp__srv__tool", "spawn_agent", "custom_tool"]
const GENERIC_VALUES: unknown[] = [1, 2.5, "delete", "https://x.example/a", "550e8400-e29b-41d4-a716-446655440000", "deadbeefcafe0123", true, null, [1, "x"], { k: 1, j: "y" }]
for (let i = 0; i < 500; i++) {
  const tool = pick(GENERIC_TOOLS)
  const args: Record<string, unknown> = {}
  const n = 1 + rint(4)
  for (let j = 0; j < n; j++) args[`k${rint(5)}`] = pick(GENERIC_VALUES)
  const sig = callSignature(tool, args)
  if (sig === null || sig === "") {
    fail("generic tool produced no signature", `${tool} ${JSON.stringify(args)}`)
    break
  }
  if (!sig.startsWith(`${tool.toLowerCase()}:`)) {
    fail("generic signature lost its tool prefix", `${tool} -> ${sig}`)
    break
  }
  if (sig.startsWith("bash:")) {
    fail("generic signature masqueraded as bash", `${tool} -> ${sig}`)
    break
  }
  if (sig.length > 512) {
    fail("generic signature explosion", `${tool} -> ${sig.length} chars`)
    break
  }
  const reordered: Record<string, unknown> = {}
  for (const key of Object.keys(args).reverse()) reordered[key] = args[key]
  if (callSignature(tool, reordered) !== sig) {
    fail("generic signature not key-order-independent", `${tool} ${JSON.stringify(args)} -> ${sig} vs ${callSignature(tool, reordered)}`)
    break
  }
}
if (hasGenericResidualIdentity(callSignature("mcp__srv__tool", { a: 1, b: 2 }) ?? "")) {
  fail("numeric-only generic shape gained residual identity", "mcp__srv__tool:a=<n> b=<n>")
}

if (failures > 0) {
  console.error(`\n${failures} property failure(s) out of ${RUNS} generated inputs`)
  process.exit(1)
}
console.log(`all properties held across ${RUNS} generated inputs`)
