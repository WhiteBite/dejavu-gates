/** Deterministic manifest primitives shared by the CLI, the manifest script and the tests: EOL-normalized sha256 per vendored file. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const VENDORED_DIRS = ['src', 'registry', 'types'];
export const MANIFEST_FILE = 'manifest.json';

export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

export function hashFile(path) {
  return createHash('sha256').update(normalizeEol(readFileSync(path, 'utf8'))).digest('hex');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function computeManifest(root) {
  const files = {};
  for (const dir of VENDORED_DIRS) {
    let entries = [];
    try {
      entries = walk(join(root, dir), []);
    } catch {
      continue;
    }
    for (const file of entries) {
      files[relative(root, file).split('\\').join('/')] = hashFile(file);
    }
  }
  return files;
}

export function readManifest(root) {
  return JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
}
