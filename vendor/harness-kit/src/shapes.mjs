/** Single source of hook-shape behavior: where the event map lives and whether entries are groups. */
export const SHAPE_DESCRIPTORS = Object.freeze({
  'nested-hooks': { container: 'hooks', grouped: true },
  'root-events': { container: 'root', grouped: true },
  'versioned-flat': { container: 'hooks', grouped: false },
  'versioned-typed': { container: 'hooks', grouped: false },
  'flat-matcher': { container: 'hooks', grouped: false },
  'hooks-array': { container: 'hooks-array', grouped: false },
});

export const SHAPE_NAMES = Object.freeze(Object.keys(SHAPE_DESCRIPTORS));

export function shapeDescriptor(shape) {
  const descriptor = SHAPE_DESCRIPTORS[shape];
  if (!descriptor) throw new Error(`unknown shape ${JSON.stringify(shape)}`);
  return descriptor;
}
