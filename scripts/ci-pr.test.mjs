// Tests for the pull-request workflow helpers (scripts/ci-pr.mjs, CI-002 #136): the fail-closed
// docs-only classifier and the commitlint range, against throwaway git repositories, with the real
// commitlint binary and repository config.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  changedFiles,
  codeChanged,
  commitRange,
  commitlintArgs,
  isDocsOnly,
  runCommitlint,
} from './ci-pr.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const COMMITLINT = path.join(REPO_ROOT, 'node_modules', '.bin', 'commitlint');
const CONFIG = path.join(REPO_ROOT, 'commitlint.config.mjs');
const ZERO = '0000000000000000000000000000000000000000';

/** @type {string} */
let repo;

/**
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function git(args) {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HUSKY: '0',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/**
 * Commits one file change.
 * @param {string} file
 * @param {string} message
 * @returns {string} the new commit SHA
 */
function commit(file, message) {
  const abs = path.join(repo, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${message}\n`);
  git(['add', file]);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'bw-ci-pr-'));
  git(['init', '-q', '-b', 'main']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('isDocsOnly', () => {
  it('is true only for a non-empty, all-documentation change set', () => {
    assert.equal(isDocsOnly(['docs/runbooks/ci.md', 'README.md', 'packages/ids/README.md']), true);
    assert.equal(isDocsOnly(['LICENSE', 'docs/architecture/blackwing-architecture.html']), true);
    assert.equal(isDocsOnly(['docs/x.md', 'packages/ids/src/index.ts']), false);
    assert.equal(isDocsOnly(['.github/workflows/pr.yml']), false);
    assert.equal(isDocsOnly(['package.json']), false);
    assert.equal(isDocsOnly([]), false);
  });
});

describe('commitRange', () => {
  it('uses the pull request base and head SHAs', () => {
    const base = commit('a.ts', 'feat: base');
    const head = commit('b.ts', 'feat: head');
    assert.deepEqual(
      commitRange(repo, { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head }),
      {
        from: base,
        to: head,
      },
    );
  });

  it('refuses a pull request whose commits are not fetched', () => {
    commit('a.ts', 'feat: base');
    assert.throws(
      () =>
        commitRange(repo, {
          EVENT_NAME: 'pull_request',
          BASE_SHA: 'f'.repeat(40),
          HEAD_SHA: 'HEAD',
        }),
      /fetch-depth/,
    );
  });

  it('uses before..after on push, and only the tip for a new branch or a force push', () => {
    const before = commit('a.ts', 'feat: one');
    const after = commit('b.ts', 'feat: two');
    assert.deepEqual(
      commitRange(repo, { EVENT_NAME: 'push', BEFORE_SHA: before, AFTER_SHA: after }),
      {
        from: before,
        to: after,
      },
    );
    assert.deepEqual(
      commitRange(repo, { EVENT_NAME: 'push', BEFORE_SHA: ZERO, AFTER_SHA: after }),
      {
        last: true,
      },
    );
    assert.deepEqual(
      commitRange(repo, { EVENT_NAME: 'push', BEFORE_SHA: 'e'.repeat(40), AFTER_SHA: after }),
      { last: true },
    );
    assert.deepEqual(commitlintArgs(repo, { EVENT_NAME: 'push', BEFORE_SHA: ZERO }), [
      '--last',
      '--verbose',
    ]);
  });

  it('defaults to origin/main..HEAD outside GitHub Actions', () => {
    assert.deepEqual(commitRange(repo, {}), { from: 'origin/main', to: 'HEAD' });
  });
});

describe('codeChanged (fail-closed docs-only skip)', () => {
  it('skips code checks only for a proven docs-only pull request', () => {
    const base = commit('src/a.ts', 'feat: base');
    const docs = commit('docs/guide.md', 'docs: guide');
    const env = { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: docs };
    assert.deepEqual(changedFiles(repo, env), ['docs/guide.md']);
    assert.equal(codeChanged(repo, env), false);
    const code = commit('src/b.ts', 'feat: code');
    assert.equal(codeChanged(repo, { ...env, HEAD_SHA: code }), true);
  });

  it('runs every check when the change set cannot be determined', () => {
    const tip = commit('docs/guide.md', 'docs: guide');
    assert.equal(codeChanged(repo, { EVENT_NAME: 'push', BEFORE_SHA: ZERO, AFTER_SHA: tip }), true);
    assert.equal(
      codeChanged(repo, { EVENT_NAME: 'pull_request', BASE_SHA: '', HEAD_SHA: tip }),
      true,
    );
    // origin/main does not exist in this repository: the diff fails, so the gate stays closed.
    assert.equal(codeChanged(repo, {}), true);
  });
});

describe('a non-conventional commit fails commitlint', () => {
  it('fails the range when any PR commit is not a Conventional Commit', () => {
    const base = commit('a.ts', 'chore: base');
    commit('b.ts', 'feat(ids): add a prefix');
    const head = commit('c.ts', 'Fixed some stuff');
    const env = { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head };
    const status = runCommitlint({ cwd: repo, env, bin: COMMITLINT, config: CONFIG });
    assert.notEqual(status, 0);
  });

  it('passes a range of conventional commits', () => {
    const base = commit('a.ts', 'Initial import, not linted: outside the range');
    commit('b.ts', 'feat(ids): add a prefix');
    const head = commit('c.ts', 'fix(time): handle leap seconds');
    const env = { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head };
    assert.equal(runCommitlint({ cwd: repo, env, bin: COMMITLINT, config: CONFIG }), 0);
  });

  it('lints the pushed tip when only the tip is known', () => {
    const tip = commit('a.ts', 'updated things');
    const env = { EVENT_NAME: 'push', BEFORE_SHA: ZERO, AFTER_SHA: tip };
    assert.notEqual(runCommitlint({ cwd: repo, env, bin: COMMITLINT, config: CONFIG }), 0);
  });
});
