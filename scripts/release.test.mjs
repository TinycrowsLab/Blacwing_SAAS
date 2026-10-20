// Tests for the release helpers and workflow wiring (CI-016, #150).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

import releaseConfig, { ANALYZER, TAG_FORMAT } from '../release.config.mjs';
import { buildRecord, bump, main, plan, planSummary, recordSummary } from './release.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const dirs = /** @type {string[]} */ ([]);
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const vcs = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });

/** Scratch repository whose commits are created in order. */
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-release-'));
  dirs.push(dir);
  vcs(dir, ['init', '-q', '-b', 'main']);
  vcs(dir, ['config', 'commit.gpgsign', 'false']);
  let n = 0;
  return {
    dir,
    /** @param {string} message */
    commit(message) {
      n += 1;
      writeFileSync(path.join(dir, 'f.txt'), String(n));
      vcs(dir, ['add', '-A']);
      vcs(dir, ['commit', '-q', '-m', message]);
    },
    /** @param {string} name */
    tag(name) {
      vcs(dir, ['tag', name]);
    },
  };
}

describe('bump', () => {
  it('bumps each level and resets lower parts', () => {
    assert.equal(bump('1.2.3', 'patch'), '1.2.4');
    assert.equal(bump('1.2.3', 'minor'), '1.3.0');
    assert.equal(bump('1.2.3', 'major'), '2.0.0');
  });
  it('rejects a non-semver version', () => {
    assert.throws(() => bump('1.2', 'patch'), /not a semantic version/);
  });
});

describe('plan (scratch repository sequences)', () => {
  it('feat produces a minor release', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.4.2');
    r.commit('feat(api): add runs endpoint');
    const p = await plan(r.dir);
    assert.deepEqual([p.current, p.next, p.type], ['1.4.2', '1.5.0', 'minor']);
  });

  it('fix produces a patch release', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.4.2');
    r.commit('fix(db): close pool on shutdown');
    assert.equal((await plan(r.dir)).next, '1.4.3');
  });

  it('a "!" marker produces a major release', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.4.2');
    r.commit('feat(api)!: drop v1 routes');
    assert.equal((await plan(r.dir)).next, '2.0.0');
  });

  it('a BREAKING CHANGE footer produces a major release', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.4.2');
    r.commit('fix(api): rename field\n\nBREAKING CHANGE: the field id is now run_id');
    assert.equal((await plan(r.dir)).next, '2.0.0');
  });

  it('the highest bump in a mixed sequence wins', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v0.9.0');
    r.commit('fix: a');
    r.commit('feat: b');
    r.commit('docs: c');
    assert.equal((await plan(r.dir)).next, '0.10.0');
  });

  it('a revert releases a patch', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.0.0');
    r.commit('revert: feat(api): add runs endpoint\n\nThis reverts commit abc1234.');
    assert.equal((await plan(r.dir)).next, '1.0.1');
  });

  it('no releasable commits releases nothing', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.0.0');
    r.commit('docs: update readme');
    r.commit('ci: tweak cache');
    r.commit('chore(deps): bump x');
    const p = await plan(r.dir);
    assert.equal(p.next, null);
    assert.match(planSummary(p), /No releasable commits/);
  });

  it('the first release is 1.0.0 and only counts commits after the last tag', async () => {
    const r = scratch();
    r.commit('feat: first');
    assert.equal((await plan(r.dir)).next, '1.0.0');
    r.tag('v1.0.0');
    r.commit('fix: later');
    r.tag('not-a-release');
    assert.equal((await plan(r.dir)).next, '1.0.1');
  });

  it('picks the highest semantic tag, not the lexical one', async () => {
    const r = scratch();
    r.commit('chore: init');
    r.tag('v1.9.0');
    r.tag('v1.10.0');
    r.commit('fix: x');
    assert.equal((await plan(r.dir)).next, '1.10.1');
  });

  it('the dry run never creates a tag', async () => {
    const r = scratch();
    r.commit('feat: first');
    await plan(r.dir);
    assert.equal(vcs(r.dir, ['tag']).trim(), '');
    assert.match(planSummary(await plan(r.dir)), /dry run: no tag/);
  });

  it('the CLI writes the step summary and outputs', async () => {
    const r = scratch();
    r.commit('feat: first');
    const summary = path.join(r.dir, '..', `${path.basename(r.dir)}.summary`);
    const out = path.join(r.dir, '..', `${path.basename(r.dir)}.out`);
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      assert.equal(
        await main(['plan', '--cwd', r.dir, '--summary', summary, '--github-output', out]),
        0,
      );
    } finally {
      process.stdout.write = write;
    }
    assert.match(readFileSync(summary, 'utf8'), /v1\.0\.0/);
    assert.equal(readFileSync(out, 'utf8'), 'next=1.0.0\nreleasable=true\n');
    rmSync(summary);
    rmSync(out);
  });
});

