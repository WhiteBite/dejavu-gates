/** Marker-block writers: byte-identical no-op on unchanged content, caller-owned i18n, no message strings in the kit. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`writeMarkerBlock: opts.${name} is required`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCurrent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeShellBlock(path, block, opts) {
  requireString(opts.id, 'id');
  const escaped = escapeRegExp(opts.id);
  const pattern = new RegExp(`# >>> ${escaped} >>>[\\s\\S]*?# <<< ${escaped} <<<\\r?\\n?`);
  const shebang = typeof opts.shebang === 'string' ? opts.shebang : '#!/bin/sh\n';
  const current = readCurrent(path);
  let action;
  let next;
  if (current === null) {
    next = `${shebang}${block}`;
    action = 'created';
  } else if (pattern.test(current)) {
    next = current.replace(pattern, block);
    action = 'replaced';
  } else {
    next = current.replace(/\n?$/, '\n') + block;
    action = 'appended';
  }
  if (current !== null && next === current) return { action: 'unchanged' };
  write(path, next);
  if (opts.executable !== false && process.platform !== 'win32') chmodSync(path, 0o755);
  return { action };
}

function writeHtmlBlock(path, block, opts) {
  requireString(opts.id, 'id');
  const open = `<!-- >>> ${opts.id} >>> -->`;
  const close = `<!-- <<< ${opts.id} <<< -->`;
  const current = readCurrent(path);
  let action;
  let next;
  if (current === null) {
    next = block.endsWith('\n') ? block : `${block}\n`;
    action = 'created';
  } else {
    const openIdx = current.indexOf(open);
    const closeIdx = current.indexOf(close);
    if (openIdx !== -1 && closeIdx > openIdx) {
      next = current.slice(0, openIdx) + block.trimEnd() + current.slice(closeIdx + close.length);
      action = 'replaced';
    } else {
      next = current.replace(/\n*$/, '\n\n') + block;
      action = 'appended';
    }
    if (next === current) return { action: 'unchanged' };
  }
  write(path, next);
  return { action };
}

function writeFirstLineMarker(path, content, opts) {
  requireString(opts.marker, 'marker');
  const current = readCurrent(path);
  if (current === null) {
    write(path, content);
    return { action: 'created' };
  }
  if (current.split('\n')[0] !== opts.marker) return { action: 'skipped-foreign' };
  if (current === content) return { action: 'unchanged' };
  write(path, content);
  return { action: 'replaced' };
}

function writeMdcFrontmatter(path, opts) {
  if (!Array.isArray(opts.fields)) throw new Error('writeMarkerBlock: opts.fields must be an array');
  if (typeof opts.body !== 'string') throw new Error('writeMarkerBlock: opts.body is required');
  const frontmatter = opts.fields.map(([key, value]) => `${key}: ${value}\n`).join('');
  const next = `---\n${frontmatter}---\n\n${opts.body}`;
  const current = readCurrent(path);
  if (current === next) return { action: 'unchanged' };
  write(path, next);
  return { action: current === null ? 'created' : 'replaced' };
}

/** `block` is the full caller-assembled text for shell/html/first-line variants; mdc-frontmatter builds its own bytes from fields + body. */
export function writeMarkerBlock(path, block, opts = {}) {
  switch (opts.variant) {
    case 'shell-block':
      return writeShellBlock(path, block, opts);
    case 'html-block':
      return writeHtmlBlock(path, block, opts);
    case 'first-line-marker':
      return writeFirstLineMarker(path, block, opts);
    case 'mdc-frontmatter':
      return writeMdcFrontmatter(path, opts);
    default:
      throw new Error(`writeMarkerBlock: unknown variant ${JSON.stringify(opts.variant)}`);
  }
}