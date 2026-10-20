// Tests for the keyless signing helpers and the sign job wiring (CI-010, #144).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { SERVICES, WORKFLOW } from './check-images.mjs';
import {
  FULCIO_ISSUER,
  IDENTITY_FILE,
  loadIdentity,
  main,
  provenance,
  rekorIndexes,
  summaryLine,
} from './signing.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const DIGEST = `ghcr.io/tinycrowslab/bw-api@sha256:${'a'.repeat(64)}`;
const ENV = {
  GITHUB_REPOSITORY: 'TinycrowsLab/Blacwing_SAAS',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ID: '42',
  GITHUB_WORKFLOW_REF:
    'TinycrowsLab/Blacwing_SAAS/.github/workflows/build-images.yml@refs/heads/main',
};
/** @type {unknown} */
const rawConfig = JSON.parse(readFileSync(path.join(REPO_ROOT, IDENTITY_FILE), 'utf8'));
const config = /** @type {Record<string, unknown>} */ (rawConfig);

describe('signing identity', () => {
  const id = loadIdentity(config);
  const regexp = new RegExp(id.identityRegexp);
  const base = 'https://github.com/TinycrowsLab/Blacwing_SAAS/.github/workflows/build-images.yml';

  it('is valid, GitHub OIDC issuer, and names an existing workflow', () => {
    assert.deepEqual(id.errors, []);
    assert.equal(id.issuer, FULCIO_ISSUER);
    assert.equal(id.workflow, WORKFLOW);
  });

  it('matches only this repo and workflow on trusted refs', () => {
    assert.match(`${base}@refs/heads/main`, regexp);
    assert.match(`${base}@refs/tags/v1.2.3`, regexp);
    assert.doesNotMatch(`${base}@refs/heads/feature`, regexp);
    assert.doesNotMatch(`${base}@refs/pull/1/merge`, regexp);
    assert.doesNotMatch(`${base.replace('build-images', 'other')}@refs/heads/main`, regexp);
    assert.doesNotMatch(`${base.replace('Blacwing_SAAS', 'Evil')}@refs/heads/main`, regexp);
    assert.doesNotMatch(`${base}x@refs/heads/main`, regexp);
  });

  it('flags drift: missing workflow, bad issuer, no refs, bad repo', () => {
    const bad = loadIdentity({
      issuer: 'https://evil',
      repository: 'x',
      workflow: '.github/workflows/gone.yml',
      refs: [],
    });
    assert.equal(bad.errors.length, 4);
    const gone = loadIdentity({ ...config, workflow: '.github/workflows/gone.yml' });
    assert.ok(gone.errors.some((e) => e.includes('drift')));
    assert.ok(loadIdentity(null).errors.length > 0);
  });
});

describe('provenance', () => {
  it('builds a SLSA v1 predicate bound to repo, commit and run', () => {
    const p = JSON.stringify(provenance(DIGEST, ENV));
    assert.match(p, /buildtypes\/workflow\/v1/);
    assert.match(p, new RegExp(ENV.GITHUB_SHA));
    assert.match(p, /actions\/runs\/42\/attempts\/1/);
  });

  it('rejects tags and missing environment', () => {
    assert.throws(() => provenance('ghcr.io/x/bw-api:latest', ENV), /digest/);
    assert.throws(() => provenance(DIGEST, { ...ENV, GITHUB_SHA: '' }), /GITHUB_SHA/);
  });
});

describe('rekor + summary', () => {
  const verify = JSON.stringify([{ optional: { Bundle: { Payload: { logIndex: 123 } } } }, {}]);

  it('extracts log indexes and tolerates junk', () => {
    assert.deepEqual(rekorIndexes(verify), [123]);
    assert.deepEqual(rekorIndexes('nope'), []);
    assert.deepEqual(rekorIndexes('{}'), []);
  });

  it('summary links the Rekor entry and shows issuer + identity', () => {
    const l = summaryLine('api', DIGEST, [123], FULCIO_ISSUER, 'id');
    assert.match(l, /logIndex=123/);
    assert.match(l, /token\.actions\.githubusercontent\.com/);
  });
});

describe('main', () => {
  it('provenance, summary and failure paths set exit codes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sign-'));
    try {
      const out = path.join(dir, 'p.json');
      const ver = path.join(dir, 'v.json');
      const none = path.join(dir, 'none.json');
      const sum = path.join(dir, 's.md');
      writeFileSync(ver, JSON.stringify([{ optional: { Bundle: { Payload: { logIndex: 7 } } } }]));
      writeFileSync(none, '[]');
      assert.equal(main(['provenance', '--image', DIGEST, '--out', out], ENV), 0);
      assert.equal(main(['provenance', '--image', 'x:latest', '--out', out], ENV), 1);
      assert.equal(main(['provenance'], ENV), 2);
      const args = ['summary', '--service', 'api', '--image', DIGEST];
      assert.equal(main([...args, '--verify', ver, '--summary', sum]), 0);
      assert.match(readFileSync(sum, 'utf8'), /logIndex=7/);
      // An unlogged signature (Rekor outage) fails rather than shipping.
      assert.equal(main([...args, '--verify', none]), 1);
      assert.equal(main(['summary', '--service', 'api']), 2);
      assert.equal(main(['identity']), 0);
      assert.equal(main(['bogus']), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sign job in build-images workflow', () => {
  const text = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');
  /**
   * @typedef {{ needs: string | string[], if: string, permissions?: Record<string, string>,
   *   strategy: { matrix: { service: string[] } }, steps: { run?: string }[] }} Job
   */
  /** @type {unknown} */
  const rawWf = parse(text);
  const wf = /** @type {{ permissions: Record<string, string>, jobs: Record<string, Job> }} */ (
    rawWf
  );
  const job = /** @type {Job} */ (wf.jobs.sign);
  const run = job.steps.map((s) => s.run ?? '').join('\n');

  it('runs after sbom, online, on trusted non-fork events only', () => {
    assert.ok([job.needs].flat().includes('sbom'));
    assert.match(job.if, /BW_ONLINE == 'true'/);
    assert.match(job.if, /github\.event_name != 'pull_request'/);
    assert.match(job.if, /fork == false/);
    assert.ok(!text.includes('pull_request_target'));
  });

  it('scopes id-token: write to the sign job alone', () => {
    assert.equal(job.permissions?.['id-token'], 'write');
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (name !== 'sign') assert.notEqual(j.permissions?.['id-token'], 'write', name);
    }
    assert.equal(wf.permissions['id-token'], undefined);
  });

  it('signs every service by digest, never by tag, keyless', () => {
    assert.deepEqual([...job.strategy.matrix.service].sort(), [...SERVICES].sort());
    assert.match(run, /images\.json/);
    assert.match(run, /\*@sha256:\*\)/);
    assert.match(run, /cosign sign "\$ref"/);
    assert.ok(!/--key\b|COSIGN_PRIVATE_KEY/.test(text));
  });

  it('attests SBOM + provenance, then verifies against the shared identity', () => {
    assert.match(run, /cosign attest --type cyclonedx/);
    assert.match(run, /cosign attest --type slsaprovenance1/);
    assert.match(run, /cosign verify --certificate-identity-regexp "\$IDENTITY_REGEXP"/);
    assert.match(run, /--certificate-oidc-issuer "\$ISSUER"/);
    assert.match(run, /verify-attestation/);
    assert.ok(JSON.stringify(job.steps).includes('signing.mjs identity'));
    assert.ok(run.indexOf('cosign sign') < run.indexOf('cosign verify'));
  });
});
