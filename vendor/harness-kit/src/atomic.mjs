/** Atomic JSON config writes: validate before touching disk, rotate the backup only after the new content parses, refuse symlinks, retry locked renames on Windows. */
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export class ConfigParseError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'ConfigParseError';
    this.path = path;
  }
}

/** Absent file reads as null; a malformed or non-object file aborts instead of being clobbered. */
export function readJsonConfig(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigParseError(`existing config is not valid JSON: ${path} - aborting, file left untouched`, path);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError(`existing config is not a JSON object: ${path} - aborting, file left untouched`, path);
  }
  return parsed;
}

const RENAME_RETRIES = 5;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  // zero-dep synchronous sleep: Atomics.wait is allowed on the Node main thread
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJsonAtomic(path, data) {
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${path}`);
  }
  const serialized = `${JSON.stringify(data, null, 2).replace(/\r\n/g, '\n')}\n`;
  JSON.parse(serialized);
  mkdirSync(dirname(path), { recursive: true });
  if (stat) {
    copyFileSync(path, `${path}.bak`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, serialized, 'utf8');
  let renamed = false;
  for (let attempt = 0; attempt < RENAME_RETRIES && !renamed; attempt += 1) {
    try {
      renameSync(tmp, path);
      renamed = true;
    } catch (error) {
      const retryable = RENAME_RETRY_CODES.has(error && error.code) && process.platform === 'win32';
      if (!retryable || attempt === RENAME_RETRIES - 1) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
  if (stat && process.platform !== 'win32') {
    try { chmodSync(path, stat.mode & 0o7777); } catch { /* mode preservation is best effort */ }
  }
  JSON.parse(readFileSync(path, 'utf8'));
}
