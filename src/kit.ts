/**
 * Typed facade over the vendored harness-kit: runtime from vendor/harness-kit/src,
 * types from vendor/harness-kit/types/index.d.mts. Vendored files are read-only —
 * integrity is pinned by test/vendor-sync.test.ts against the vendored manifest.
 */
import type {
  checkDrift as CheckDriftFn,
  collectCommands as CollectCommandsFn,
  mergeHooks as MergeHooksFn,
  renderTemplate as RenderTemplateFn,
  CheckDriftInput,
  MergeShape,
} from "../vendor/harness-kit/types/index.d.mts"
import * as kit from "../vendor/harness-kit/src/index.mjs"

export const mergeHooks: typeof MergeHooksFn = kit.mergeHooks
export const renderTemplate: typeof RenderTemplateFn = kit.renderTemplate
export const collectCommands: typeof CollectCommandsFn = kit.collectCommands
// allowJs infers checkDrift's status as plain string; the kit's own .d.mts is the authoritative type
export const checkDrift: typeof CheckDriftFn = kit.checkDrift as typeof CheckDriftFn
export type { CheckDriftInput, MergeShape }
