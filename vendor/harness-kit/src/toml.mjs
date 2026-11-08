const BOM = '\uFEFF';

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      lines.push({ start, end: i + 1 });
      start = i + 1;
    } else if (ch === '\r') {
      const end = text[i + 1] === '\n' ? i + 2 : i + 1;
      lines.push({ start, end });
      start = end;
      if (end === i + 2) i += 1;
    }
  }
  if (start < text.length) lines.push({ start, end: text.length });
  return lines;
}

function unquoteKeySegment(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`toml: invalid quoted key segment ${s}`);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`toml: invalid key segment ${JSON.stringify(raw)}`);
  return s;
}

function parseKeyPath(input) {
  const segments = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      const close = input.indexOf(ch, i + 1);
      if (close === -1) throw new Error(`toml: unterminated quoted key ${input.slice(i)}`);
      segments.push(unquoteKeySegment(input.slice(i, close + 1)));
      i = close + 1;
    } else {
      let j = i;
      while (j < input.length && input[j] !== '.' && !/\s/.test(input[j])) j += 1;
      segments.push(unquoteKeySegment(input.slice(i, j)));
      i = j;
    }
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i < input.length) {
      if (input[i] !== '.') throw new Error(`toml: malformed key path ${JSON.stringify(input)}`);
      i += 1;
    }
  }
  if (segments.length === 0) throw new Error(`toml: empty key path ${JSON.stringify(input)}`);
  return segments;
}

function skipString(line, i) {
  const ch = line[i];
  if (line.startsWith(ch.repeat(3), i)) return -1;
  let j = i + 1;
  while (j < line.length) {
    if (ch === '"' && line[j] === '\\') {
      j += 2;
      continue;
    }
    if (line[j] === ch) return j + 1;
    j += 1;
  }
  return -1;
}

function parseHeaderPath(line) {
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  const isArrayOfTables = line[i] === '[' && line[i + 1] === '[';
  i += isArrayOfTables ? 2 : 1;
  let close = -1;
  let j = i;
  while (j < line.length) {
    const ch = line[j];
    if (ch === '"' || ch === "'") {
      const skip = skipString(line, j);
      if (skip === -1) throw new Error(`toml: unterminated quoted key in header ${JSON.stringify(line.trim())}`);
      j = skip;
      continue;
    }
    if (isArrayOfTables ? line.startsWith(']]', j) : ch === ']') {
      close = j;
      break;
    }
    j += 1;
  }
  if (close === -1) throw new Error(`toml: unterminated table header ${JSON.stringify(line.trim())}`);
  const after = line.slice(close + (isArrayOfTables ? 2 : 1));
  const rest = after.replace(/[\r\n]+$/, '').trim();
  if (rest !== '' && !rest.startsWith('#')) throw new Error(`toml: trailing content after table header ${JSON.stringify(line.trim())}`);
  return { path: parseKeyPath(line.slice(i, close)), isArrayOfTables };
}

function findTopLevelEquals(line) {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') return -1;
    if (ch === '"' || ch === "'") {
      const skip = skipString(line, i);
      if (skip === -1) return -1;
      i = skip;
      continue;
    }
    if (ch === '=') return i;
    i += 1;
  }
  return -1;
}

function keyPathOfLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = findTopLevelEquals(trimmed);
  if (eq === -1) return null;
  try {
    return parseKeyPath(trimmed.slice(0, eq));
  } catch {
    return null;
  }
}

