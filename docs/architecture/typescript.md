# TypeScript configuration and project references

Every TypeScript workspace member (9 apps, 25 packages) compiles under one strict base config and
is wired into a single incremental `tsc -b` build through project references. This page is the
reference for that setup (FOUND-003); CONTEXT_PACK §5 sets the conventions it enforces.

## Files

| File | Role |
|---|---|
| `tsconfig.base.json` | The only place compiler options are defined. Holds options only: no `files`, `include` or `references`. |
| `tsconfig.json` (root) | Solution file: `"files": []` plus a reference to every member, so `tsc -b` builds the whole workspace in dependency order. |
| `<member>/tsconfig.json` | `extends: "../../tsconfig.base.json"`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: dist/.tsbuildinfo`, `include: ["src"]`, `references` to its workspace dependencies. |
| `packages/testing/typefixtures/tsconfig.json` | Nested project with the compile-fail fixtures (see [Proving the flags](#proving-the-flags)), referenced from `packages/testing/tsconfig.json`. |
| `scripts/check-tsconfig.mjs` | Structural guard, run by `pnpm typecheck` (the Turborepo root task `//#check:tsconfig`, which every member's `typecheck` waits for) and by `pnpm check:tsconfig`. |

`outDir`, `rootDir` and `tsBuildInfoFile` are set in each member, not in the base: relative paths in
an extended config resolve against the file that declares them.

## Commands

```bash
pnpm typecheck                              # turbo: check-tsconfig, then tsc -b per member in dependency order (cached)
pnpm --filter @blackwing/<name> typecheck   # tsc -b --pretty false for one member (+ its references)
pnpm check:tsconfig                         # structural check only, JSON summary on stdout
pnpm exec tsc -b --verbose                  # explain build order and up-to-date decisions
pnpm exec tsc -b --clean                    # remove every member's dist/ outputs
```

Every member's `typecheck` script is exactly `tsc -b --pretty false` (plain, CI-annotatable output).
Build info lives in `<member>/dist/.tsbuildinfo` and is gitignored with the rest of `dist/`, so
unchanged members are skipped on the next run.

## Compiler options

| Option | Value | Why |
|---|---|---|
| `target` / `lib` | `ES2023` / `["ES2023"]` | Node 22 baseline. No DOM and no newer libraries in server code. |
| `module` / `moduleResolution` | `NodeNext` | Node's own ESM rules: relative imports carry `.js` extensions, `package.json` `exports` are honoured. |
| `moduleDetection` | `force` | Every file is a module, so nothing leaks into global scope. |
| `types` | `["node"]` | Only Node typings are ambient. Each member lists `@types/node` explicitly. |
| `strict` | `true` | The whole strict family. No member may switch a family flag (`noImplicitAny`, `strictNullChecks`, `useUnknownInCatchVariables`, ...) back off. |
| `noUncheckedIndexedAccess` | `true` | Index signatures and array elements are `T \| undefined`. |
| `exactOptionalPropertyTypes` | `true` | `a?: string` means "may be absent", not "may be `undefined`". |
| `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` | `true` | Catch silent control-flow and inheritance mistakes. |
| `allowUnreachableCode`, `allowUnusedLabels` | `false` | Turn these from editor hints into errors. |
| `forceConsistentCasingInFileNames` | `true` | Imports behave the same on case-insensitive filesystems (macOS, Windows). |
| `verbatimModuleSyntax`, `isolatedModules` | `true` | Each file can be transpiled on its own (Vitest, SWC in Next.js, esbuild), and type-only imports are always explicit. |
| `allowJs` | `false` | All source is TypeScript. JavaScript can never slip in unchecked. |
| `composite`, `incremental`, `declaration`, `declarationMap`, `sourceMap` | `true` | Required for project references. Editors jump to source across packages, and stack traces map back. |
| `noEmitOnError` | `true` | A broken member never leaves stale `.d.ts` files for its dependents. |
| `skipLibCheck` | `true` | Skips checking `.d.ts` files only (mostly `node_modules`). Some third-party typings break under `exactOptionalPropertyTypes`. App code is never relaxed to work around that. |

Two rules sit beyond the compiler, in ESLint (FOUND-004, [`eslint.config.mjs`](../../eslint.config.mjs)): no `any`,
explicit or implicit, and no non-null assertions (`value!`). The base config does nothing that weakens them: no `allowJs`, no
loose libraries, no relaxed strict flags.

### Sanctioned exception: `apps/web`

Next.js compiles the console with its own bundler (SWC), so `apps/web/tsconfig.json` overrides only
the module system and environment:

| Option | `apps/web` | Base |
|---|---|---|
| `module` | `ESNext` | `NodeNext` |
| `moduleResolution` | `Bundler` | `NodeNext` |
| `lib` | `["ES2023", "DOM", "DOM.Iterable"]` | `["ES2023"]` |
| `jsx` | `preserve` | unset |

