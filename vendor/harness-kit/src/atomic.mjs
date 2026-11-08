/** Atomic JSON config writes: validate before touching disk, skip byte-identical rewrites, optional retained backup, refuse symlinks, retry locked renames on Windows. */
import { randomBytes } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

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

/** Refuses a write if any existing component of the path (parent dirs or the file itself) is a symlink, so a write cannot be redirected outside the target tree. */
export function assertNoSymlinkComponents(target) {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to write through a symlinked path component: ${current}`);
  }
}

/** Writes `text` verbatim: no EOL or formatting normalization, so a comment-preserving editor's bytes reach disk unchanged. */
export function writeTextAtomic(path, text, { backup = true, validate } = {}) {
  if (typeof validate === 'function') validate(text);
  assertNoSymlinkComponents(path);
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat !== null && readFileSync(path, 'utf8') === text) return;
  mkdirSync(dirname(path), { recursive: true });
  if (stat && backup) {
    copyFileSync(path, `${path}.harness-kit.bak`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, 'utf8');
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
}

export function writeJsonAtomic(path, data, { backup = true } = {}) {
  const serialized = `${JSON.stringify(data, null, 2).replace(/\r\n/g, '\n')}\n`;
  writeTextAtomic(path, serialized, { backup, validate: (text) => JSON.parse(text) });
  JSON.parse(readFileSync(path, 'utf8'));
}
