// Tests for the staging deploy resolver and the deploy-staging workflow wiring (CI-017, #151).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

import { resolveDeployment } from './deploy-staging.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const dirs = /** @type {string[]} */ ([]);
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const COMMIT = 'a'.repeat(40);
const digest = (/** @type {string} */ c) => c.repeat(64);
const ref = (/** @type {string} */ service, /** @type {string} */ c) =>
  `ghcr.io/tinycrowslab/bw-${service}@sha256:${digest(c)}`;

/** A consistent release record and images.json for v1.2.3. */
const images = { web: ref('web', '1'), api: ref('api', '2'), worker: ref('worker', '3') };
const record = {
  version: '1.2.3',
  tag: 'v1.2.3',
  commit: COMMIT,
  images: { ...images },
};

/** @param {Record<string, unknown>} overrides */
const withRecord = (overrides) => ({ ...record, ...overrides });

describe('resolveDeployment', () => {
  it('returns the canonical release when the record and images.json agree', () => {
    const resolved = resolveDeployment('v1.2.3', record, images);
    assert.deepEqual(resolved, {
      version: '1.2.3',
      tag: 'v1.2.3',
      commit: COMMIT,
      images,
    });
  });

  it('refuses anything that is not a vX.Y.Z release tag', () => {
    for (const tag of ['latest', '1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3', 'main']) {
      assert.throws(() => resolveDeployment(tag, record, images), /not a release tag/, tag);
    }
  });

  it('refuses a record that belongs to another tag', () => {
    assert.throws(
      () => resolveDeployment('v1.2.4', record, images),
      /release record is for v1\.2\.3, not v1\.2\.4/,
    );
  });

  it('refuses a record whose version disagrees with its tag', () => {
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ version: '1.2.4' }), images),
      /release record version is not 1\.2\.3/,
    );
  });

  it('refuses a missing or malformed commit', () => {
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ commit: undefined }), images),
      /no commit/,
    );
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ commit: 'abc1234' }), images),
      /40-character sha/,
    );
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ commit: 'G'.repeat(40) }), images),
      /40-character sha/,
    );
  });

  it('refuses a record that is not an object or has no images', () => {
    assert.throws(() => resolveDeployment('v1.2.3', null, images), /JSON object/);
    assert.throws(() => resolveDeployment('v1.2.3', [record], images), /JSON object/);
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ images: 'x' }), images),
      /no images/,
    );
  });

  it('aborts when a digest in the record differs from images.json', () => {
    const tampered = { ...record, images: { ...images, api: ref('api', '9') } };
    assert.throws(() => resolveDeployment('v1.2.3', tampered, images), /disagree on api/);
  });

  it('aborts when the record and images.json list different services', () => {
    const extra = { ...record, images: { ...images, sandbox: ref('sandbox', '4') } };
    assert.throws(() => resolveDeployment('v1.2.3', extra, images), /disagree on sandbox/);

    const withoutWeb = Object.fromEntries(
      Object.entries(images).filter(([service]) => service !== 'web'),
    );
    assert.throws(() => resolveDeployment('v1.2.3', record, withoutWeb), /disagree on web/);
  });

  it('refuses a tag-only or foreign-registry image even when the record repeats it', () => {
    const tagOnly = { ...images, web: 'ghcr.io/tinycrowslab/bw-web:latest' };
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ images: tagOnly }), tagOnly),
      /not pinned by sha256 digest/,
    );
    const foreign = { ...images, web: `docker.io/evil/bw-web@sha256:${digest('5')}` };
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ images: foreign }), foreign),
      /is not the bw-web image in ghcr\.io\/tinycrowslab/,
    );
  });

  it('refuses a record that carries a tag where images.json has a digest', () => {
    const tagInRecord = {
      ...record,
      images: { ...images, web: 'ghcr.io/tinycrowslab/bw-web:v1.2.3' },
    };
    assert.throws(() => resolveDeployment('v1.2.3', tagInRecord, images), /disagree on web/);
  });

  it('refuses an empty images.json', () => {
    assert.throws(
      () => resolveDeployment('v1.2.3', withRecord({ images: {} }), {}),
      /lists no images/,
    );
  });
});

