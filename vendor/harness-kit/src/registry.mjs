/** Registry loading and zero-dependency structural validation (the JSON Schema is the external contract; this guards the shipped file). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGISTRY_PATH = join(KIT_ROOT, 'registry', 'harnesses.json');

const STATUSES = ['stable', 'preview', 'experimental'];
const SHAPES = ['nested-hooks', 'root-events', 'versioned-flat', 'versioned-typed', 'flat-matcher', 'hooks-array'];
const WRITES = ['merge', 'overwrite', 'marker-block', 'print-only'];
const RULE_FORMATS = ['plain', 'mdc', 'marker-block'];

export function loadRegistry(path = REGISTRY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateRegistry(registry) {
  const problems = [];
  if (!registry || typeof registry !== 'object') return ['registry is not an object'];
  if (registry.schemaVersion !== 1) problems.push(`schemaVersion must be 1, got ${JSON.stringify(registry.schemaVersion)}`);
  if (typeof registry.registryVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(registry.registryVersion)) {
    problems.push(`registryVersion must be semver, got ${JSON.stringify(registry.registryVersion)}`);
  }
  const harnesses = registry.harnesses;
  if (!harnesses || typeof harnesses !== 'object' || Array.isArray(harnesses) || Object.keys(harnesses).length === 0) {
    problems.push('harnesses must be a non-empty object');
    return problems;
  }
  for (const [id, entry] of Object.entries(harnesses)) {
    if (!entry || typeof entry !== 'object') {
      problems.push(`${id}: entry is not an object`);
      continue;
    }
    if (typeof entry.name !== 'string' || entry.name === '') problems.push(`${id}: name is required`);
    if (!STATUSES.includes(entry.status)) problems.push(`${id}: status must be one of ${STATUSES.join(', ')}`);
    if (entry.hooks !== undefined && entry.hooks !== null) {
      if (typeof entry.hooks !== 'object' || Array.isArray(entry.hooks)) {
        problems.push(`${id}: hooks must be an object or null`);
      } else {
        const hooks = entry.hooks;
        if (!hooks.config || typeof hooks.config !== 'object' || typeof hooks.config.project !== 'string') {
          problems.push(`${id}: hooks.config.project is required`);
        }
        if (!WRITES.includes(hooks.write)) problems.push(`${id}: hooks.write must be one of ${WRITES.join(', ')}`);
        if (hooks.write === 'merge' && !SHAPES.includes(hooks.shape)) {
          problems.push(`${id}: hooks.shape is required for write=merge, one of ${SHAPES.join(', ')}`);
        }
        if (hooks.shape !== undefined && !SHAPES.includes(hooks.shape)) {
          problems.push(`${id}: unknown hooks.shape ${JSON.stringify(hooks.shape)}`);
        }
      }
    }
    if (entry.rules !== undefined && !Array.isArray(entry.rules)) problems.push(`${id}: rules must be an array`);
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      if (typeof rule.path !== 'string' || rule.path === '') problems.push(`${id}: rule.path is required`);
      if (!RULE_FORMATS.includes(rule.format)) problems.push(`${id}: rule.format must be one of ${RULE_FORMATS.join(', ')}`);
    }
  }
  return problems;
}

export function harness(registry, id) {
  const entry = registry.harnesses && registry.harnesses[id];
  if (!entry) {
    throw new Error(`unknown harness "${id}" (registry ${registry.registryVersion}); known: ${Object.keys(registry.harnesses || {}).join(', ')}`);
  }
  return entry;
}
