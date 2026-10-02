/** Ownership sidecar: precise entry identity by locator + content hash, so merges never depend on command-string guessing alone. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonConfig, writeJsonAtomic } from './atomic.mjs';

export const SIDECAR_DIR = '.harness-kit';
export const SIDECAR_FILE = 'ownership.json';

export function sidecarPath(root) {
  return join(root, SIDECAR_DIR, SIDECAR_FILE);
}

/** Key-sorted compact JSON so the same logical entry hashes identically everywhere. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Walks string keys and numeric array indices; undefined when any segment misses. */
export function resolveLocator(root, locator) {
  let current = root;
  for (const segment of locator) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? current[segment] : undefined;
    } else if (typeof current === 'object') {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function readOwnership(root) {
  const data = readJsonConfig(sidecarPath(root));
  if (data === null) return { version: 1, entries: [] };
  const entries = Array.isArray(data.entries) ? data.entries.filter((entry) => entry && typeof entry === 'object') : [];
  return { version: typeof data.version === 'number' ? data.version : 1, entries };
}

/** Replaces the (owner, file) records with fresh hashes resolved from the live config; other owners' records survive. */
export function recordOwnership(root, owner, file, config, locators) {
  const sidecar = readOwnership(root);
  const fresh = locators.map((locator) => {
    const value = resolveLocator(config, locator);
    if (value === undefined) throw new Error(`locator does not resolve in ${file}: ${JSON.stringify(locator)}`);
    return { owner, file, locator, sha256: hashValue(value) };
  });
  const kept = sidecar.entries.filter((entry) => !(entry.owner === owner && entry.file === file));
  writeJsonAtomic(sidecarPath(root), { version: 1, entries: [...kept, ...fresh] });
}

export function ownedLocators(root, owner, file) {
  return readOwnership(root).entries.filter((entry) => entry.owner === owner && (file === undefined || entry.file === file));
}

export function entryMatchesHash(config, record) {
  const value = resolveLocator(config, record.locator);
  if (value === undefined) return false;
  return hashValue(value) === record.sha256;
}