Every strict option still applies, and the web project is still a composite member of the `tsc -b`
build. The web epic adds the Next.js specifics on top of this file: the `next` plugin,
`next-env.d.ts`, `.next/types` and path aliases. If Next.js ever needs a config that cannot be
composite (for example `noEmit`), give it a separate file through `typescript.tsconfigPath` in
`next.config`, and keep `tsconfig.json` as the strict composite project. No other member may deviate.
`check-tsconfig` holds `apps/web` to exactly these values and every other member to the base.

### Why there is no `tsconfig.build.json`

Every Node member emits the same way it typechecks: `src/` → `dist/` with declarations. A separate
build config would only duplicate the reference graph. Tests in `src/` are compiled too, so they are
typechecked under the same rules. Vitest never runs their `dist/` copies, because its default
exclude list contains `**/dist/**`. If a member later needs different emit (a bundled CLI binary, a
Next.js build), add a `tsconfig.build.json` next to its `tsconfig.json` that extends it. Leave the
strict options untouched in that file.

## Module syntax: `import type` and ESM/CJS interop

Every package is ESM (`"type": "module"`). With `verbatimModuleSyntax`, TypeScript emits each import
as written, so:

```ts
import type { RunState } from "@blackwing/contracts";        // type-only: erased from output
import { runStateSchema, type RunId } from "@blackwing/contracts"; // value + inline type modifier
export type { RunState } from "./run-state.js";               // re-exporting a type needs `export type`
import { helper } from "./helper.js";                         // relative imports use the .js extension
```

Importing a type without `type` fails with TS1484. Re-exporting one without `export type` fails
with TS1205. CommonJS dependencies are consumed with a default import (`import ts from "typescript"`),
which `NodeNext` allows for `module.exports` packages. Named imports from CJS only work when Node can
detect them statically. Never use `require` in TypeScript source.

## Project references and the dependency DAG

A member declares a workspace dependency in two places, and both must agree:

1. `package.json`: `"@blackwing/<dep>": "workspace:*"` (in `dependencies`, `devDependencies`,
   `peerDependencies` or `optionalDependencies`);
2. `tsconfig.json`: `{ "path": "../../<apps|packages>/<dep>" }` in `references`.

`check-tsconfig` fails when a dependency has no reference, or when a reference has no dependency.
`tsc -b` fails as well (TS6307) if source from an unreferenced package is pulled into a project.
That way every edge in the build graph is declared. Each epic adds edges as it adds real imports. The
first edges are `packages/ids -> packages/errors` (`IdValidationError` extends `ValidationError`) and
`packages/config -> packages/errors` (`ConfigValidationError` extends `AppError`), then
`packages/logger -> packages/config` (the logger reads the secret-redaction registry and `LOG_LEVEL`
types, FOUND-008) and `packages/logger -> packages/errors` (built-in credential patterns and error
serialisation).

Edges must follow the allowed layering, which FOUND-005 (#7) enforces with a boundaries check and
documents in `docs/architecture/dependency-graph.md`:

```
errors               -> (nothing internal)   (AppError hierarchy; config, logger and everything else throw it)
contracts            -> errors
shared libs          -> contracts, errors    (config, logger, ids, time, telemetry, testing, crypto, ...)
logger               -> config               (the one shared-lib edge: the redaction registry, §8.7)
domain, policy       -> contracts, shared libs
other packages       -> contracts, shared libs, domain, policy
apps/*               -> any package, never another app
test code            -> may also use @blackwing/testing
```

Cycles are not allowed. `tsc -b` rejects circular references with TS6202, and `check-tsconfig`
names the cycle (for example `packages/contracts -> packages/logger -> packages/contracts`). To find
the edge that breaks the build order, use `pnpm exec tsc -b --verbose`.

### Adding a new TypeScript member

1. Create `<group>/<name>/tsconfig.json` from any existing member (keep `extends`, `rootDir`,
   `outDir`, `tsBuildInfoFile`, `include`).
2. Add `"typecheck": "tsc -b --pretty false"`, plus `typescript` and `@types/node` (`catalog:`) to
   `devDependencies`.
3. Add `{ "path": "<group>/<name>" }` to the root `tsconfig.json`.
4. Run `pnpm check:tsconfig && pnpm typecheck`.

## Proving the flags

`packages/testing/typefixtures/*.ts` holds one compile-fail fixture per strict option. Each
violation is marked `// @ts-expect-error TS<code> <option>: <reason>`. The fixture project is built
by every `tsc -b`, so relaxing an option makes the marked line compile, leaves the directive unused
(TS2578) and fails `pnpm typecheck`. `packages/testing/src/typefixtures.test.ts` also verifies that:

- the fixtures compile with no diagnostics as written;
- with the directives removed, exactly the declared error code is reported on each marked line;
- relaxing each option turns that option's directives into TS2578 errors;
- every covered option has a fixture.

`packages/testing/src/project-references.test.ts` builds throwaway projects that extend the real base
config. It shows that circular references are rejected (TS6202), that an unreferenced cross-package
import fails (TS6307), and that a declared reference builds the dependency first.

`forceConsistentCasingInFileNames` only takes effect on case-insensitive filesystems, so it is
asserted structurally (base value and effective value per member) rather than with a fixture.
