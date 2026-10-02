/** Minimal ambient typing for the bun:test entry points this repo uses (no @types/bun dependency). */
declare module "bun:test" {
  export function test(name: string, fn: () => void | Promise<void>): void
}
