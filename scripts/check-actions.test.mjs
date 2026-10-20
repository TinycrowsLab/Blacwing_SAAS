// Tests for the GitHub Actions policy checker (CI-001, #135) and the real setup action.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { SETUP_ACTION, checkPins, checkRepo, checkSetupAction, main } from './check-actions.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const realSetup = () => readFileSync(path.join(REPO_ROOT, SETUP_ACTION), 'utf8');

describe('checkPins', () => {
  it('accepts SHA pins with a version comment and local actions', () => {
    const text = [
      `      - uses: actions/checkout@${SHA} # v7.0.1`,
      '      - uses: ./.github/actions/setup',
      `        uses: actions/cache/restore@${SHA} # v6.1.0`,
    ].join('\n');
    assert.deepEqual(checkPins('wf.yml', text), []);
  });

  it('rejects tag and branch refs', () => {
    const errors = checkPins(
      'wf.yml',
      '- uses: actions/checkout@v4\n- uses: "actions/setup-node@main"',
    );
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? '', /wf\.yml:1: 'actions\/checkout@v4' is not pinned/);
  });

  it('rejects short SHAs and a SHA without a version comment', () => {
    assert.match(checkPins('a', '- uses: actions/checkout@3d3c42e').join(), /not pinned/);
    assert.match(checkPins('a', `- uses: actions/checkout@${SHA}`).join(), /version comment/);
  });
});

describe('checkSetupAction (real action)', () => {
  it('meets the policy', () => {
    assert.deepEqual(checkSetupAction(realSetup()), []);
  });

  it('defaults node-version to 22 and fetch-depth to 0', () => {
    const text = realSetup();
    assert.match(
      checkSetupAction(text.replace("default: '22'", "default: '20'")).join(),
      /node-version/,
    );
    assert.match(
      checkSetupAction(text.replace("default: '0'", "default: '1'")).join(),
      /fetch-depth/,
    );
  });

  // Edge case: lockfile drift must fail the job.
  it('requires --frozen-lockfile', () => {
    const drift = realSetup().replaceAll('pnpm install --frozen-lockfile', 'pnpm install');
    assert.match(checkSetupAction(drift).join(), /frozen-lockfile/);
  });

  // Edge case: Corepack/pnpm version mismatch, so pnpm comes only from packageManager.
  it('derives pnpm only from packageManager', () => {
    const text = realSetup();
    assert.match(text, /\[ "pnpm@\$\{pnpm_v\}" != "\$\{pm%%\+\*\}" \]/);
    const withAction = text.replace(
      '    - name: Classify cache trust',
      `    - uses: pnpm/action-setup@${SHA} # v4.0.0\n    - name: Classify cache trust`,
    );
    assert.match(checkSetupAction(withAction).join(), /Corepack/);
    const noCorepack = text.replace('corepack enable', 'npm i -g pnpm');
    assert.match(checkSetupAction(noCorepack).join(), /Corepack/);
  });

  // Edge case: cache poisoning across branches, forks never save caches.
  it('keeps caches restore-only on forked pull requests', () => {
    const text = realSetup();
    assert.match(
      checkSetupAction(text.replaceAll("fork != 'true'", "fork != 'x'")).join(),
      /can save on forked/,
    );
    const noRestoreOnly = text.replaceAll('actions/cache/restore@', 'actions/cache@');
    assert.match(checkSetupAction(noRestoreOnly).join(), /can save on forked|restore-only/);
    assert.match(text, /HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/);
  });

  // Edge case: partial cache restore; turbo keys hash the inputs that change task hashes,
  // and only fall back by branch, so a stale entry is a cache miss rather than a wrong result.
  it('keys the turbo cache on lockfile + turbo.json with branch fallback', () => {
    const text = realSetup();
    const noTurboJson = text.replaceAll(
      "hashFiles('pnpm-lock.yaml', 'turbo.json')",
      "hashFiles('pnpm-lock.yaml')",
    );
    assert.match(checkSetupAction(noTurboJson).join(), /turbo\.json/);
    const noBranch = text.replaceAll('-${{ github.head_ref || github.ref_name }}-\n', '-\n');
    assert.match(checkSetupAction(noBranch).join(), /fall back by branch/);
  });

  it('references no secrets', () => {
    const leaky = realSetup().replace(
      "COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'",
      'TOKEN: ${{ secrets.X }}',
    );
    assert.match(checkSetupAction(leaky).join(), /secrets/);
  });

  it('prints resolved versions and cache hit/miss', () => {
    const text = realSetup();
    assert.match(text, /Resolved Node\.js \$\{node_v\}, pnpm \$\{pnpm_v\}/);
    assert.match(text, /pnpm store cache: hit/);
    assert.match(text, /turbo cache: miss/);
  });
});

describe('checkRepo / main', () => {
  it('passes on the repository', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
    assert.equal(main(['--root', REPO_ROOT]), 0);
  });

  it('fails a repo with an unpinned workflow and no setup action', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-actions-'));
    try {
      mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        path.join(dir, '.github', 'workflows', 'x.yml'),
        'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n',
      );
      const errors = checkRepo(dir);
      assert.ok(errors.some((e) => e.includes('x.yml:4')));
      assert.ok(errors.some((e) => e.includes('missing')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
