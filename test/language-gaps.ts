/**
 * Language-ecosystem gap coverage for src/patterns.ts (pure functions only).
 * Run: bun test/language-gaps.ts
 */
import {
  bashSegmentSignatures,
  canBlock,
  canRemind,
  detectFailure,
  hasResidualIdentity,
  isIntendedNonzero,
  looksLikeSuccess,
  normalizeCommand,
  scrubSecrets,
  suggestCorrection,
} from "../src/patterns"
import { makeChecker } from "./helpers"

const { check, report } = makeChecker()

// --- D1: interpreter one-liners ---
const phpA = normalizeCommand('php -r "echo 1;"')
check("php -r payload is fingerprinted", /^php -r <code:[0-9a-f]{8}>$/.test(phpA))
check("julia -e payload is fingerprinted", /^julia -e <code:[0-9a-f]{8}>$/.test(normalizeCommand('julia -e "println(1)"')))
check("lua -e payload is fingerprinted", /^lua -e <code:[0-9a-f]{8}>$/.test(normalizeCommand('lua -e "print(1)"')))
check("Rscript -e payload is fingerprinted", /^rscript -e <code:[0-9a-f]{8}>$/.test(normalizeCommand('Rscript -e "cat(1)"')))

const phpB = normalizeCommand('php -r "echo 2;"')
check("different php -r payloads get different fingerprints", phpA !== phpB)
check("identical php -r payloads get identical fingerprints", phpA === normalizeCommand('php -r "echo 1;"'))
check("one-liner normalization stays idempotent", normalizeCommand(phpA) === phpA)
check(
  "quote spellings of the same code converge on one fingerprint",
  normalizeCommand('python -c "print(1)"') === normalizeCommand("python -c 'print(1)'") && normalizeCommand('python -c "print(1)"') === normalizeCommand("python -c print(1)"),
)

const pyMod = normalizeCommand("python -m http.server")
check("python -m keeps the module name visible", pyMod.includes("http.server"))
check("python -m keeps residual identity", hasResidualIdentity(`bash:${pyMod}`))

const phpSecretPayload = "sk-proj-" + "ABCDEFGHIJKLMNOPQRSTUVWXyz0123456789"
const phpSecret = normalizeCommand(`php -r "echo '${phpSecretPayload}';"`)
check("php -r payload secret never reaches the signature", !phpSecret.includes(phpSecretPayload) && phpSecret.includes("<code:"))

const nodePreload = normalizeCommand("node -r ts-node/register server.js")
check("node -r (module preload) is NOT fingerprinted as code", !nodePreload.includes("<code:"))

check("php <path> is a family shape without residual identity", !hasResidualIdentity("bash:php <path>"))
check("php -r <code:...> keeps residual identity", hasResidualIdentity("bash:php -r <code:abcdef12>"))

// --- D2: PHP/PHPUnit failure signatures ---
check("detectFailure: PHPUnit 'There was 1 failure:'", detectFailure("There was 1 failure:\n\n1) FooTest::testBar").matched)
check("detectFailure: PHPUnit 'There were 3 errors:'", detectFailure("There were 3 errors:\n\n1) FooTest::testBar").matched)
check("detectFailure: PHPUnit FAILURES! banner", detectFailure("FAILURES!").matched)
check("detectFailure: PHPUnit ERRORS! banner", detectFailure("ERRORS!").matched)
check("detectFailure: PHP 'Fatal error:'", detectFailure("Fatal error: Call to undefined function foo() in /var/www/index.php on line 42").matched)
check("detectFailure: 'PHP Parse error'", detectFailure("PHP Parse error:  syntax error, unexpected '}' in /var/www/index.php on line 10").matched)
check("detectFailure: 'PHP Fatal error'", detectFailure("PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted").matched)
check("detectFailure: PHP Warning is NOT a failure", !detectFailure("PHP Warning:  Undefined variable $x in /var/www/index.php on line 7").matched)
check("PHPUnit pass banner stays success-shaped", looksLikeSuccess("OK (12 tests, 30 assertions)"))

