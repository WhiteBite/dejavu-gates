/**
 * Engine-layer fs primitives shared by the store and the installer: NT
 * long-path prefixing and atomic tmp+rename writes with Windows
 * AV/indexer-lock backoff. Leaf module — node: builtins only.
 */
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** NT long-path prefix so deeply nested project dirs do not hit MAX_PATH. */
export function ntPath(p: string): string {
  if (process.platform !== "win32") return p
  if (p.startsWith("\\\\?\\")) return p
  return `\\\\?\\${p}`
}

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])

/** tmp + rename with exponential-backoff retry (Windows AV/indexer locks). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(ntPath(tmp), content, "utf8")
      await rename(ntPath(tmp), ntPath(path))
      return
    } catch (error) {
      const code = (error as { code?: string }).code ?? ""
      if (RETRYABLE.has(code) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
        continue
      }
      try {
        await unlink(ntPath(tmp))
      } catch {
        // orphan tmp is harmless
      }
      throw error
    }
  }
}

// --- store-artifact sweep (doctor --repair) -----------------------------------

export const TMP_ORPHAN_MS = 60 * 60 * 1000
export const CORRUPT_DEFAULT_DAYS = 30

/** ESRCH = dead; EPERM/anything else = alive but not signalable — never remove such a lock. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH"
  }
}

export interface SweepResult {
  tmp: number
  locks: number
  corrupt: number
}

/** Best-effort removal of transient store artifacts: orphaned atomicWrite
 * tmp files (past tmpOrphanMs or with a dead embedded pid), stale lockfiles
 * (holder pid dead — a live holder's lock is never touched), and — only when
 * pruneCorrupt is set — quarantine artifacts past corruptMaxAgeMs. Individual
 * file errors are swallowed; unreadable locks are left alone. */
export async function sweepStoreArtifacts(
  dir: string,
  opts: { tmpOrphanMs: number; corruptMaxAgeMs: number; pruneCorrupt: boolean },
): Promise<SweepResult> {
  const result: SweepResult = { tmp: 0, locks: 0, corrupt: 0 }
  let names: string[]
  try {
    names = await readdir(ntPath(dir))
  } catch {
    // no store dir yet — nothing to sweep
    return result
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (name.endsWith(".tmp")) {
        const pidText = /\.(\d+)\.tmp$/.exec(name)?.[1]
        if (pidText === undefined) continue
        const age = Date.now() - (await stat(ntPath(path))).mtimeMs
        if (age > opts.tmpOrphanMs || !pidAlive(Number(pidText))) {
          await unlink(ntPath(path))
          result.tmp++
        }
      } else if (name.endsWith(".lock")) {
        const pid = Number((await readFile(ntPath(path), "utf8")).trim())
        if (!pidAlive(pid)) {
          await unlink(ntPath(path))
          result.locks++
        }
      } else if (opts.pruneCorrupt && name.includes(".corrupt")) {
        const age = Date.now() - (await stat(ntPath(path))).mtimeMs
        if (age > opts.corruptMaxAgeMs) {
          await unlink(ntPath(path))
          result.corrupt++
        }
      }
    } catch {
      // per-file best effort: unreadable/vanished files are left alone
    }
  }
  return result
}
