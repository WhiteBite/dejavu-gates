/** harness-kit public surface: registry facts + owner-scoped merge + ownership sidecar + atomic writes + templating. */
export { mergeHooks } from './merge.mjs';
export { writeMarkerBlock } from './marker.mjs';
export { checkDrift, extractCliPath, collectCommands } from './drift.mjs';
export { ConfigParseError, readJsonConfig, writeJsonAtomic } from './atomic.mjs';
export { renderTemplate, escapeForJsonString } from './template.mjs';
export {
  SIDECAR_DIR,
  SIDECAR_FILE,
  sidecarPath,
  canonicalJson,
  hashValue,
  resolveLocator,
  readOwnership,
  recordOwnership,
  ownedLocators,
  entryMatchesHash,
} from './ownership.mjs';
export { loadRegistry, validateRegistry, harness } from './registry.mjs';
export { linkState, linkDir, unlinkDir } from './symlink.mjs';
