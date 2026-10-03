/** Drift classification for installed hook commands: broken config, missing hooks, or a rotted cli path. Returns facts only. */
import { entryCommands } from './merge.mjs';

export function extractCliPath(command, matcher) {
  if (typeof command !== 'string') return null;
  if (matcher !== undefined) {
    const match = command.match(matcher);
    if (match === null) return null;
    return match[1] ?? match[0];
  }
  const quoted = command.match(/"([^"]+\.ts)"/);
  if (quoted !== null) return quoted[1];
  const bare = command.match(/[^\s"]+\.ts/);
  return bare === null ? null : bare[0];
}

export function collectCommands(config, { shape } = {}) {
  const commands = [];
  const walk = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      for (const command of entryCommands(entry)) commands.push(command);
    }
  };
  if (!config || typeof config !== 'object') return commands;
  if (shape === 'hooks-array') {
    walk(config.hooks);
    return commands;
  }
  if (shape === 'root-events') {
    for (const entries of Object.values(config)) walk(entries);
    return commands;
  }
  const hooks = config.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const entries of Object.values(hooks)) walk(entries);
  }
  return commands;
}

export function checkDrift(input, opts) {
  if (!input || input.parseError === true) return { status: 'broken', detail: null };
  const { shape, identify, pathExists, extract = extractCliPath } = opts;
  const config = input.config;
  if (config === undefined || config === null) return { status: 'missing', detail: null };
  const matched = collectCommands(config, { shape }).filter((command) => identify(command));
  if (matched.length === 0) return { status: 'missing', detail: null };
  for (const command of matched) {
    const cliPath = extract(command);
    if (cliPath === null) return { status: 'stale', detail: null };
    if (pathExists(cliPath) === false) return { status: 'stale', detail: cliPath };
  }
  return { status: 'ok', detail: null };
}