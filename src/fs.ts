/**
 * Engine-layer fs primitives shared by the store and the installer: NT
 * long-path prefixing and atomic tmp+rename writes with Windows
 * AV/indexer-lock backoff. Leaf module — node: builtins only.
 */
import { rename, unlink, writeFile } from "node:fs/promises"

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
