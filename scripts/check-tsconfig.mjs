#!/usr/bin/env node
// Verifies the TypeScript project-reference setup defined by FOUND-003
// (docs/architecture/typescript.md):
//
//   - tsconfig.base.json carries every mandated strict option with its required value;
//   - every workspace member has a tsconfig.json that extends the base directly, emits
//     src/ -> dist/ (build info in dist/.tsbuildinfo) and, after `extends` is resolved, does
//     not relax any strict option (only apps/web may switch to bundler resolution + DOM libs);
//   - each member's `references` match its @blackwing/* workspace dependencies exactly
//     (a reference may also point to a nested project inside the member, e.g.
//     packages/testing/typefixtures, which must obey the same strictness rules);
//   - the root tsconfig.json is a pure solution file referencing every member;
//   - project references are acyclic (tsc -b also rejects cycles with TS6202; this names the cycle);
//   - every member's `typecheck` script is exactly `tsc -b --pretty false`.
//
// Usage: node scripts/check-tsconfig.mjs [--root <dir>] [--quiet]
// Prints a JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const BASE_CONFIG = 'tsconfig.base.json';
export const SOLUTION_CONFIG = 'tsconfig.json';
export const TYPECHECK_SCRIPT = 'tsc -b --pretty false';
export const MEMBER_GROUPS = Object.freeze(['apps', 'packages']);
export const SCOPE = '@blackwing/';

/** Raw values tsconfig.base.json must set (compared case-insensitively for strings). */
export const REQUIRED_BASE_OPTIONS = Object.freeze({
  target: 'ES2023',
  lib: Object.freeze(['ES2023']),
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  allowJs: false,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  composite: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  skipLibCheck: true,
});

/** Effective options that must be `true` for every project. */
export const MUST_BE_TRUE = Object.freeze([
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'forceConsistentCasingInFileNames',
  'verbatimModuleSyntax',
  'isolatedModules',
  'composite',
  'declaration',
  'declarationMap',
  'sourceMap',
]);

/** Members of the `strict` family: implied by `strict`, so they may only be absent or `true`. */
export const STRICT_FAMILY = Object.freeze([
  'noImplicitAny',
  'noImplicitThis',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'useUnknownInCatchVariables',
  'alwaysStrict',
]);

/** Effective options that must be `false` (or absent) for every project. */
export const MUST_NOT_BE_TRUE = Object.freeze([
  'allowJs',
  'checkJs',
  'allowUnreachableCode',
  'allowUnusedLabels',
]);

/**
 * The only sanctioned deviations from the base module/lib settings (documented in
 * docs/architecture/typescript.md). Next.js compiles apps/web with its own bundler, so the
 * console uses bundler resolution, DOM libraries and preserved JSX; strictness is unchanged.
 */
export const EXCEPTIONS = Object.freeze({
  'apps/web': Object.freeze({
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: Object.freeze(['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']),
    jsx: ts.JsxEmit.Preserve,
  }),
});

const DEFAULT_SETTINGS = Object.freeze({
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: Object.freeze(['lib.es2023.d.ts']),
  jsx: undefined,
});

const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/**
 * @param {string} file
 * @returns {{ value: Record<string, unknown> | null, error: string | null }}
 */
function readTsconfigJson(file) {
  const result = ts.readConfigFile(file, (name) => ts.sys.readFile(name));
  if (result.error !== undefined) {
    return { value: null, error: ts.flattenDiagnosticMessageText(result.error.messageText, ' ') };
  }
  /** @type {unknown} */
  const value = result.config;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { value: null, error: 'must contain a JSON object' };
  }
  return { value: /** @type {Record<string, unknown>} */ (value), error: null };
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(file) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
function sameRawValue(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => sameRawValue(actual[index], item))
    );
  }
  if (typeof expected === 'string')
    return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

/**
 * @param {string} root
 * @param {string[]} errors
 */
function checkBase(root, errors) {
  const file = path.join(root, BASE_CONFIG);
  if (!existsSync(file)) {
    errors.push(`${BASE_CONFIG}: missing at repository root`);
    return;
  }
  const { value, error } = readTsconfigJson(file);
  if (value === null) {
    errors.push(`${BASE_CONFIG}: ${error ?? 'unreadable'}`);
    return;
  }
  if ('extends' in value) errors.push(`${BASE_CONFIG}: must not extend another config`);
  for (const key of ['files', 'include', 'references']) {
    if (key in value)
      errors.push(`${BASE_CONFIG}: must not declare "${key}" (it only holds compilerOptions)`);
  }
  const options = /** @type {Record<string, unknown>} */ (value.compilerOptions ?? {});
  for (const [key, expected] of Object.entries(REQUIRED_BASE_OPTIONS)) {
    if (!sameRawValue(options[key], expected)) {
      errors.push(
        `${BASE_CONFIG}: compilerOptions.${key} must be ${JSON.stringify(expected)}, found ${JSON.stringify(options[key])}`,
      );
    }
  }
  for (const key of STRICT_FAMILY) {
    if (options[key] === false)
      errors.push(`${BASE_CONFIG}: compilerOptions.${key} must not be false (relaxes strict)`);
  }
  if (options.checkJs === true)
    errors.push(`${BASE_CONFIG}: compilerOptions.checkJs must not be enabled`);
}