describe('release record (tag and image digests align)', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const sha = 'b'.repeat(40);
  const images = {
    api: `ghcr.io/tinycrowslab/bw-api@${digest}`,
    web: `ghcr.io/tinycrowslab/bw-web@${digest}`,
  };

  it('records the tag, commit and pinned digests', () => {
    const rec = buildRecord('1.5.0', sha, images);
    assert.equal(rec.tag, 'v1.5.0');
    assert.deepEqual(rec.images, images);
    assert.match(recordSummary(rec), /bw-api@sha256/);
  });

  it('rejects tag-only images, bad versions and short commits', () => {
    assert.throws(
      () => buildRecord('1.5.0', sha, { api: 'ghcr.io/tinycrowslab/bw-api:1.5.0' }),
      /not pinned by sha256 digest/,
    );
    assert.throws(() => buildRecord('v1.5.0', sha, images), /semantic version/);
    assert.throws(() => buildRecord('1.5.0', 'abc', images), /40-character/);
    assert.throws(() => buildRecord('1.5.0', sha, {}), /no images/);
    assert.throws(() => buildRecord('1.5.0', sha, []), /must be an object/);
  });
});

/**
 * @typedef {{ if?: string, permissions?: Record<string, string>, steps?: unknown[] }} Job
 * @typedef {{
 *   on: Record<string, unknown>,
 *   permissions: Record<string, string>,
 *   concurrency: { group: string },
 *   jobs: { 'dry-run': Job, release: Job },
 * }} Workflow
 */

describe('configuration and workflow wiring', () => {
  const workflowText = readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  /** @type {unknown} */
  const parsed = parse(workflowText);
  const workflow = /** @type {Workflow} */ (parsed);
  const plugins = /** @type {[string, Record<string, unknown>][]} */ (
    /** @type {unknown} */ (releaseConfig.plugins)
  );

  it('uses one repository version tagged vX.Y.Z on main with the shared analyzer', () => {
    assert.equal(TAG_FORMAT, 'v${version}');
    assert.deepEqual(releaseConfig.branches, ['main']);
    const analyzer = plugins.find((p) => p[0] === '@semantic-release/commit-analyzer');
    assert.deepEqual(analyzer?.[1], ANALYZER);
    assert.equal(ANALYZER.preset, 'conventionalcommits');
  });

  it('commits the changelog with [skip ci] and publishes nothing to npm', () => {
    const committer = plugins.find((p) => p[0] === '@semantic-release/git');
    assert.match(String(committer?.[1].message), /\[skip ci\]/);
    assert.ok(!plugins.some((p) => p[0].includes('npm')));
  });

  it('runs a dry run on pull requests and releases only from trusted main', () => {
    assert.ok('pull_request' in workflow.on);
    assert.equal(workflow.jobs['dry-run'].if, "github.event_name == 'pull_request'");
    const gate = workflow.jobs.release.if ?? '';
    assert.match(gate, /github\.event_name != 'pull_request'/);
    assert.match(gate, /vars\.BW_ONLINE == 'true'/);
    assert.match(gate, /refs\/heads\/main/);
  });

  it('serialises releases and keeps least-privilege permissions', () => {
    assert.match(workflow.concurrency.group, /^release-/);
    assert.equal(workflow.permissions.contents, 'read');
    assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
    assert.equal(workflow.jobs['dry-run'].permissions, undefined);
    const dry = workflowText.slice(
      workflowText.indexOf('dry-run:'),
      workflowText.indexOf('\n  release:'),
    );
    assert.ok(!dry.includes('secrets.'));
  });

  it('hands the tag to build-images, which tags images with the release version', () => {
    const images = readFileSync(path.join(REPO_ROOT, '.github/workflows/build-images.yml'), 'utf8');
    assert.match(images, /tags: \['v\*'\]/);
    assert.match(images, /version="\$\{REF#refs\/tags\/v\}"/);
    const steps = JSON.stringify(workflow.jobs.release.steps);
    assert.match(steps, /build-images\.yml/);
    assert.match(steps, /release\.mjs record/);
  });
});