// --- D3: suggestCorrection families ---
function expectFamily(name: string, signature: string, token: string): void {
  const correction = suggestCorrection(signature, "exit code 1")
  check(`suggestCorrection routes ${name} to its family`, correction.includes(token))
  check(`suggestCorrection ${name} is not the snippet/generic fallback`, !correction.startsWith("Last error:") && !correction.includes("keeps failing"))
}

expectFamily("go", "bash:go test ./...", "Go build/test")
expectFamily("cargo", "bash:cargo test", "cargo/rustc")
expectFamily("maven/gradle (mvn)", "bash:mvn test", "Maven/Gradle")
expectFamily("maven/gradle (gradlew)", "bash:gradlew build", "Maven/Gradle")
expectFamily("dotnet", "bash:dotnet test", "dotnet build/test")
expectFamily("rspec", "bash:rspec <path>", "RSpec")
expectFamily("phpunit", "bash:phpunit <path>", "PHPUnit/PHP")
expectFamily("php", "bash:php <path>", "PHPUnit/PHP")
expectFamily("make", "bash:make <str>", "make/cmake")

check("suggestCorrection still routes pytest to the test-runner family", suggestCorrection("bash:pytest <path>", "exit code 1").includes("test is failing"))

// --- D4: diagnostic verbs (exit-1 immunity) ---
check("isIntendedNonzero: mvn test exit 1 is intended", isIntendedNonzero("mvn test", 1))
check("isIntendedNonzero: bare mvn exit 1 is NOT intended", !isIntendedNonzero("mvn", 1))
check("isIntendedNonzero: mvn compile exit 1 is NOT intended", !isIntendedNonzero("mvn compile", 1))
check("isIntendedNonzero: dotnet test exit 1 is intended", isIntendedNonzero("dotnet test", 1))
check("isIntendedNonzero: dotnet build exit 1 is NOT intended", !isIntendedNonzero("dotnet build", 1))
check("isIntendedNonzero: phpunit exit 1 is intended", isIntendedNonzero("phpunit tests/", 1))
check("isIntendedNonzero: rspec exit 1 is intended", isIntendedNonzero("rspec", 1))
check("isIntendedNonzero: rubocop exit 1 is intended", isIntendedNonzero("rubocop", 1))
check("isIntendedNonzero: swift test exit 1 is intended", isIntendedNonzero("swift test", 1))
check("isIntendedNonzero: swift build exit 1 is intended", isIntendedNonzero("swift build", 1))
check("isIntendedNonzero: cd x && mvn test exit 1 is intended", isIntendedNonzero("cd x && mvn test", 1))
check("isIntendedNonzero: mvn test exit 2 still counts", !isIntendedNonzero("mvn test", 2))

const wrapped = bashSegmentSignatures("cmd /c mvn test")
check("cmd /c unwrap reaches mvn test in segment signatures", wrapped.includes("bash:mvn test"))
check("cmd /c mvn test signature is remind-tier, never blocking", canRemind("bash", "bash:mvn test") && !canBlock("bash", "bash:mvn test"))