/**
 * @param {string} root
 * @returns {{ dir: string, name: string | null, manifest: Record<string, unknown> | null }[]}
 */
function discoverMembers(root) {
  /** @type {{ dir: string, name: string | null, manifest: Record<string, unknown> | null }[]} */
  const members = [];
  for (const group of MEMBER_GROUPS) {
    const abs = path.join(root, group);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs).sort()) {
      const dir = `${group}/${entry}`;
      if (!statSync(path.join(root, dir)).isDirectory()) continue;
      const manifestFile = path.join(root, dir, 'package.json');
      if (!existsSync(manifestFile)) continue; // reported by check-layout
      const manifest = readJsonObject(manifestFile);
      const name = typeof manifest?.name === 'string' ? manifest.name : null;
      members.push({ dir, name, manifest });
    }
  }
  return members;
}

/**
 * @param {string} configFile
 * @returns {{ parsed: import("typescript").ParsedCommandLine | null, errors: string[] }}
 */
function parseProject(configFile) {
  /** @type {string[]} */
  const errors = [];
  /** @type {import("typescript").ParseConfigFileHost} */
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, undefined, host) ?? null;
  if (parsed !== null) {
    for (const diagnostic of parsed.errors)
      errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  }
  return { parsed, errors };
}

/**
 * Checks effective (post-`extends`) options that apply to every project.
 * @param {string} label
 * @param {import("typescript").CompilerOptions} options
 * @param {string | null} exceptionKey
 * @param {string[]} errors
 */
function checkEffectiveOptions(label, options, exceptionKey, errors) {
  for (const key of MUST_BE_TRUE) {
    if (options[key] !== true)
      errors.push(`${label}: effective compilerOptions.${key} must be true`);
  }
  for (const key of STRICT_FAMILY) {
    if (options[key] === false)
      errors.push(`${label}: compilerOptions.${key} must not be false (relaxes strict)`);
  }
  for (const key of MUST_NOT_BE_TRUE) {
    if (options[key] === true) errors.push(`${label}: compilerOptions.${key} must not be true`);
  }
  // skipLibCheck may be turned off per project (stricter); it only ever skips .d.ts checking.
  if (options.target !== ts.ScriptTarget.ES2023)
    errors.push(`${label}: compilerOptions.target must be ES2023`);
  const expected =
    exceptionKey === null
      ? DEFAULT_SETTINGS
      : EXCEPTIONS[/** @type {keyof typeof EXCEPTIONS} */ (exceptionKey)];
  const suffix =
    exceptionKey === null
      ? '(only the documented apps/web exception may differ)'
      : '(documented exception)';
  if (options.module !== expected.module) {
    errors.push(
      `${label}: compilerOptions.module must be ${ts.ModuleKind[expected.module]} ${suffix}`,
    );
  }
  if (options.moduleResolution !== expected.moduleResolution) {
    errors.push(
      `${label}: compilerOptions.moduleResolution must be ${ts.ModuleResolutionKind[expected.moduleResolution]} ${suffix}`,
    );
  }
  const lib = options.lib ?? [];
  if (lib.length !== expected.lib.length || !expected.lib.every((entry) => lib.includes(entry))) {
    errors.push(
      `${label}: compilerOptions.lib must be [${expected.lib.join(', ')}] ${suffix}, found [${lib.join(', ')}]`,
    );
  }
  if (options.jsx !== expected.jsx) {
    errors.push(
      `${label}: compilerOptions.jsx must be ${expected.jsx === undefined ? 'unset' : ts.JsxEmit[expected.jsx]} ${suffix}`,
    );
  }
}

/**
 * @param {string} root
 * @param {string} file absolute path
 * @returns {string}
 */
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * Runs every TypeScript configuration check against `root`.
 * @param {string} root
 * @returns {{ ok: boolean, root: string, projects: number, members: { dir: string, references: string[] }[], errors: string[] }}
 */
