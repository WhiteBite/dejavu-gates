/** Owner-scoped hook-config merge: strip only the caller's entries, append fresh ones, preserve every foreign byte. */

export function entryCommands(entry) {
  const commands = [];
  if (!entry || typeof entry !== 'object') return commands;
  if (typeof entry.command === 'string') commands.push(entry.command);
  if (entry.action && typeof entry.action.command === 'string') commands.push(entry.action.command);
  if (Array.isArray(entry.hooks)) {
    for (const leaf of entry.hooks) {
      if (leaf && typeof leaf === 'object' && typeof leaf.command === 'string') commands.push(leaf.command);
    }
  }
  return commands;
}

function isOwnEntry(entry, isMine) {
  const commands = entryCommands(entry);
  return commands.length > 0 && commands.every((command) => isMine(command));
}

function stripGroups(entries, isMine) {
  const kept = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      kept.push(entry);
      continue;
    }
    if (Array.isArray(entry.hooks)) {
      const inner = entry.hooks.filter((leaf) => !(leaf && typeof leaf === 'object' && typeof leaf.command === 'string' && isMine(leaf.command)));
      if (inner.length === entry.hooks.length) kept.push(entry);
      else if (inner.length > 0) kept.push({ ...entry, hooks: inner });
      continue;
    }
    if (typeof entry.command === 'string') {
      if (!isMine(entry.command)) kept.push(entry);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

function stripLeaves(entries, isMine) {
  return entries.filter((entry) => !isOwnEntry(entry, isMine));
}

function eventMapOf(value, where) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} is not an event map - wrong shape descriptor for this config file?`);
  }
  return value;
}

function mergeHooksArray(existing, template, isMine) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(template)) {
    if (key === 'hooks') continue;
    if (!(key in merged)) merged[key] = value;
  }
  const current = merged.hooks;
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error('config .hooks is not an array - wrong shape descriptor for this config file?');
  }
  const stripped = (Array.isArray(current) ? current : []).filter((entry) => !isOwnEntry(entry, isMine));
  const additions = Array.isArray(template.hooks) ? template.hooks : [];
  merged.hooks = [...stripped, ...additions];
  return merged;
}

/**
 * Merges a template into an existing config for one registry shape. Own entries
 * are stripped from EVERY event (so an empty template uninstalls), then the
 * template entries are appended. Foreign entries and unknown top-level keys
 * survive untouched; running the same merge twice is byte-identical.
 */
export function mergeHooks(existing, template, { shape, isMine }) {
  if (typeof isMine !== 'function') throw new Error('mergeHooks requires an isMine(command) predicate');
  if (shape === 'hooks-array') return mergeHooksArray(existing, template, isMine);

  const rootScoped = shape === 'root-events';
  const grouped = shape === 'nested-hooks' || shape === 'root-events';
  const merged = { ...existing };

  if (!rootScoped) {
    for (const [key, value] of Object.entries(template)) {
      if (key === 'hooks') continue;
      if (!(key in merged)) merged[key] = value;
    }
  }

  const container = rootScoped
    ? merged
    : (() => {
        const hooks = eventMapOf(merged.hooks, 'config .hooks');
        merged.hooks = { ...hooks };
        return merged.hooks;
      })();

  for (const [event, entries] of Object.entries(container)) {
    if (!rootScoped && event === 'hooks') continue;
    if (!Array.isArray(entries)) continue;
    const stripped = grouped ? stripGroups(entries, isMine) : stripLeaves(entries, isMine);
    if (stripped.length === 0) delete container[event];
    else container[event] = stripped;
  }

  const templateEvents = rootScoped ? template : eventMapOf(template.hooks, 'template .hooks');
  for (const [event, entries] of Object.entries(templateEvents)) {
    if (!rootScoped && event === 'hooks') continue;
    if (!Array.isArray(entries)) continue;
    // foreign non-array event value: keep verbatim, skip template entries for it
    if (event in container && !Array.isArray(container[event])) continue;
    const current = Array.isArray(container[event]) ? container[event] : [];
    const appended = [...current, ...entries];
    if (appended.length === 0) delete container[event];
    else container[event] = appended;
  }

  return merged;
}
