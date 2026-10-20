#!/usr/bin/env node
// Verifies the Turborepo task pipeline contract (FOUND-002) so caching can never silently
// corrupt results:
//
//   - turbo.json uses the v2 `tasks` key (never the v1 `pipeline` key) and defines every
//     workspace task (build, typecheck, lint, test, test:int, test:e2e, dev) with the
//     agreed dependsOn / inputs / outputs / cache settings;
//   - IO-heavy tasks (test:int, test:e2e) and dev are never cached; uncached tasks declare
//     no outputs; persistent tasks are uncached;
//   - global config files (tsconfig.base.json, ESLint flat config) bust every cache;
//   - the remote cache is disabled (local filesystem cache only in v1), environment mode
//     is strict and turbo does not write agent-guidance files into the repository;
//   - root package.json scripts delegate to `turbo run <task>`; `.turbo/` is gitignored;
//   - package-level turbo.json files extend the root config;
//   - optionally, a `turbo run --summarize` run summary proves that every executed task
//     which declares outputs actually produced matching files. A task that declares
//     `dist/**` but writes nothing caches an empty artifact, so a later cache hit "succeeds"
//     while restoring nothing. Such a package must declare `"outputs": []` in its own
//     turbo.json.
//
// Usage:
//   node scripts/check-turbo.mjs [--root <dir>] [--summary <file> | --latest-summary]
//                                [--tasks build,test] [--quiet]
// Prints a structured JSON result on stdout; exits non-zero when any check fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWorkspaceGlobs } from './check-layout.mjs';

/** Root package.json scripts that must delegate to Turborepo, verbatim. */
export const ROOT_TURBO_SCRIPTS = Object.freeze({
  build: 'turbo run build',
  lint: 'turbo run lint',
  typecheck: 'turbo run typecheck',
  test: 'turbo run test',
  'test:int': 'turbo run test:int',
  'test:e2e': 'turbo run test:e2e',
  // DEVENV-010: `pnpm dev` asserts the dependency stack is healthy (dev:doctor) before starting apps.
  dev: 'node scripts/dev-doctor.mjs && turbo run dev --parallel',
});

export const REQUIRED_TASKS = Object.freeze(Object.keys(ROOT_TURBO_SCRIPTS));

/** Tasks whose results are reusable and therefore must be cached. */
export const CACHED_TASKS = Object.freeze(['build', 'typecheck', 'lint', 'test']);

/** Tasks that touch external services or never exit: caching them would be wrong. */
export const UNCACHED_TASKS = Object.freeze(['test:int', 'test:e2e', 'dev']);

/** Inputs every cached task must hash. */
export const REQUIRED_INPUTS = Object.freeze(['src/**', 'tsconfig*.json', 'package.json']);

/** Files that must bust every task's cache when they change. */
export const REQUIRED_GLOBAL_DEPENDENCIES = Object.freeze(['tsconfig.base.json']);

/** At least one of these ESLint (flat or legacy) config globs must be a global dependency. */
export const ESLINT_GLOBAL_DEPENDENCIES = Object.freeze([
  'eslint.config.*',
  'eslint.config.mjs',
  '.eslintrc*',
]);

/** Tasks whose declared outputs must be produced on every run (checked against run summaries). */
export const DEFAULT_OUTPUT_TASKS = Object.freeze(['build']);

/** Placeholder turbo uses for packages that do not define the task's script. */
const NONEXISTENT_COMMAND = '<NONEXISTENT>';

