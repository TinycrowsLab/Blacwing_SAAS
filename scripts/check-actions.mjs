#!/usr/bin/env node
// Checks GitHub Actions supply-chain and caching policy (CI-001, #135):
// - every third-party `uses:` in .github/workflows/*.yml and .github/actions/*/action.yml is
//   pinned to a full 40-character commit SHA with a `# vX.Y.Z` version comment (§8.9);
// - the reusable setup composite action (.github/actions/setup) installs with
//   `--frozen-lockfile`, derives pnpm only from package.json "packageManager" (Corepack),
//   keys the Turborepo cache on pnpm-lock.yaml + turbo.json with a branch fallback, keeps
//   caches restore-only on forked pull requests, and references no secrets;
// - the pull-request workflow (.github/workflows/pr.yml, CI-002 #136) keeps the stable required
//   check names `lint`, `typecheck`, `commitlint` and `boundaries` (no matrix), runs on pull_request and push to
//   main with read-only permissions and cancel-in-progress concurrency, uses the setup action and
//   the problem matchers, gates docs-only skips fail-closed, and references no secrets; every
//   ESLint script enforces zero warnings.
//
// Usage: node scripts/check-actions.mjs [--root <dir>]
// Exits non-zero (listing every problem) when the policy is not met.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const SETUP_ACTION = '.github/actions/setup/action.yml';
export const PR_WORKFLOW = '.github/workflows/pr.yml';
/** Required status checks referenced by branch protection (CI-019); job id = check name. */
export const REQUIRED_CHECKS = Object.freeze(['lint', 'typecheck', 'commitlint', 'boundaries']);
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
 * @param {string} text contents of .github/workflows/pr.yml
 * @returns {string[]} problems
 */
