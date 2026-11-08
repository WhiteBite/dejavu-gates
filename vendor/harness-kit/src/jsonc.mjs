const BOM = '\uFEFF';
const WS = /\s/;
const PUNCT = new Set(['{', '}', '[', ']', ',', ':']);

function isSignificant(token) {
  return token.type !== 'ws' && token.type !== 'comment';
}

export function scanJsonc(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === BOM || WS.test(ch)) {
      const start = i;
      while (i < n && (text[i] === BOM || WS.test(text[i]))) i += 1;
      tokens.push({ type: 'ws', start, end: i });
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1;
      tokens.push({ type: 'comment', start, end: i });
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i >= n) throw new Error('jsonc: unterminated block comment');
      i += 2;
      tokens.push({ type: 'comment', start, end: i });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new Error('jsonc: unterminated string');
      tokens.push({ type: 'string', start, end: i });
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && !WS.test(text[i]) && !PUNCT.has(text[i]) && text[i] !== '"') {
      if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break;
      i += 1;
    }
    if (i === start) throw new Error(`jsonc: unexpected character ${JSON.stringify(ch)}`);
    tokens.push({ type: 'literal', start, end: i });
  }
  return tokens;
}

export function parseJsonc(text) {
  const tokens = scanJsonc(text);
  let out = '';
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.type === 'comment') continue;
    if (token.type === 'punct' && text[token.start] === ',') {
      let next = k + 1;
      while (next < tokens.length && !isSignificant(tokens[next])) next += 1;
      const after = tokens[next];
      if (after && after.type === 'punct' && (text[after.start] === '}' || text[after.start] === ']')) continue;
    }
    out += text.slice(token.start, token.end);
  }
  return JSON.parse(out.replace(new RegExp(`^${BOM}`), ''));
}

function findValueEnd(tokens, text, startIndex) {
  const first = tokens[startIndex];
  const openChar = text[first.start];
  if (openChar !== '{' && openChar !== '[') return { end: first.end, after: startIndex + 1 };
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let k = startIndex; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.type !== 'punct') continue;
    const c = text[token.start];
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return { end: token.end, after: k + 1 };
    }
  }
  throw new Error('jsonc: unterminated composite value');
}

function parseObject(tokens, text, openIndex) {
  const open = tokens[openIndex];
  const members = [];
  const commas = [];
  let close = null;
  let idx = openIndex + 1;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (!isSignificant(token)) {
      idx += 1;
      continue;
    }
    if (token.type === 'punct' && text[token.start] === '}') {
      close = token;
      break;
    }
    if (token.type === 'punct' && text[token.start] === ',') {
      commas.push(token);
      idx += 1;
      continue;
    }
    if (token.type !== 'string') throw new Error('jsonc: expected an object key');
    let key;
    try {
      key = JSON.parse(text.slice(token.start, token.end));
    } catch {
      throw new Error('jsonc: invalid object key');
    }
    let colon = idx + 1;
    while (colon < tokens.length && !isSignificant(tokens[colon])) colon += 1;
    if (!(colon < tokens.length && tokens[colon].type === 'punct' && text[tokens[colon].start] === ':')) {
      throw new Error('jsonc: expected ":" after a key');
    }
    let valueIndex = colon + 1;
    while (valueIndex < tokens.length && !isSignificant(tokens[valueIndex])) valueIndex += 1;
    if (valueIndex >= tokens.length) throw new Error('jsonc: missing value');
    const { end, after } = findValueEnd(tokens, text, valueIndex);
    members.push({ key, keyStart: token.start, valueStart: tokens[valueIndex].start, valueEnd: end, valueOpen: tokens[valueIndex], valueIndex });
    idx = after;
  }
  if (close === null) throw new Error('jsonc: unterminated object');
  return { open, close, members, commas, objStart: open.end, objEnd: close.start };
}

function detectIndent(text, object) {
  if (object.members.length > 0) {
    const lead = text.slice(object.objStart, object.members[0].keyStart);
    const nl = Math.max(lead.lastIndexOf('\n'), lead.lastIndexOf('\r'));
    const after = nl === -1 ? lead : lead.slice(nl + 1);
    if (after.length > 0 && /^[ \t]+$/.test(after)) return after;
  }
  return '  ';
}

