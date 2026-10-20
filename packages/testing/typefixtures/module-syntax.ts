// verbatimModuleSyntax + isolatedModules: type-only imports and re-exports must say `type`,
// so every file can be transpiled on its own (SWC/esbuild/Vitest) and ESM output never keeps
// an import of something that does not exist at runtime.

// @ts-expect-error TS1484 verbatimModuleSyntax: a type must be imported with `import type`
import { Shape } from "./support/types.js";

// The supported patterns: `import type` for types, a plain import for values, or inline
// `type` modifiers when mixing both from one module.
import type { ShapeKind } from "./support/types.js";
import { DEFAULT_SIZE, type Shape as ShapeAlias } from "./support/types.js";

// @ts-expect-error TS1205 isolatedModules: a re-exported type must use `export type`
export { ShapeKind as Kind } from "./support/types.js";
export type { Shape as PublicShape } from "./support/types.js";

export const circle: Shape = { kind: "circle", size: DEFAULT_SIZE };
export const square: ShapeAlias = { kind: "square", size: DEFAULT_SIZE };
export const kind: ShapeKind = "circle";
