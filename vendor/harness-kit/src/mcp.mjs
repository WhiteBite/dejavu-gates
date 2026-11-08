/** Owner-scoped MCP server-map merge: server name is identity, so a template name replaces the same-named entry. */
export function mergeMcpServers(existing, template, { container, isMine } = {}) {
  if (typeof container !== 'string' || container === '') throw new Error('mergeMcpServers requires a container');
  if (typeof isMine !== 'function') throw new Error('mergeMcpServers requires an isMine(name, server) predicate');

  const merged = { ...existing };
  const current = merged[container];
  if (current !== undefined && (current === null || typeof current !== 'object' || Array.isArray(current))) {
    throw new Error(`config ${container} is not a server map - wrong container for this config file?`);
  }

  const kept = {};
  for (const [name, server] of Object.entries(current || {})) {
    if (!isMine(name, server)) kept[name] = server;
  }

  const additions = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  const next = { ...kept, ...additions };

  if (Object.keys(next).length === 0) {
    if (container in merged) delete merged[container];
  } else {
    merged[container] = next;
  }
  return merged;
}