function renderMember(name, value, indent, eol) {
  const json = JSON.stringify(value, null, indent);
  const lines = json.split('\n');
  const body = [lines[0], ...lines.slice(1).map((line) => indent + line)].join('\n');
  return `${eol}${indent}${JSON.stringify(name)}: ${body}`;
}

function rebuildBody(text, object, keep, addSegments) {
  const kept = [];
  for (let i = 0; i < object.members.length; i += 1) {
    if (!keep(object.members[i])) continue;
    const start = i === 0 ? object.objStart : object.commas[i - 1].end;
    kept.push(text.slice(start, object.members[i].valueEnd));
  }
  const last = object.members[object.members.length - 1];
  const gapPost = text.slice(last ? last.valueEnd : object.objStart, object.objEnd);
  const all = kept.concat(addSegments);
  return { body: `${all.join(',')}${gapPost}`, count: all.length };
}

function outerText(text, object, body) {
  return `${text.slice(0, object.open.start)}{${body}}${text.slice(object.close.end)}`;
}

export function mergeJsoncContainer(text, template, { container, isMine } = {}) {
  if (typeof container !== 'string' || container === '') throw new Error('mergeJsoncContainer requires a container');
  if (typeof isMine !== 'function') throw new Error('mergeJsoncContainer requires an isMine(name, value) predicate');
  const additions = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const tokens = scanJsonc(text);
  const significant = tokens.filter(isSignificant);

  if (significant.length === 0) {
    if (Object.keys(additions).length === 0) return { text, changed: false };
    const indent = '  ';
    const segments = Object.entries(additions).map(([name, value]) => renderMember(name, value, indent + indent, eol));
    const containerValue = `{${segments.join(',')}${eol}${indent}}`;
    const out = `{${eol}${indent}${JSON.stringify(container)}: ${containerValue}${eol}}`;
    return { text: out, changed: out !== text };
  }
  if (!(significant[0].type === 'punct' && text[significant[0].start] === '{')) {
    throw new Error('jsonc: top-level is not an object');
  }
  const top = parseObject(tokens, text, tokens.indexOf(significant[0]));
  const indent = detectIndent(text, top);
  const innerIndent = indent + indent;
  const containerIndex = top.members.findIndex((member) => member.key === container);
  if (top.members.filter((member) => member.key === container).length > 1) {
    throw new Error(`jsonc: duplicate key ${JSON.stringify(container)}`);
  }

  if (containerIndex === -1) {
    if (Object.keys(additions).length === 0) return { text, changed: false };
    const segments = Object.entries(additions).map(([name, value]) => renderMember(name, value, innerIndent, eol));
    const containerValue = `{${segments.join(',')}${eol}${indent}}`;
    const memberText = `${eol}${indent}${JSON.stringify(container)}: ${containerValue}`;
    const { body } = rebuildBody(text, top, () => true, [memberText]);
    const out = outerText(text, top, body);
    return { text: out, changed: out !== text };
  }

  const member = top.members[containerIndex];
  if (!(member.valueOpen.type === 'punct' && text[member.valueOpen.start] === '{')) {
    throw new Error(`jsonc: config ${container} is not a server map - wrong container for this config file?`);
  }
  const inner = parseObject(tokens, text, member.valueIndex);
  const segments = Object.entries(additions).map(([name, value]) => renderMember(name, value, innerIndent, eol));
  const keep = (entry) => {
    let value;
    try {
      value = parseJsonc(text.slice(entry.valueStart, entry.valueEnd));
    } catch {
      value = undefined;
    }
    return !isMine(entry.key, value);
  };
  if (segments.length === 0 && inner.members.every(keep)) return { text, changed: false };

  const { body, count } = rebuildBody(text, inner, keep, segments);
  if (count === 0) {
    const { body: topBody } = rebuildBody(text, top, (entry) => entry !== member, []);
    const out = outerText(text, top, topBody);
    return { text: out, changed: out !== text };
  }
  const out = `${text.slice(0, member.valueStart)}{${body}}${text.slice(member.valueEnd)}`;
  return { text: out, changed: out !== text };
}