export function checkTsconfig(root) {
  /** @type {string[]} */
  const errors = [];
  checkBase(root, errors);

  const members = discoverMembers(root);
  /** @type {Map<string, string>} package name -> member dir */
  const dirByName = new Map();
  for (const member of members) if (member.name !== null) dirByName.set(member.name, member.dir);
  const memberDirs = new Set(members.map((member) => member.dir));
  const baseFile = path.join(root, BASE_CONFIG);

  /** @type {Map<string, string[]>} member dir -> referenced member dirs */
  const graph = new Map();
  /** @type {{ dir: string, references: string[] }[]} */
  const summary = [];
  let projects = 0;

  for (const member of members) {
    const label = `${member.dir}/${SOLUTION_CONFIG}`;
    const configFile = path.join(root, member.dir, SOLUTION_CONFIG);

    const scripts = /** @type {Record<string, unknown> | undefined} */ (member.manifest?.scripts);
    if (scripts?.typecheck !== TYPECHECK_SCRIPT) {
      errors.push(`${member.dir}/package.json: "scripts.typecheck" must be "${TYPECHECK_SCRIPT}"`);
    }
    const devDependencies = /** @type {Record<string, unknown> | undefined} */ (
      member.manifest?.devDependencies
    );
    if (typeof devDependencies?.typescript !== 'string') {
      errors.push(
        `${member.dir}/package.json: "devDependencies.typescript" is required (use "catalog:")`,
      );
    }

    if (!existsSync(configFile)) {
      errors.push(`${label}: missing (every TypeScript member extends ${BASE_CONFIG})`);
      continue;
    }
    const raw = readTsconfigJson(configFile);
    if (raw.value === null) {
      errors.push(`${label}: ${raw.error ?? 'unreadable'}`);
      continue;
    }
    if (raw.value.extends !== `../../${BASE_CONFIG}`) {
      errors.push(`${label}: "extends" must be "../../${BASE_CONFIG}"`);
    }

    const { parsed, errors: parseErrors } = parseProject(configFile);
    for (const message of parseErrors) errors.push(`${label}: ${message}`);
    if (parsed === null) continue;
    projects += 1;

    const exceptionKey = Object.hasOwn(EXCEPTIONS, member.dir) ? member.dir : null;
    checkEffectiveOptions(label, parsed.options, exceptionKey, errors);

    const memberRoot = path.join(root, member.dir);
    /**
     * @param {string} option
     * @param {string} expected
     */
    const expectPath = (option, expected) => {
      const actual = parsed.options[option];
      if (
        typeof actual !== 'string' ||
        path.resolve(actual) !== path.resolve(memberRoot, expected)
      ) {
        errors.push(`${label}: compilerOptions.${option} must be "${expected}"`);
      }
    };
    expectPath('rootDir', 'src');
    expectPath('outDir', 'dist');
    expectPath('tsBuildInfoFile', 'dist/.tsbuildinfo');
    if (parsed.fileNames.length === 0)
      errors.push(`${label}: includes no source files (expected src/**)`);

    /** @type {Set<string>} */
    const declaredDeps = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      const deps = /** @type {Record<string, unknown> | undefined} */ (member.manifest?.[field]);
      for (const dep of Object.keys(deps ?? {})) if (dep.startsWith(SCOPE)) declaredDeps.add(dep);
    }
    /** @type {Set<string>} */
    const expectedRefs = new Set();
    for (const dep of declaredDeps) {
      const depDir = dirByName.get(dep);
      if (depDir === undefined)
        errors.push(`${member.dir}/package.json: depends on unknown workspace package "${dep}"`);
      else if (depDir === member.dir)
        errors.push(`${member.dir}/package.json: must not depend on itself`);
      else expectedRefs.add(depDir);
    }

    /** @type {string[]} */
    const memberRefs = [];
    for (const reference of parsed.projectReferences ?? []) {
      const refConfig = ts.resolveProjectReferencePath(reference);
      const refDir = rel(root, path.dirname(refConfig));
      if (!existsSync(refConfig)) {
        errors.push(
          `${label}: reference "${rel(memberRoot, reference.path)}" has no tsconfig.json`,
        );
      } else if (memberDirs.has(refDir)) {
        memberRefs.push(refDir);
        if (!expectedRefs.has(refDir)) {
          const refName = members.find((m) => m.dir === refDir)?.name ?? refDir;
          errors.push(
            `${label}: references ${refDir} but package.json does not depend on "${refName}"`,
          );
        }
      } else if (refDir.startsWith(`${member.dir}/`)) {
        projects += 1;
        checkNestedProject(root, refConfig, baseFile, errors);
      } else {
        errors.push(
          `${label}: reference "${refDir}" is neither a workspace dependency nor a project nested in ${member.dir}`,
        );
      }
    }
    for (const depDir of expectedRefs) {
      if (!memberRefs.includes(depDir)) {
        const depName = members.find((m) => m.dir === depDir)?.name ?? depDir;
        errors.push(
          `${label}: depends on "${depName}" but has no { "path": "../../${depDir}" } reference`,
        );
      }
    }
    graph.set(member.dir, memberRefs);
    summary.push({ dir: member.dir, references: [...memberRefs].sort() });
  }

  checkSolution(root, memberDirs, errors);
  for (const cycle of findCycles(graph))
    errors.push(`circular project references: ${cycle.join(' -> ')}`);

  return { ok: errors.length === 0, root, projects, members: summary, errors };
}

