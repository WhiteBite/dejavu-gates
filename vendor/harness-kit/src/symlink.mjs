/** Skill-directory linking with state classification: never clobbers manual content or foreign links. Ported from rdk skill.js with Windows junction-path normalization added. */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function normalizeLinkTarget(raw) {
  const value = String(raw);
  // Windows junctions report targets with the extended-length prefix; strip it before comparing
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** absent | linked (ours) | foreign-link (points elsewhere) | manual (real directory or file). */
export function linkState(target, source) {
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) {
    let dest = null;
    try {
      dest = resolve(dirname(target), normalizeLinkTarget(readlinkSync(target)));
    } catch {
      dest = null;
    }
    return dest !== null && samePath(dest, source) ? 'linked' : 'foreign-link';
  }
  return 'manual';
}

export function linkDir(source, target) {
  const state = linkState(target, source);
  if (state === 'linked') return { state, ok: true, action: 'already-linked' };
  if (state === 'manual' || state === 'foreign-link') {
    return { state, ok: false, action: `skipped (${state} content present at ${target})` };
  }
  const parent = dirname(target);
  if (!existsSync(parent)) {
    if (!existsSync(dirname(parent))) return { state, ok: false, action: 'skipped (harness not installed)' };
    mkdirSync(parent, { recursive: true });
  }
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return { state: 'linked', ok: true, action: 'linked' };
}

export function unlinkDir(source, target) {
  const state = linkState(target, source);
  if (state === 'absent') return { state, ok: true, action: 'already-absent' };
  if (state !== 'linked') return { state, ok: false, action: `skipped (${state})` };
  rmSync(target, { recursive: true, force: true });
  return { state: 'absent', ok: true, action: 'removed' };
}