// --- D5: secret scrubber corpus (PAT-shaped positive + false-positive guards) ---
const MUST_REDACT: Array<[string, string]> = [
  ["aws configure set aws_secret_access_key wJalrXUtnFEMI/K7mdENG/bPxRfiCYEXAMPLEKEY", "aws space form"],
  ["aws_secret_access_key=wJalrXUtnFEMI/K7mdENG/bPxRfiCYEXAMPLEKEY", "aws compound lowercase"],
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7mdENG/bPxRfiCYEXAMPLEKEY", "aws compound uppercase"],
  ["export personal_access_token=ghp_16C7e42F292c6912E7710c838347Ae178B4a", "compound prefix"],
  ["--token=abc123def456ghi789jkl012", "flag value form"],
  ["--api-key=Zjk4NjMxYjctZmVmNy00Yzc0LTk0Zj", "dashed flag name"],
  ["curl -H \"Authorization: Bearer sk-proj-abc123def456ghi789jkl\" https://api", "bearer + sk-proj"],
  ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456", "bearer + jwt"],
  ["postgres://user:secretpw@db.example.com:5432/prod", "db conn string"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7d9J3fK8sL2m1\n-----END RSA PRIVATE KEY-----", "pem block"],
  ["default_secret_access_key=abcdefghijklmnopqrst", "prefixed compound"],
  ["api_key: Zjk4NjMxYjctZmVmNy00Yzc0LTk0Zj", "colon form"],
]
for (const [input, name] of MUST_REDACT) {
  const out = scrubSecrets(input)
  check(`scrubs ${name}`, !out.includes("wJalrXUtnFEMI") && !out.includes("ghp_16C7e") && !out.includes("sk-proj-abc123") && !out.includes("eyJhbGci") && !out.includes("secretpw") && !out.includes("MIIEowIB") && !out.includes("Zjk4NjMx") && !out.includes("abc123def456"))
}
const NOT_REDACT: Array<[string, string]> = [
  ["PATH=/usr/local/bin:/usr/bin", "plain env path"],
  ["tokenize=abcdefg123456789abcdefg", "token-like word"],
  ["keyboard=qwertyuiopasdfghjklzxcvbnm", "key-like word"],
  ["secrets_path=src/secrets/config.json", "path-valued config"],
  ["aws configure set region us-east-1", "aws region set"],
  ["mysql -u root -p production < dump.sql", "flag without value"],
]
for (const [input, name] of NOT_REDACT) {
  check(`keeps ${name} readable`, scrubSecrets(input) === input)
}
const continuation = "curl -H \"Authorization: Bearer sk-proj-\\\r\nabc123def456ghi789jkl\" https://api"
check("redacts the continuation body after sk-proj-\\", !scrubSecrets(continuation).includes("abc123def456"))
check("scrubSecrets is idempotent", scrubSecrets(scrubSecrets(continuation)) === scrubSecrets(continuation) && scrubSecrets(scrubSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7mdENG")) === scrubSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7mdENG"))

// --- D6: text-channel detection corpus (the only detector on exit-code-less harnesses) ---
const TEXT_FAILURES: Array<[string, string]> = [
  ["npm ERR! 404 Not Found - GET https://registry.npmjs.org/definitely-broken-xyz", "npm ERR! 404"],
  ["npm error code E404", "npm v10+ error form"],
  ["ERR_PNPM_NO_MATCHING_VERSION  No version with the requested range exists", "pnpm resolver"],
  ["error https://registry.yarnpkg.com/definitely-broken-xyz: Not found", "yarn fetch"],
  ["error Command failed with exit code 1", "yarn command failed"],
  ["FAILED tests/test_x.py::test_y - AssertionError: expected 1", "pytest short mode"],
  ["/bin/sh: 1: definitely-broken-xyz: not found", "debian dash"],
  ["/usr/bin/dash: 2: broken-tool: not found", "path-prefixed dash"],
  ["✖ 1 problem (1 error, 0 warnings)", "eslint problem tally"],
  ["  3:10  error  'x' is not defined  no-undef", "eslint inline row"],
  ["error • 'x' isn't defined • lib/a.dart:3:5", "flutter analyze"],
  ["Error from server (NotFound): deployments.apps \"broken\" not found", "kubectl"],
  ["Error response from daemon: manifest for broken:latest not found", "docker daemon"],
  ["go: module github.com/broken/mod: no such module", "go mod"],
  ["NU1101: Unable to find package broken-package", "nuget restore"],
]
for (const [line, name] of TEXT_FAILURES) {
  check(`detects ${name}`, detectFailure(line).matched)
}
check("detects a bare exit-code line", detectFailure("compiling...\nexit code 1").matched)
const NOT_FAILURES: Array<[string, string]> = [
  ["npm warn deprecated left-pad@1.3.0: use fpkg", "npm warn"],
  ["10:30 session started", "time-prefixed line"],
  ["go: downloading github.com/x/y v1.2.3", "go download"],
  ["✖ 0 problems (0 errors, 0 warnings)", "eslint clean tally"],
]
for (const [line, name] of NOT_FAILURES) {
  check(`ignores ${name}`, !detectFailure(line).matched)
}

report()