describe('deploy-staging resolve CLI', () => {
  /** @param {string} name */
  const scratch = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `bw-deploy-${name}-`));
    dirs.push(dir);
    return dir;
  };

  /** @param {string[]} args */
  const run = (args) => {
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'deploy-staging.mjs'), ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const e = /** @type {{ status: number, stdout: string, stderr: string }} */ (error);
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it('writes the tag, version and commit outputs and the digest table on success', () => {
    const dir = scratch('ok');
    const recordFile = path.join(dir, 'release-record.json');
    const imagesFile = path.join(dir, 'images.json');
    const out = path.join(dir, 'github-output');
    const summary = path.join(dir, 'summary.md');
    writeFileSync(recordFile, JSON.stringify(record));
    writeFileSync(imagesFile, JSON.stringify(images));

    const r = run([
      'resolve',
      '--tag',
      'v1.2.3',
      '--record',
      recordFile,
      '--images',
      imagesFile,
      '--github-output',
      out,
      '--summary',
      summary,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, 'utf8'), `tag=v1.2.3\nversion=1.2.3\ncommit=${COMMIT}\n`);
    assert.match(readFileSync(summary, 'utf8'), /### Release v1\.2\.3/);
    assert.match(
      readFileSync(summary, 'utf8'),
      new RegExp(images.api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('fails closed with no output when the record and images.json disagree', () => {
    const dir = scratch('bad');
    const recordFile = path.join(dir, 'release-record.json');
    const imagesFile = path.join(dir, 'images.json');
    const out = path.join(dir, 'github-output');
    writeFileSync(recordFile, JSON.stringify(record));
    writeFileSync(imagesFile, JSON.stringify({ ...images, web: ref('web', '7') }));

    const r = run([
      'resolve',
      '--tag',
      'v1.2.3',
      '--record',
      recordFile,
      '--images',
      imagesFile,
      '--github-output',
      out,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /disagree on web/);
    assert.throws(() => readFileSync(out, 'utf8'), /ENOENT/);
  });

  it('rejects a missing flag and an unknown subcommand', () => {
    assert.equal(run(['resolve', '--tag', 'v1.2.3']).status, 1);
    assert.equal(run(['deploy']).status, 1);
  });
});

/**
 * @typedef {{ name?: string, run?: string, uses?: string, if?: string, id?: string, with?: Record<string, string>, env?: Record<string, string> }} Step
 * @typedef {{ needs?: string | string[], environment?: { name: string }, uses?: string, with?: Record<string, string>, steps?: Step[] }} Job
 * @typedef {{ on: { release?: { types: string[] }, workflow_dispatch?: { inputs: Record<string, { required: boolean }> } }, concurrency: Record<string, string | boolean>, jobs: Record<string, Job> }} Workflow
 */

describe('deploy-staging workflow wiring', () => {
  const workflowText = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'deploy-staging.yml'),
    'utf8',
  );
  /** @type {unknown} */
  const parsed = parse(workflowText);
  const workflow = /** @type {Workflow} */ (parsed);
  const triggers = workflow.on;
  const jobs = workflow.jobs;
  /** @type {Job} */
  const deploy = jobs.deploy ?? {};
  const deploySteps = /** @type {Step[]} */ (deploy.steps ?? []);
  const resolveJob = /** @type {Job} */ (jobs.resolve);
  const verifyJob = /** @type {Job} */ (jobs.verify);
  const resolveSteps = /** @type {Step[]} */ (resolveJob.steps ?? []);
  /** @param {Step[]} steps @param {string} prefix */
  const step = (steps, prefix) => {
    const found = steps.find((s) => (s.name ?? '').startsWith(prefix));
    assert.ok(found, `no step starting with: ${prefix}`);
    return found;
  };
  /** @param {Step[]} steps @param {string} prefix */
  const indexOfStep = (steps, prefix) => steps.findIndex((s) => (s.name ?? '').startsWith(prefix));

  it('runs on a published release and on manual dispatch with a release tag', () => {
    assert.deepEqual(triggers.release?.types, ['published']);
    assert.equal(triggers.workflow_dispatch?.inputs.tag?.required, true);
  });

  it('never cancels a rollout and serialises staging deploys', () => {
    assert.equal(workflow.concurrency.group, 'deploy-staging');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('gates the deploy on the CI-011 signature verification and the release resolution', () => {
    assert.equal(verifyJob.uses, './.github/workflows/verify-images.yml');
    assert.deepEqual([deploy.needs ?? []].flat().sort(), ['resolve', 'verify']);
    assert.equal(verifyJob.with?.['images-artifact'], 'images.json');
  });

  it('deploys through the staging Environment only', () => {
    assert.equal(deploy.environment?.name, 'staging');
  });

  it('keeps every secret reference in an env mapping, never in a run script', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const s of job.steps ?? []) {
        assert.doesNotMatch(s.run ?? '', /secrets\./, `${name} run step references a secret`);
      }
    }
  });

  it('upgrades atomically with a timeout, from the digest-pinned values only', () => {
    const upgrade = step(deploySteps, 'Helm upgrade').run ?? '';
    assert.match(upgrade, /--atomic/);
    assert.match(upgrade, /--timeout 10m/);
    assert.match(upgrade, /values-staging\.yaml/);
    assert.match(upgrade, /bw-images\.yaml/);
    assert.doesNotMatch(upgrade, /--set|image\.tag|:latest/);
  });

  it('renders image values through the digest-only hand-off before any cluster change', () => {
    const render = indexOfStep(deploySteps, 'Render the digest-pinned');
    const dryRun = indexOfStep(deploySteps, 'Helm dry run');
    const upgrade = indexOfStep(deploySteps, 'Helm upgrade');
    assert.ok(render >= 0 && render < dryRun && dryRun < upgrade);
    assert.match(step(deploySteps, 'Render the digest-pinned').run ?? '', /helm-images\.mjs/);
  });

  it('runs the post-deploy smoke check and rolls back only when it fails', () => {
    assert.ok(
      indexOfStep(deploySteps, 'Post-deploy smoke check') >
        indexOfStep(deploySteps, 'Helm upgrade (atomic'),
    );
    const rollback = step(deploySteps, 'Roll back to the previous Helm revision');
    assert.match(rollback.if ?? '', /steps\.smoke\.outcome == 'failure'/);
    assert.match(rollback.run ?? '', /helm" rollback blackwing/);
  });

  it('pins the released commit and the Helm version it uses', () => {
    assert.equal(deploySteps[0]?.with?.ref, '${{ needs.resolve.outputs.commit }}');
    assert.match(step(deploySteps, 'Install Helm').run ?? '', /HELM_SHA256_AMD64/);
  });

  it('resolves the release before any artifact is passed on', () => {
    const names = resolveSteps.map((s) => s.name ?? s.uses ?? '');
    const resolveAt = names.findIndex((n) => n.startsWith('Resolve and cross-check'));
    const uploadAt = names.findIndex((n) => n.startsWith('actions/upload-artifact'));
    assert.ok(resolveAt >= 0 && resolveAt < uploadAt);
  });
});
