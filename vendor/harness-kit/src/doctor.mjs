/** Install-health aggregation over explicit surfaces (hook-config drift, marker-block rot) plus the git core.hooksPath resolver. Facts only. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigParseError, readJsonConfig } from './atomic.mjs';
import { checkDrift, extractCliPath } from './drift.mjs';
import { readMarkerBlock } from './marker.mjs';

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function resolveHooksDir(root, { exec } = {}) {
  if (!existsSync(join(root, '.git'))) return null;
  const fallback = join(root, '.git', 'hooks');
  const run = exec ?? runGit;
  try {
    const configured = run(['config', 'core.hooksPath'], root).trim();
    return configured === '' ? fallback : resolve(root, configured);
  } catch {
    return fallback;
  }
}

function finding(id, status, detail) {
  return { surface: id, status, detail };
}

function checkHookConfigSurface(surface, path, pathExists) {
  let input;
  try {
    input = { config: readJsonConfig(path) };
  } catch (error) {
    if (!(error instanceof ConfigParseError)) throw error;
    input = { parseError: true };
  }
  const result = checkDrift(input, {
    shape: surface.shape,
    identify: surface.identify,
    pathExists,
    extract: surface.extract,
  });
  return finding(surface.id, result.status, result.detail);
}

function checkMarkerSurface(surface, path, pathExists) {
  let content;
  try {
    content = existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return finding(surface.id, 'broken', null);
  }
  if (content === null) return finding(surface.id, 'missing', null);
  const block = readMarkerBlock(content, { variant: surface.variant, id: surface.markerId });
  if (!block.present) return finding(surface.id, 'missing', null);
  const extract = surface.extract ?? extractCliPath;
  const cliPath = extract(block.text);
  if (typeof cliPath !== 'string' || cliPath === '') return finding(surface.id, 'stale', null);
  if (pathExists(cliPath) === false) return finding(surface.id, 'stale', cliPath);
  return finding(surface.id, 'ok', null);
}

export function checkInstall(root, { surfaces = [], pathExists = existsSync } = {}) {
  const findings = [];
  for (const surface of surfaces) {
    const path = isAbsolute(surface.path) ? surface.path : join(root, surface.path);
    if (surface.kind === 'hook-config') findings.push(checkHookConfigSurface(surface, path, pathExists));
    else if (surface.kind === 'marker-block') findings.push(checkMarkerSurface(surface, path, pathExists));
    else findings.push(finding(surface.id, 'broken', null));
  }
  return findings;
}