/**
 * A project nested inside a member (e.g. packages/testing/typefixtures) must extend the base
 * and obey the same strictness rules; its output stays inside the member's dist/.
 * @param {string} root
 * @param {string} configFile
 * @param {string} baseFile
 * @param {string[]} errors
 */
function checkNestedProject(root, configFile, baseFile, errors) {
  const label = rel(root, configFile);
  const raw = readTsconfigJson(configFile);
  if (raw.value === null) {
    errors.push(`${label}: ${raw.error ?? 'unreadable'}`);
    return;
  }
  if (
    typeof raw.value.extends !== 'string' ||
    path.resolve(path.dirname(configFile), raw.value.extends) !== baseFile
  ) {
    errors.push(`${label}: "extends" must point at ${BASE_CONFIG}`);
  }
  const { parsed, errors: parseErrors } = parseProject(configFile);
  for (const message of parseErrors) errors.push(`${label}: ${message}`);
  if (parsed === null) return;
  checkEffectiveOptions(label, parsed.options, null, errors);
  const outDir = parsed.options.outDir;
  if (typeof outDir !== 'string' || !rel(root, outDir).split('/').includes('dist')) {
    errors.push(`${label}: compilerOptions.outDir must be inside a dist/ directory (gitignored)`);
  }
  if ((parsed.projectReferences ?? []).length > 0)
    errors.push(`${label}: nested projects must not declare references`);
}

/**
 * @param {string} root
 * @param {Set<string>} memberDirs
 * @param {string[]} errors
 */
function checkSolution(root, memberDirs, errors) {
  const file = path.join(root, SOLUTION_CONFIG);
  if (!existsSync(file)) {
    errors.push(`${SOLUTION_CONFIG}: missing at repository root (solution file for tsc -b)`);
    return;
  }
  const { value, error } = readTsconfigJson(file);
  if (value === null) {
    errors.push(`${SOLUTION_CONFIG}: ${error ?? 'unreadable'}`);
    return;
  }
  if (!Array.isArray(value.files) || value.files.length !== 0) {
    errors.push(
      `${SOLUTION_CONFIG}: must declare "files": [] (a solution file compiles nothing itself)`,
    );
  }
  if ('include' in value) errors.push(`${SOLUTION_CONFIG}: must not declare "include"`);
  /** @type {unknown[]} */
  const references = Array.isArray(value.references) ? value.references : [];
  /** @type {Set<string>} */
  const referenced = new Set();
  for (const reference of references) {
    const refValue =
      reference !== null && typeof reference === 'object' && 'path' in reference
        ? reference.path
        : undefined;
    const refPath = typeof refValue === 'string' ? refValue : '';
    const refDir = rel(root, path.resolve(root, refPath.replace(/\/tsconfig\.json$/, '')));
    if (referenced.has(refDir)) errors.push(`${SOLUTION_CONFIG}: duplicate reference "${refDir}"`);
    referenced.add(refDir);
    if (!memberDirs.has(refDir))
      errors.push(`${SOLUTION_CONFIG}: reference "${refPath}" is not a workspace member`);
  }
  for (const dir of memberDirs) {
    if (!referenced.has(dir))
      errors.push(`${SOLUTION_CONFIG}: missing reference { "path": "${dir}" }`);
  }
}

/**
 * Returns each elementary cycle once (rotated to start at its smallest node).
 * @param {Map<string, string[]>} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  /** @type {Set<string>} */
  const done = new Set();
  /**
   * @param {string} node
   * @param {string[]} stack
   */
  const visit = (node, stack) => {
    const at = stack.indexOf(node);
    if (at !== -1) {
      const cycle = stack.slice(at);
      const start = cycle.indexOf([...cycle].sort()[0] ?? node);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      found.set(rotated.join(' '), [...rotated, rotated[0] ?? node]);
      return;
    }
    if (done.has(node)) return;
    for (const next of graph.get(node) ?? []) visit(next, [...stack, node]);
    done.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node, []);
  return [...found.values()];
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean }}
 */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') quiet = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--root requires a directory argument');
      root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, quiet };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-tsconfig: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const result = checkTsconfig(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(`check-tsconfig: ${result.errors.length} problem(s) found:\n`);
    for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
  }
  return result.ok ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