function analyze(text) {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const offset = text.length - body.length;
  const lines = splitLines(body);
  const tables = [];
  const rootKeys = [];
  let mlDelim = null;
  let arrayDepth = 0;

  for (const { start, end } of lines) {
    const line = body.slice(start, end);
    const cleanStart = mlDelim === null && arrayDepth === 0;
    if (cleanStart && /^\s*\[\[?/.test(line)) {
      const { path, isArrayOfTables } = parseHeaderPath(line);
      if (tables.length > 0) tables[tables.length - 1].blockEnd = offset + start;
      tables.push({ path, isArrayOfTables, headerStart: offset + start, blockStart: offset + start, blockEnd: text.length, bodyLines: [], keys: [] });
      continue;
    }
    if (tables.length > 0) {
      const table = tables[tables.length - 1];
      table.bodyLines.push(line);
      if (cleanStart) {
        const path = keyPathOfLine(line);
        if (path !== null) table.keys.push(path);
      }
    } else if (cleanStart) {
      rootKeys.push(line);
    }

    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (mlDelim !== null) {
        if (mlDelim === '"""' && ch === '\\') {
          i += 2;
          continue;
        }
        if (line.startsWith(mlDelim, i)) {
          mlDelim = null;
          i += 3;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        if (line.startsWith(ch.repeat(3), i)) {
          mlDelim = ch.repeat(3);
          i += 3;
          continue;
        }
        const skip = skipString(line, i);
        if (skip === -1) throw new Error('toml: unterminated string');
        i = skip;
        continue;
      }
      if (ch === '[') arrayDepth += 1;
      else if (ch === ']' && arrayDepth > 0) arrayDepth -= 1;
      i += 1;
    }
  }

  if (mlDelim !== null) throw new Error('toml: unterminated multi-line string');
  return { tables, rootKeys, arrayDepth };
}

export function scanTomlTables(text) {
  return analyze(text).tables.map(({ path, headerStart, blockStart, blockEnd }) => ({ path, headerStart, blockStart, blockEnd }));
}

function hasForeignKeys(table) {
  return table.bodyLines.some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

function escapeTomlString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

function serializeTomlValue(value) {
  if (typeof value === 'string') return escapeTomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeTomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${isBareKey(k) ? k : escapeTomlString(k)} = ${serializeTomlValue(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  throw new Error(`toml: cannot serialize value of type ${typeof value}`);
}

function isBareKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

function renderBlocks(container, template, eol) {
  let out = '';
  for (const [name, fields] of Object.entries(template)) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error(`toml: template entry ${JSON.stringify(name)} must be a table of key/value lines`);
    }
    out += `[${container}.${isBareKey(name) ? name : escapeTomlString(name)}]${eol}`;
    for (const [field, value] of Object.entries(fields)) {
      out += `${isBareKey(field) ? field : escapeTomlString(field)} = ${serializeTomlValue(value)}${eol}`;
    }
    out += eol;
  }
  return out;
}

/** isMine(name, value): for TOML the value argument is always undefined - the sub-table name is the identity. */
export function mergeTomlTable(text, template, { container, isMine } = {}) {
  if (typeof text !== 'string') throw new Error('mergeTomlTable requires the config text');
  if (typeof container !== 'string' || container === '') throw new Error('mergeTomlTable requires a container');
  if (typeof isMine !== 'function') throw new Error('mergeTomlTable requires an isMine(name) predicate');
  const additions = template && typeof template === 'object' && !Array.isArray(template) ? template : {};

  const { tables, rootKeys, arrayDepth } = analyze(text);
  if (arrayDepth > 0) throw new Error('toml: unterminated multi-line array');

  for (const line of rootKeys) {
    const path = keyPathOfLine(line);
    if (path === null || path[0] !== container) continue;
    if (path.length > 1) throw new Error(`toml: dotted-key definition of ${container} is not supported - use [${container}.NAME] tables`);
    const value = line.trim().slice(findTopLevelEquals(line.trim()) + 1).trim();
    if (value.startsWith('{')) throw new Error(`toml: inline table for ${container} is not supported - use [${container}.NAME] tables`);
    throw new Error(`toml: ${container} is not a server map - wrong container for this config file?`);
  }

  const ownedNames = new Set();
  const seen = new Set();
  let baseTable = null;
  let lastContainerEnd = -1;
  let foreignSubRemains = false;
  for (const table of tables) {
    if (table.path[0] !== container) continue;
    if (table.isArrayOfTables) throw new Error(`toml: [[${table.path.join('.')}]] array-of-tables for ${container} is not supported`);
    lastContainerEnd = table.blockEnd;
    if (table.path.length === 1) {
      if (baseTable !== null) throw new Error(`toml: duplicate [${container}] table`);
      baseTable = table;
      continue;
    }
    const name = table.path[1];
    const key = table.path.join('\u0000');
    if (seen.has(key)) throw new Error(`toml: duplicate [${table.path.join('.')}] sub-table`);
    seen.add(key);
    if (isMine(name, undefined)) ownedNames.add(name);
    else foreignSubRemains = true;
  }

  if (baseTable !== null && baseTable.keys.some((path) => path.length > 1)) {
    throw new Error(`toml: dotted-key definition of ${container} is not supported - use [${container}.NAME] tables`);
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = renderBlocks(container, additions, eol);

  if (lastContainerEnd === -1) {
    if (rendered === '') return { text, changed: false };
    let prefix = text;
    let glue = '';
    if (prefix !== '' && !prefix.endsWith(eol)) {
      prefix += eol;
      glue = eol;
    }
    if (prefix !== '' && !prefix.endsWith(eol + eol)) glue = eol;
    return { text: prefix + glue + rendered, changed: true };
  }

  const dropBase = baseTable !== null && ownedNames.size > 0 && !hasForeignKeys(baseTable) && !foreignSubRemains;
  const edits = [];
  for (const table of tables) {
    if (table.path[0] !== container) continue;
    if (table.path.length > 1 && ownedNames.has(table.path[1])) {
      edits.push({ start: table.blockStart, end: table.blockEnd, replacement: '' });
    } else if (table.path.length === 1 && dropBase) {
      edits.push({ start: table.blockStart, end: table.blockEnd, replacement: '' });
    }
  }
  if (rendered !== '') edits.push({ start: lastContainerEnd, end: lastContainerEnd, replacement: rendered });
  edits.sort((a, b) => a.start - b.start || a.end - b.end);

  let next = '';
  let pos = 0;
  for (const edit of edits) {
    next += text.slice(pos, edit.start) + edit.replacement;
    pos = edit.end;
  }
  next += text.slice(pos);
  return { text: next, changed: next !== text };
}
