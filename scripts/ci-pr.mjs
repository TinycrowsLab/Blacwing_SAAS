#!/usr/bin/env node
// Helpers for the pull-request workflow (.github/workflows/pr.yml, CI-002 #136).
//
//   node scripts/ci-pr.mjs changes     classify the change set; writes `code=true|false` to
//                                      $GITHUB_OUTPUT. `false` only when every changed file is
//                                      documentation, so the typecheck job and the ESLint step can
//                                      skip. Any doubt (unknown event, missing commit, git error)
//                                      yields `true`: the gate fails closed, never open.
//   node scripts/ci-pr.mjs commitlint  lint every commit in the PR (or pushed) range with the
//                                      repository commitlint config. Outside GitHub Actions it lints
//                                      `origin/main..HEAD`.
//
// The commit range comes from the event, read from the environment the workflow sets:
//   EVENT_NAME (github.event_name), BASE_SHA / HEAD_SHA (pull_request.base.sha / head.sha),
//   BEFORE_SHA / AFTER_SHA (push before / after).
// Only node: built-ins are used so the `changes` job needs no `pnpm install`.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO_SHA = /^0+$/;

/**
 * Paths whose changes can never affect lint or typecheck results. Prettier still checks them
 * (the `lint` job's format step always runs), so only ESLint and tsc skip on docs-only changes.
 */
export const DOCS_ONLY_PATTERNS = Object.freeze([/^docs\//, /\.md$/i, /^LICENSE$/]);

/**
 * @param {readonly string[]} files repo-relative changed paths
 * @returns {boolean} true only for a non-empty list made entirely of documentation
 */
export function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => DOCS_ONLY_PATTERNS.some((re) => re.test(f)));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string }}
 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout };
}

/**
 * @param {string} cwd
 * @param {string | undefined} sha
 * @returns {sha is string}
 */
function isCommit(cwd, sha) {
  if (sha === undefined || sha === '' || ZERO_SHA.test(sha)) return false;
  return git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/**
 * The commit range of the triggering event.
 * @param {string} cwd repository working tree
 * @param {Record<string, string | undefined>} env
 * @returns {{ from: string, to: string } | { last: true }} `last` = only the tip commit is known
 */
export function commitRange(cwd, env) {
  const event = env.EVENT_NAME ?? '';
  if (event === 'pull_request') {
    const { BASE_SHA: from, HEAD_SHA: to } = env;
    if (isCommit(cwd, from) && isCommit(cwd, to)) return { from, to };
    throw new Error('pull_request event without fetchable base/head commits (fetch-depth: 0?)');
  }
  if (event === 'push') {
    const to = isCommit(cwd, env.AFTER_SHA) ? env.AFTER_SHA : 'HEAD';
    // A new branch (zero `before`) or a force push (unreachable `before`): only the tip is known.
    if (isCommit(cwd, env.BEFORE_SHA)) return { from: env.BEFORE_SHA, to };
    return { last: true };
  }
  return { from: 'origin/main', to: 'HEAD' };
}

/**
 * Repo-relative files changed by the triggering event, or null when they cannot be determined.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {string[] | null}
 */
export function changedFiles(cwd, env) {
  /** @type {{ from: string, to: string } | { last: true }} */
  let range;
  try {
    range = commitRange(cwd, env);
  } catch {
    return null;
  }
  if (!('from' in range)) return null;
  const r = git(cwd, ['diff', '--name-only', '--no-renames', `${range.from}...${range.to}`]);
  if (!r.ok) return null;
  return r.stdout.split('\n').filter((l) => l !== '');
}

/**
 * Fail-closed classification: `false` only when the change set is known and docs-only.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {boolean} whether code checks (ESLint, tsc) must run
 */
export function codeChanged(cwd, env) {
  const files = changedFiles(cwd, env);
  return files === null || !isDocsOnly(files);
}

/**
 * commitlint CLI arguments for the event's range.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function commitlintArgs(cwd, env) {
  const range = commitRange(cwd, env);
  return 'from' in range
    ? ['--from', range.from, '--to', range.to, '--verbose']
    : ['--last', '--verbose'];
}

/**
 * Runs commitlint over the event's commit range.
 * @param {{ cwd: string, env: Record<string, string | undefined>, bin: string, config?: string }} options
 *   `bin` is the commitlint executable; `config` overrides the config file (tests).
 * @returns {number} exit status
 */
export function runCommitlint({ cwd, env, bin, config }) {
  const args = commitlintArgs(cwd, env);
  if (config !== undefined) args.push('--config', config);
  const r = spawnSync(bin, args, { cwd, stdio: 'inherit' });
  return r.status ?? 1;
}

/** @param {string[]} argv */
function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cwd = process.cwd();
  const env = { ...process.env };
  const command = argv[0];
  if (command === 'changes') {
    const code = codeChanged(cwd, env);
    const out = env.GITHUB_OUTPUT;
    if (out !== undefined && out !== '') appendFileSync(out, `code=${String(code)}\n`);
    process.stdout.write(
      code ? 'code changes: lint and typecheck run\n' : 'docs-only change: ESLint and tsc skip\n',
    );
    return 0;
  }
  if (command === 'commitlint') {
    const bin = path.join(root, 'node_modules', '.bin', 'commitlint');
    return runCommitlint({ cwd, env, bin });
  }
  process.stderr.write('usage: ci-pr.mjs <changes|commitlint>\n');
  return 2;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