export function checkPrWorkflow(text) {
  const W = PR_WORKFLOW;
  /** @type {string[]} */
  const errors = [];
  /** @type {unknown} */
  const doc = parse(text);
  if (!isRecord(doc)) return [`${W}: not a YAML mapping`];
  // YAML 1.1 parsers read a bare `on` key as boolean true; the `yaml` package keeps the string.
  const on = isRecord(doc.on) ? doc.on : {};
  if (!('pull_request' in on)) errors.push(`${W}: must run on pull_request`);
  if ('pull_request_target' in on) {
    errors.push(`${W}: pull_request_target would run fork code with a write token`);
  }
  const push = isRecord(on.push) ? on.push : {};
  if (!Array.isArray(push.branches) || !push.branches.includes('main')) {
    errors.push(`${W}: must run on push to main`);
  }
  if (
    'paths' in push ||
    'paths-ignore' in push ||
    (isRecord(on.pull_request) && ('paths' in on.pull_request || 'paths-ignore' in on.pull_request))
  ) {
    errors.push(
      `${W}: trigger path filters leave required checks pending; skip inside jobs instead`,
    );
  }
  const perms = doc.permissions;
  if (!isRecord(perms) || Object.keys(perms).join() !== 'contents' || perms.contents !== 'read') {
    errors.push(`${W}: permissions must be exactly 'contents: read'`);
  }
  const conc = isRecord(doc.concurrency) ? doc.concurrency : {};
  if (conc['cancel-in-progress'] !== true) errors.push(`${W}: concurrency must cancel-in-progress`);
  if (typeof conc.group !== 'string' || !conc.group.includes('github.ref')) {
    errors.push(`${W}: concurrency group must be per ref`);
  }
  const env = isRecord(doc.env) ? doc.env : {};
  if (String(env.NODE_VERSION) !== '22') errors.push(`${W}: NODE_VERSION must be 22`);
  const jobs = isRecord(doc.jobs) ? doc.jobs : {};
  for (const id of REQUIRED_CHECKS) {
    const job = jobs[id];
    if (!isRecord(job)) {
      errors.push(`${W}: required check job '${id}' is missing`);
      continue;
    }
    if (job.name !== id) errors.push(`${W}: job '${id}' must be named '${id}' (stable check name)`);
    if (isRecord(job.strategy) && 'matrix' in job.strategy) {
      errors.push(`${W}: job '${id}' must not use a matrix (it renames the check)`);
    }
    if ('permissions' in job) errors.push(`${W}: job '${id}' must not widen permissions`);
    const steps = Array.isArray(job.steps) ? job.steps.filter((s) => isRecord(s)) : [];
    const setup = steps.find((s) => s.uses === './.github/actions/setup');
    if (setup === undefined) {
      errors.push(`${W}: job '${id}' must use ./.github/actions/setup`);
    } else if (!isRecord(setup.with) || setup.with['node-version'] !== '${{ env.NODE_VERSION }}') {
      errors.push(`${W}: job '${id}' must pass node-version: \${{ env.NODE_VERSION }}`);
    }
    const runs = steps.map((s) => (typeof s.run === 'string' ? s.run : '')).join('\n');
    const matchers = steps.some((s) => s.uses === './.github/actions/problem-matchers');
    if (id === 'lint') {
      if (!runs.includes('pnpm lint 2>&1 | node scripts/ci-annotate.mjs')) {
        errors.push(`${W}: lint must pipe 'pnpm lint' through scripts/ci-annotate.mjs`);
      }
      if (!runs.includes('pnpm format:check'))
        errors.push(`${W}: lint must run 'pnpm format:check'`);
    }
    if (
      id === 'typecheck' &&
      !runs.includes('pnpm typecheck 2>&1 | node scripts/ci-annotate.mjs')
    ) {
      errors.push(`${W}: typecheck must pipe 'pnpm typecheck' through scripts/ci-annotate.mjs`);
    }
    if (id !== 'commitlint') {
      if (!matchers) errors.push(`${W}: job '${id}' must register the problem matchers`);
      if (!runs.includes('set -o pipefail')) {
        errors.push(
          `${W}: job '${id}' must 'set -o pipefail' so the annotator keeps the exit code`,
        );
      }
    }
    if (id === 'boundaries') {
      if (!runs.includes('pnpm boundaries:report')) {
        errors.push(`${W}: boundaries must run 'pnpm boundaries:report'`);
      }
      if ('needs' in job || 'if' in job) {
        errors.push(`${W}: boundaries must never be skipped (docs-only edits must fail it)`);
      }
    }
    if (id === 'commitlint') {
      if (!runs.includes('node scripts/ci-pr.mjs commitlint')) {
        errors.push(`${W}: commitlint must run 'node scripts/ci-pr.mjs commitlint'`);
      }
      if (!isRecord(setup?.with) || String(setup.with['fetch-depth']) !== '0') {
        errors.push(`${W}: commitlint needs full history (fetch-depth: '0')`);
      }
      if ('needs' in job || 'if' in job) {
        errors.push(`${W}: commitlint must never be skipped`);
      }
    }
    // A skipped job satisfies a required check, so a skip must only follow a proven docs-only
    // classification, never a failed or missing one.
    const cond = typeof job.if === 'string' ? job.if : '';
    if (
      cond !== '' &&
      (!cond.includes('!cancelled()') || /outputs\.code\s*==\s*'true'/.test(cond))
    ) {
      errors.push(
        `${W}: job '${id}' condition must be fail-closed (!cancelled() and code != 'false')`,
      );
    }
  }
  if (/\$\{\{\s*secrets\./.test(text)) errors.push(`${W}: must not reference secrets`);
  return errors;
}

/**
 * Every ESLint script (root and members) must fail on warnings.
 * @param {string} root
 * @returns {string[]} problems
 */
export function checkZeroWarnings(root) {
  /** @type {string[]} */
  const errors = [];
  const manifests = existsSync(path.join(root, 'package.json')) ? ['package.json'] : [];
  for (const group of ['apps', 'packages']) {
    const abs = path.join(root, group);
    if (!existsSync(abs)) continue;
    for (const d of readdirSync(abs)) {
      if (existsSync(path.join(abs, d, 'package.json')))
        manifests.push(`${group}/${d}/package.json`);
    }
  }
  for (const rel of manifests) {
    /** @type {unknown} */
    const pkg = JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
    const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string' || !/^lint(:root)?$/.test(name) || !/\beslint\b/.test(cmd))
        continue;
      if (!cmd.includes('--max-warnings=0')) {
        errors.push(`${rel}: script '${name}' must run eslint with --max-warnings=0`);
      }
    }
  }
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
  const pr = path.join(root, PR_WORKFLOW);
  if (existsSync(pr)) errors.push(...checkPrWorkflow(readFileSync(pr, 'utf8')));
  else errors.push(`${PR_WORKFLOW}: missing`);
  errors.push(...checkZeroWarnings(root));
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
