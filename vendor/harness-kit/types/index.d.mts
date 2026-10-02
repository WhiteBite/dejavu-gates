/** Type declarations for the harness-kit public surface (Bun/TS consumers import the vendored .mjs directly). */

export type HarnessStatus = 'stable' | 'preview' | 'experimental';
export type MergeShape = 'nested-hooks' | 'root-events' | 'versioned-flat' | 'versioned-typed' | 'flat-matcher' | 'hooks-array';
export type WriteMode = 'merge' | 'overwrite' | 'marker-block' | 'print-only';

export interface RegistryRule {
  path: string;
  format: 'plain' | 'mdc' | 'marker-block';
  ownership?: string;
  frontmatter?: string[];
  markers?: { open?: string; close?: string; mode?: string };
  note?: string;
}

export interface RegistryHooks {
  config: { project: string; user?: string };
  resolveVia?: string;
  write: WriteMode;
  shape?: MergeShape;
  envelope?: Record<string, unknown>;
  events?: string[];
  triggers?: string[];
  entryFields?: Record<string, unknown>;
  markers?: { open?: string; close?: string; mode?: string };
  pluginRootVar?: string;
  toolNames?: string[];
  envOverrides?: Record<string, string>;
}

export interface RegistryHarness {
  name: string;
  status: HarnessStatus;
  hooks?: RegistryHooks | null;
  plugin?: Record<string, unknown>;
  skills?: { global?: string[]; project?: string[] };
  rules?: RegistryRule[];
  manifests?: Record<string, string>;
  notes?: string;
}

export interface Registry {
  schemaVersion: number;
  registryVersion: string;
  conventions?: Record<string, unknown>;
  harnesses: Record<string, RegistryHarness>;
}

export interface OwnershipRecord {
  owner: string;
  file: string;
  locator: (string | number)[];
  sha256: string;
}

export interface LinkResult {
  state: 'absent' | 'linked' | 'foreign-link' | 'manual';
  ok: boolean;
  action: string;
}

export function loadRegistry(path?: string): Registry;
export function validateRegistry(registry: Registry): string[];
export function harness(registry: Registry, id: string): RegistryHarness;

export function mergeHooks(
  existing: Record<string, unknown>,
  template: Record<string, unknown>,
  options: { shape: MergeShape; isMine: (command: unknown) => boolean },
): Record<string, unknown>;

export type MarkerBlockAction = 'created' | 'replaced' | 'appended' | 'unchanged' | 'skipped-foreign';
export interface MarkerBlockResult {
  action: MarkerBlockAction;
}

export interface ShellBlockOpts {
  variant: 'shell-block';
  id: string;
  shebang?: string;
  executable?: boolean;
}
export interface HtmlBlockOpts {
  variant: 'html-block';
  id: string;
}
export interface FirstLineMarkerOpts {
  variant: 'first-line-marker';
  marker: string;
}
export interface MdcFrontmatterOpts {
  variant: 'mdc-frontmatter';
  fields: ReadonlyArray<readonly [string, string]>;
  body: string;
}
export type WriteMarkerBlockOpts = ShellBlockOpts | HtmlBlockOpts | FirstLineMarkerOpts | MdcFrontmatterOpts;

/** `block` is the full caller-assembled text for shell/html/first-line; mdc-frontmatter builds bytes from fields + body and ignores it. */
export function writeMarkerBlock(path: string, block: string, opts: WriteMarkerBlockOpts): MarkerBlockResult;

export type DriftStatus = 'broken' | 'missing' | 'stale' | 'ok';
export interface DriftResult {
  status: DriftStatus;
  detail: string | null;
}
export interface CheckDriftInput {
  parseError?: boolean;
  config?: Record<string, unknown>;
}
export interface CheckDriftOpts {
  shape: MergeShape;
  identify: (command: unknown) => boolean;
  pathExists: (cliPath: string) => boolean;
  isMine?: (command: unknown) => boolean;
}

export function extractCliPath(command: unknown): string | null;
export function collectCommands(config: Record<string, unknown>, options: { shape: MergeShape }): string[];
export function checkDrift(input: CheckDriftInput, options: CheckDriftOpts): DriftResult;

export declare class ConfigParseError extends Error {
  path: string;
}
export function readJsonConfig(path: string): Record<string, unknown> | null;
export function writeJsonAtomic(path: string, data: unknown): void;

export function renderTemplate(text: string, vars?: Record<string, unknown>): string;
export function escapeForJsonString(value: unknown): string;

export const SIDECAR_DIR: string;
export const SIDECAR_FILE: string;
export function sidecarPath(root: string): string;
export function canonicalJson(value: unknown): string;
export function hashValue(value: unknown): string;
export function resolveLocator(root: unknown, locator: (string | number)[]): unknown;
export function readOwnership(root: string): { version: number; entries: OwnershipRecord[] };
export function recordOwnership(root: string, owner: string, file: string, config: Record<string, unknown>, locators: (string | number)[][]): void;
export function ownedLocators(root: string, owner: string, file?: string): OwnershipRecord[];
export function entryMatchesHash(config: Record<string, unknown>, record: OwnershipRecord): boolean;

export function linkState(target: string, source: string): LinkResult['state'];
export function linkDir(source: string, target: string): LinkResult;
export function unlinkDir(source: string, target: string): LinkResult;