/** Task log files are always part of a cached artifact; they do not count as outputs. */
const TASK_LOG = /(^|\/)\.turbo\/turbo-[^/]+\.log$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/**
 * @param {string} file
 * @param {string} rel
 * @param {string[]} errors
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(file, rel, errors) {
  if (!existsSync(file)) {
    errors.push(`${rel}: missing`);
    return null;
  }
  try {
    /** @type {unknown} */
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(value)) {
      errors.push(`${rel}: must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/**
 * Validates a parsed root turbo.json against the FOUND-002 contract.
 * @param {Record<string, unknown>} config
 * @returns {string[]} problems found
 */
export function checkTurboConfig(config) {
  /** @type {string[]} */
  const errors = [];
  if ('pipeline' in config) {
    errors.push(`turbo.json: uses the Turborepo v1 "pipeline" key; Turborepo v2 requires "tasks"`);
  }
  if ('extends' in config) {
    errors.push(`turbo.json: "extends" is only valid in package-level turbo.json files`);
  }

  if (config.agentGuidance !== false) {
    errors.push(
      `turbo.json: "agentGuidance" must be false (turbo must not write files such as AGENTS.md into the repository)`,
    );
  }
  if (config.envMode !== undefined && config.envMode !== 'strict') {
    errors.push(
      `turbo.json: "envMode" must be "strict" so undeclared environment variables never reach tasks`,
    );
  }

  const remote = config.remoteCache;
  if (!isObject(remote) || remote.enabled !== false) {
    errors.push(
      `turbo.json: "remoteCache.enabled" must be false (local filesystem cache only in v1)`,
    );
  }

  const globalDeps = stringArray(config.globalDependencies);
  for (const dep of REQUIRED_GLOBAL_DEPENDENCIES) {
    if (!globalDeps.includes(dep)) {
      errors.push(
        `turbo.json: "globalDependencies" must include "${dep}" so a base config change busts the cache`,
      );
    }
  }
  if (!ESLINT_GLOBAL_DEPENDENCIES.some((dep) => globalDeps.includes(dep))) {
    errors.push(
      `turbo.json: "globalDependencies" must include the ESLint config (one of ${ESLINT_GLOBAL_DEPENDENCIES.map((d) => `"${d}"`).join(', ')})`,
    );
  }

  const tasks = config.tasks;
  if (!isObject(tasks)) {
    errors.push(`turbo.json: "tasks" must be an object`);
    return errors;
  }

  for (const name of REQUIRED_TASKS) {
    if (!isObject(tasks[name])) errors.push(`turbo.json: task "${name}" is missing`);
  }

  for (const [name, raw] of Object.entries(tasks)) {
    if (!isObject(raw)) {
      errors.push(`turbo.json: task "${name}" must be an object`);
      continue;
    }
    const cached = raw.cache !== false;
    const outputs = stringArray(raw.outputs);
    if (!cached && outputs.length > 0) {
      errors.push(
        `turbo.json: task "${name}" has "cache": false but declares outputs (they would never be restored)`,
      );
    }
    if (raw.persistent === true && cached) {
      errors.push(`turbo.json: persistent task "${name}" must set "cache": false`);
    }
    for (const dep of stringArray(raw.dependsOn)) {
      if (!dep.startsWith('//#')) continue;
      const rootTask = tasks[dep];
      if (!isObject(rootTask)) {
        errors.push(`turbo.json: task "${name}" depends on undefined root task "${dep}"`);
        continue;
      }
      // A root task's hash feeds every dependent's hash: with the default inputs (every
      // root file) an unrelated edit such as README.md would bust every package's cache.
      const rootInputs = stringArray(rootTask.inputs);
      if (rootInputs.length === 0 || rootInputs.includes('$TURBO_DEFAULT$')) {
        errors.push(
          `turbo.json: root task "${dep}" (a dependency of "${name}") must declare explicit "inputs" without $TURBO_DEFAULT$`,
        );
      }
    }
  }

  for (const name of CACHED_TASKS) {
    const task = tasks[name];
    if (!isObject(task)) continue;
    if (task.cache === false) errors.push(`turbo.json: task "${name}" must be cacheable`);
    if (!Array.isArray(task.outputs)) {
      errors.push(
        `turbo.json: task "${name}" must declare "outputs" explicitly (use [] when it produces none)`,
      );
    }
    const inputs = stringArray(task.inputs);
    for (const input of REQUIRED_INPUTS) {
      if (!inputs.includes(input))
        errors.push(`turbo.json: task "${name}" inputs must include "${input}"`);
    }
  }

  for (const name of UNCACHED_TASKS) {
    const task = tasks[name];
    if (isObject(task) && task.cache !== false) {
      errors.push(`turbo.json: task "${name}" must set "cache": false`);
    }
  }

  const build = tasks.build;
  if (isObject(build)) {
    if (!stringArray(build.dependsOn).includes('^build')) {
      errors.push(`turbo.json: task "build" must depend on "^build" (topological order)`);
    }
    if (!stringArray(build.outputs).includes('dist/**')) {
      errors.push(`turbo.json: task "build" must declare "dist/**" as its output`);
    }
  }

  const typecheck = tasks.typecheck;
  if (isObject(typecheck)) {
    const typecheckDeps = stringArray(typecheck.dependsOn);
    if (!typecheckDeps.includes('^build')) {
      errors.push(`turbo.json: task "typecheck" must depend on "^build"`);
    }
    if (!typecheckDeps.includes('^typecheck')) {
      // `tsc -b` also builds referenced projects; without this edge a package and its
      // dependent could write the same dist/ concurrently.
      errors.push(
        `turbo.json: task "typecheck" must depend on "^typecheck" (tsc -b builds project references)`,
      );
    }
    if (stringArray(typecheck.outputs).length > 0) {
      errors.push(`turbo.json: task "typecheck" must declare no outputs`);
    }
  }

  const test = tasks.test;
  if (isObject(test) && !stringArray(test.outputs).includes('coverage/**')) {
    errors.push(`turbo.json: task "test" must declare "coverage/**" as its output`);
  }

  const dev = tasks.dev;
  if (isObject(dev) && dev.persistent !== true) {
    errors.push(`turbo.json: task "dev" must set "persistent": true`);
  }

  return errors;
}

/**
 * Validates the root package.json scripts and turbo devDependency.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function checkRootScripts(manifest) {
  /** @type {string[]} */
  const errors = [];
  const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
  for (const [name, command] of Object.entries(ROOT_TURBO_SCRIPTS)) {
    if (scripts[name] !== command) {
      errors.push(
        `package.json: "scripts.${name}" must be "${command}" (found ${JSON.stringify(scripts[name] ?? null)})`,
      );
    }
  }
  const devDeps = isObject(manifest.devDependencies) ? manifest.devDependencies : {};
  const turbo = devDeps.turbo;
  if (typeof turbo !== 'string' || !/^2\.\d+\.\d+$/.test(turbo)) {
    errors.push(
      `package.json: "devDependencies.turbo" must pin an exact Turborepo 2.x version (found ${JSON.stringify(turbo ?? null)})`,
    );
  }
  return errors;
}

/**
 * Checks that `.turbo/` (local cache, logs and run summaries) is gitignored.
 * @param {string} text  contents of .gitignore
 * @returns {string[]}
 */
export function checkGitignore(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) => /^\/?\.turbo\/?$/.test(line) || /^(\*\*\/)\.turbo\/?$/.test(line))
    ? []
    : [`.gitignore: must ignore ".turbo/" (local cache, task logs and run summaries)`];
}

/**
 * Lists workspace member directories (relative) from pnpm-workspace.yaml `dir/*` globs.
 * @param {string} root
 * @returns {string[]}
 */
export function listMembers(root) {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  /** @type {string[]} */
  const members = [];
  for (const glob of parseWorkspaceGlobs(readFileSync(file, 'utf8')) ?? []) {
    const match = /^([\w.-]+)\/\*$/.exec(glob);
    if (!match?.[1]) continue;
    const base = path.join(root, match[1]);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    for (const entry of readdirSync(base).sort()) {
      if (existsSync(path.join(base, entry, 'package.json'))) members.push(`${match[1]}/${entry}`);
    }
  }
  return members;
}

/**
 * Package-level turbo.json files must extend the root configuration.
 * @param {string} root
 * @returns {string[]}
 */
export function checkPackageConfigs(root) {
  /** @type {string[]} */
  const errors = [];
  for (const dir of listMembers(root)) {
    const file = path.join(root, dir, 'turbo.json');
    if (!existsSync(file)) continue;
    const config = readJsonObject(file, `${dir}/turbo.json`, errors);
    if (config === null) continue;
    const ext = stringArray(config.extends);
    if (ext.length !== 1 || ext[0] !== '//') {
      errors.push(`${dir}/turbo.json: must contain "extends": ["//"]`);
    }
    if ('pipeline' in config)
      errors.push(`${dir}/turbo.json: uses the v1 "pipeline" key; use "tasks"`);
  }
  return errors;
}

/**
 * Checks a `turbo run --summarize` summary: every executed task named in `taskNames`
 * that declares outputs must have produced at least one matching file.
 * @param {Record<string, unknown>} summary
 * @param {readonly string[]} [taskNames]
 * @returns {string[]}
 */
export function checkRunSummary(summary, taskNames = DEFAULT_OUTPUT_TASKS) {
  /** @type {string[]} */
  const errors = [];
  if (!Array.isArray(summary.tasks)) return ['run summary: missing "tasks" array'];
  for (const raw of summary.tasks) {
    if (!isObject(raw)) continue;
    const task = typeof raw.task === 'string' ? raw.task : '';
    if (!taskNames.includes(task)) continue;
    if (raw.command === NONEXISTENT_COMMAND) continue;
    const execution = isObject(raw.execution) ? raw.execution : null;
    if (execution !== null && execution.exitCode !== 0) continue; // a failed task is reported by turbo itself
    const cache = isObject(raw.cache) ? raw.cache : {};
    const definition = isObject(raw.resolvedTaskDefinition) ? raw.resolvedTaskDefinition : {};
    if (definition.cache === false) continue;
    const declared = stringArray(raw.outputs ?? definition.outputs).filter(
      (o) => !o.startsWith('!'),
    );
    if (declared.length === 0) continue;
    const produced = stringArray(raw.expandedOutputs).filter((file) => !TASK_LOG.test(file));
    if (produced.length === 0) {
      const taskId = typeof raw.taskId === 'string' ? raw.taskId : task;
      const dir = typeof raw.directory === 'string' ? raw.directory : '<package>';
      errors.push(
        `${taskId}: declares outputs [${declared.join(', ')}] but produced no matching files ` +
          `(cache status ${typeof cache.status === 'string' ? cache.status : 'unknown'}); a cache hit would restore nothing. ` +
          `Fix the outputs or declare "outputs": [] for "${task}" in ${dir}/turbo.json`,
      );
    }
  }
  return errors;
}

/**
 * Newest run summary written by `turbo run --summarize` under `<root>/.turbo/runs`.
 * @param {string} root
 * @returns {string | null}
 */
export function latestSummary(root) {
  const dir = path.join(root, '.turbo', 'runs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: path.join(dir, f), mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file ?? null;
}

/**
 * Runs every static check against `root` (and the run summary, when given).
 * @param {string} root
 * @param {{ summary?: string | null, tasks?: readonly string[] }} [options]
 * @returns {{ ok: boolean, root: string, summary: string | null, errors: string[] }}
 */
export function checkTurbo(root, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const config = readJsonObject(path.join(root, 'turbo.json'), 'turbo.json', errors);
  if (config !== null) errors.push(...checkTurboConfig(config));
  const manifest = readJsonObject(path.join(root, 'package.json'), 'package.json', errors);
  if (manifest !== null) errors.push(...checkRootScripts(manifest));
  const gitignore = path.join(root, '.gitignore');
  if (existsSync(gitignore)) errors.push(...checkGitignore(readFileSync(gitignore, 'utf8')));
  else errors.push('.gitignore: missing');
  errors.push(...checkPackageConfigs(root));

  const summaryFile = options.summary ?? null;
  if (summaryFile !== null) {
    const summary = readJsonObject(
      summaryFile,
      path.relative(root, summaryFile) || summaryFile,
      errors,
    );
    if (summary !== null)
      errors.push(...checkRunSummary(summary, options.tasks ?? DEFAULT_OUTPUT_TASKS));
  }
  return { ok: errors.length === 0, root, summary: summaryFile, errors };
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean, summary: string | null, latest: boolean, tasks: string[] }}
 */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let quiet = false;
  /** @type {string | null} */
  let summary = null;
  let latest = false;
  let tasks = [...DEFAULT_OUTPUT_TASKS];
  /**
   * @param {number} i
   * @param {string} flag
   */
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') quiet = true;
    else if (arg === '--latest-summary') latest = true;
    else if (arg === '--root') {
      root = path.resolve(value(i, arg));
      i += 1;
    } else if (arg === '--summary') {
      summary = path.resolve(value(i, arg));
      i += 1;
    } else if (arg === '--tasks') {
      tasks = value(i, arg)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (summary !== null && latest)
    throw new Error('--summary and --latest-summary are mutually exclusive');
  return { root, quiet, summary, latest, tasks };
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
      `check-turbo: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  let summary = args.summary;
  if (args.latest) {
    summary = latestSummary(args.root);
    if (summary === null) {
      process.stderr.write(
        `check-turbo: no run summary under ${path.join(args.root, '.turbo', 'runs')} (run turbo with --summarize)\n`,
      );
      return 2;
    }
  }
  const result = checkTurbo(args.root, { summary, tasks: args.tasks });
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-turbo: ${result.errors.length} problem(s) found:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
