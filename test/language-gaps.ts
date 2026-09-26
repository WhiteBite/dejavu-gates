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
  suggestCorrection,
} from "../src/patterns"

let failures = 0
function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`ok   - ${name}`)
  } else {
    failures += 1
    console.error(`FAIL - ${name}`)
  }
}

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

const pyMod = normalizeCommand("python -m http.server")
check("python -m keeps the module name visible", pyMod.includes("http.server"))
check("python -m keeps residual identity", hasResidualIdentity(`bash:${pyMod}`))

const phpSecret = normalizeCommand(`php -r "echo 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXyz0123456789';"`)
check("php -r payload secret never reaches the signature", !phpSecret.includes("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXyz0123456789") && phpSecret.includes("<code:"))

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
