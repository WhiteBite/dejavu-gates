#!/usr/bin/env node
// npm bin shim: node is guaranteed (npm/npx runs it), the payload is raw TS, so we hand off to bun.
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const child = spawn("bun", [join(root, "src", "main.ts"), ...process.argv.slice(2)], { stdio: "inherit" })

let spawnFailed = false
child.on("error", (error) => {
  spawnFailed = true
  const message =
    error && error.code === "ENOENT"
      ? "dejavu-gates requires Bun on PATH (https://bun.sh) — hook handlers run raw TypeScript"
      : `dejavu-gates launcher failed: ${error && error.message ? error.message : error}`
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
child.on("exit", (code) => {
  if (!spawnFailed) process.exitCode = code === null ? 1 : code
})
