#!/usr/bin/env node
// Checks GitHub Actions supply-chain and caching policy (CI-001, #135):
// - every third-party `uses:` in .github/workflows/*.yml and .github/actions/*/action.yml is
//   pinned to a full 40-character commit SHA with a `# vX.Y.Z` version comment (§8.9);
// - the reusable setup composite action (.github/actions/setup) installs with
//   `--frozen-lockfile`, derives pnpm only from package.json "packageManager" (Corepack),
//   keys the Turborepo cache on pnpm-lock.yaml + turbo.json with a branch fallback, keeps
//   caches restore-only on forked pull requests, and references no secrets.
//
// Usage: node scripts/check-actions.mjs [--root <dir>]
// Exits non-zero (listing every problem) when the policy is not met.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const SETUP_ACTION = '.github/actions/setup/action.yml';
const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v\d+(\.\d+){0,2}\b/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks every `uses:` line of one workflow or action file.
 * @param {string} file repo-relative path, for messages
 * @param {string} text file contents
 * @returns {string[]} problems
 */
export function checkPins(file, text) {
  /** @type {string[]} */
  const errors = [];
  text.split('\n').forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(line);
    if (match === null) return;
    const ref = match[1] ?? '';
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;
    const where = `${file}:${String(index + 1)}`;
    if (!SHA_PIN.test(ref)) {
      errors.push(`${where}: '${ref}' is not pinned to a full commit SHA`);
    } else if (!VERSION_COMMENT.test(match[2] ?? '')) {
      errors.push(`${where}: '${ref}' needs a '# vX.Y.Z' version comment`);
    }
  });
  return errors;
}

/**
 * @param {string} text contents of the setup action.yml
 * @returns {string[]} problems
 */
export function checkSetupAction(text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {unknown} */
  const doc = parse(text);
  if (!isRecord(doc)) return [`${SETUP_ACTION}: not a YAML mapping`];
  const inputs = isRecord(doc.inputs) ? doc.inputs : {};
  const nodeInput = inputs['node-version'];
  const depthInput = inputs['fetch-depth'];
  if (!isRecord(nodeInput) || String(nodeInput.default) !== '22') {
    errors.push(`${SETUP_ACTION}: input 'node-version' must default to 22`);
  }
  if (!isRecord(depthInput) || String(depthInput.default) !== '0') {
    errors.push(`${SETUP_ACTION}: input 'fetch-depth' must default to 0`);
  }
  const runs = isRecord(doc.runs) ? doc.runs : {};
  if (runs.using !== 'composite') errors.push(`${SETUP_ACTION}: must be a composite action`);
  const steps = Array.isArray(runs.steps) ? runs.steps.filter((s) => isRecord(s)) : [];
  /** @param {Record<string, unknown>} s */
  const uses = (s) => (typeof s.uses === 'string' ? s.uses : '');
  /** @param {Record<string, unknown>} s */
  const run = (s) => (typeof s.run === 'string' ? s.run : '');

  const install = steps.find((s) => /\bpnpm install\b/.test(run(s)));
  if (install === undefined || !run(install).includes('--frozen-lockfile')) {
    errors.push(`${SETUP_ACTION}: must run 'pnpm install --frozen-lockfile'`);
  }
  for (const s of steps) {
    if (uses(s).startsWith('pnpm/action-setup')) {
      errors.push(
        `${SETUP_ACTION}: pnpm must come from Corepack + packageManager, not pnpm/action-setup`,
      );
    }
    const w = isRecord(s.with) ? s.with : {};
    if (uses(s).startsWith('actions/setup-node') && 'cache' in w) {
      errors.push(`${SETUP_ACTION}: setup-node 'cache' would bypass the fork-safe cache steps`);
    }
  }
  if (!steps.some((s) => run(s).includes('corepack enable') && run(s).includes('packageManager'))) {
    errors.push(`${SETUP_ACTION}: must enable Corepack and derive pnpm from packageManager`);
  }

  const cacheSteps = steps.filter((s) => uses(s).startsWith('actions/cache'));
  const turbo = cacheSteps.filter((s) => isRecord(s.with) && s.with.path === '.turbo');
  if (turbo.length === 0) errors.push(`${SETUP_ACTION}: no Turborepo (.turbo) cache step`);
  for (const s of turbo) {
    const w = isRecord(s.with) ? s.with : {};
    const key = typeof w.key === 'string' ? w.key : '';
    const restore = typeof w['restore-keys'] === 'string' ? w['restore-keys'] : '';
    if (!key.includes("hashFiles('pnpm-lock.yaml', 'turbo.json')")) {
      errors.push(`${SETUP_ACTION}: turbo cache key must hash pnpm-lock.yaml and turbo.json`);
    }
    if (!restore.includes('github.head_ref || github.ref_name')) {
      errors.push(`${SETUP_ACTION}: turbo restore-keys must fall back by branch`);
    }
  }
  if (
    !steps.some(
      (s) => isRecord(s.with) && typeof s.with.path === 'string' && s.with.path.includes('store'),
    )
  ) {
    errors.push(`${SETUP_ACTION}: no pnpm store cache step`);
  }
  // Fork safety: every saving cache step runs only for trusted runs, and forks get restore-only.
  for (const s of cacheSteps) {
    const cond = typeof s.if === 'string' ? s.if : '';
    const restoreOnly = uses(s).startsWith('actions/cache/restore@');
    if (!restoreOnly && !cond.includes("fork != 'true'")) {
      errors.push(
        `${SETUP_ACTION}: cache step '${String(s.name)}' can save on forked pull requests`,
      );
    }
  }
  if (!cacheSteps.some((s) => uses(s).startsWith('actions/cache/restore@'))) {
    errors.push(`${SETUP_ACTION}: forked pull requests need a restore-only cache path`);
  }
  if (/\$\{\{\s*secrets\./.test(text)) errors.push(`${SETUP_ACTION}: must not reference secrets`);
  return errors;
}

/**
 * @param {string} root repository root
 * @returns {string[]} problems
 */
export function checkRepo(root) {
  /** @type {string[]} */
  const files = [];
  const wfDir = path.join(root, '.github', 'workflows');
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (/\.ya?ml$/.test(f)) files.push(path.join('.github', 'workflows', f));
    }
  }
  const actionsDir = path.join(root, '.github', 'actions');
  if (existsSync(actionsDir)) {
    for (const d of readdirSync(actionsDir)) {
      for (const name of ['action.yml', 'action.yaml']) {
        if (existsSync(path.join(actionsDir, d, name)))
          files.push(path.join('.github', 'actions', d, name));
      }
    }
  }
  const errors = files.flatMap((f) => checkPins(f, readFileSync(path.join(root, f), 'utf8')));
  const setup = path.join(root, SETUP_ACTION);
  if (existsSync(setup)) errors.push(...checkSetupAction(readFileSync(setup, 'utf8')));
  else errors.push(`${SETUP_ACTION}: missing`);
  return errors;
}

/** @param {string[]} argv */
export function main(argv) {
  const rootFlag = argv.indexOf('--root');
  const root =
    rootFlag >= 0 && argv[rootFlag + 1] !== undefined
      ? path.resolve(argv[rootFlag + 1] ?? '')
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkRepo(root);
  for (const e of errors) process.stderr.write(`check-actions: ${e}\n`);
  if (errors.length === 0) process.stdout.write('check-actions: ok\n');
  return errors.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
