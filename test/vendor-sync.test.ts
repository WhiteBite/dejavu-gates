/** Vendored harness-kit integrity: every file must match the sha256 recorded in the vendored manifest (LF-normalized). Run: bun test */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "bun:test"

const vendorRoot = join(fileURLToPath(new URL("..", import.meta.url)), "vendor", "harness-kit")
const manifest = JSON.parse(readFileSync(join(vendorRoot, "manifest.json"), "utf8")) as { kitVersion: string; files: Record<string, string> }

test(`vendored harness-kit ${manifest.kitVersion} matches manifest sha256`, () => {
  for (const [rel, sha] of Object.entries(manifest.files)) {
    const content = readFileSync(join(vendorRoot, rel), "utf8").replace(/\r\n/g, "\n")
    const actual = createHash("sha256").update(content).digest("hex")
    if (actual !== sha) throw new Error(`vendored file drifted from harness-kit ${manifest.kitVersion}: ${rel}`)
  }
})
