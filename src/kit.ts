/**
 * Typed facade over the vendored harness-kit: runtime from vendor/harness-kit/src,
 * types from vendor/harness-kit/types/index.d.mts. Vendored files are read-only —
 * integrity is pinned by test/vendor-sync.test.ts against the vendored manifest.
 */
import type {
  checkDrift as CheckDriftFn,
  checkInstall as CheckInstallFn,
  collectCommands as CollectCommandsFn,
  harness as HarnessFn,
  loadRegistry as LoadRegistryFn,
  mergeHooks as MergeHooksFn,
  renderPath as RenderPathFn,
  renderTemplate as RenderTemplateFn,
  CheckDriftInput,
  MergeShape,
} from "../vendor/harness-kit/types/index.d.mts"
import * as kit from "../vendor/harness-kit/src/index.mjs"

export const mergeHooks: typeof MergeHooksFn = kit.mergeHooks
export const renderTemplate: typeof RenderTemplateFn = kit.renderTemplate
export const renderPath: typeof RenderPathFn = kit.renderPath
export const collectCommands: typeof CollectCommandsFn = kit.collectCommands
export const loadRegistry: typeof LoadRegistryFn = kit.loadRegistry
export const harness: typeof HarnessFn = kit.harness
// allowJs infers checkDrift's status as plain string; the kit's own .d.mts is the authoritative type
export const checkDrift: typeof CheckDriftFn = kit.checkDrift as typeof CheckDriftFn
export const checkInstall: typeof CheckInstallFn = kit.checkInstall as typeof CheckInstallFn
export type { CheckDriftInput, MergeShape }
