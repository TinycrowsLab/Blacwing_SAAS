// Tests for the image matrix guard and images.json builder (CI-007, #141).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildImagesJson, main as buildMain, summaryTable } from './build-images-json.mjs';
import { SERVICES, WORKFLOW, checkDockerfile, checkRepo, checkWorkflow } from './check-images.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const wf = () => readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');
const D = `sha256:${'a'.repeat(64)}`;
const allDigests = () => Object.fromEntries(SERVICES.map((s) => [s, D]));

describe('real repository', () => {
  it('passes the guard', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
  });

  it('keeps bw-sandbox out of the matrix', () => {
    const { errors } = checkWorkflow(wf());
    assert.deepEqual(errors, []);
    assert.ok(!SERVICES.includes('sandbox'));
  });
});

describe('checkWorkflow', () => {
  it('fails when bw-sandbox is re-added to the matrix', () => {
    const text = wf().replace(
      '          - service: cli\n',
      '          - service: sandbox\n            file: infra/docker/service.Dockerfile\n            context: .\n            platforms: linux/amd64\n          - service: cli\n',
    );
    const { errors } = checkWorkflow(text);
    assert.ok(errors.some((e) => e.includes('bw-sandbox must not be in the image matrix')));
  });

  it('fails on a missing service, a blackwing-* path, latest tags and fail-fast', () => {
    assert.ok(
      checkWorkflow(wf().replace('service: cli\n', 'service: clix\n')).errors.some((e) =>
        e.includes('missing service "cli"'),
      ),
    );
    assert.ok(
      checkWorkflow(wf().replace('ghcr.io/tinycrowslab', 'ghcr.io/tinycrowslab/blackwing-x')).errors
        .length > 0,
    );
    assert.ok(checkWorkflow(`${wf()}\n# tag: x:latest\n`).errors.some((e) => e.includes('latest')));
    assert.ok(
      checkWorkflow(wf().replace('fail-fast: false', 'fail-fast: true')).errors.some((e) =>
        e.includes('fail-fast'),
      ),
    );
  });

  it('fails when pull requests could push or run with fork secrets', () => {
    assert.ok(
      checkWorkflow(wf().replace("github.event_name != 'pull_request' &&", '')).errors.some((e) =>
        e.includes('pull_request'),
      ),
    );
    assert.ok(
      checkWorkflow(`${wf()}\n  pull_request_target:\n`).errors.some((e) =>
        e.includes('pull_request_target'),
      ),
    );
  });

  it('requires multi-arch for the egress gateway', () => {
    const text = wf().replace("'linux/amd64,linux/arm64'", 'linux/amd64');
    assert.ok(checkWorkflow(text).errors.some((e) => e.includes('arm64')));
  });

  it('rejects invalid YAML', () => {
    assert.equal(checkWorkflow('a: [').errors.length, 1);
  });
});

describe('checkDockerfile', () => {
  const pin = `x@sha256:${'b'.repeat(64)}`;
  it('accepts digest-pinned bases (inline and via ARG) and a non-root user', () => {
    const text = `ARG BASE=${pin}\nFROM \${BASE} AS a\nFROM ${pin}\nUSER app\n`;
    assert.deepEqual(checkDockerfile('Dockerfile', text), []);
  });

  it('rejects tag-only bases', () => {
    const errs = checkDockerfile('Dockerfile', 'FROM node:22\nUSER app\n');
    assert.ok(errs.some((e) => e.includes('not pinned by sha256 digest')));
  });

  it('rejects a root or missing USER in the final stage', () => {
    assert.ok(checkDockerfile('D', `FROM ${pin}\n`).some((e) => e.includes('non-root')));
    assert.ok(checkDockerfile('D', `FROM ${pin}\nUSER root\n`).some((e) => e.includes('non-root')));
    assert.ok(checkDockerfile('D', `FROM ${pin}\nUSER 0:0\n`).some((e) => e.includes('non-root')));
  });
});

describe('images.json builder', () => {
  it('maps every service to ghcr.io/tinycrowslab/bw-<service>@sha256:...', () => {
    const images = buildImagesJson(allDigests());
    assert.equal(Object.keys(images).length, 9);
    assert.equal(images.api, `ghcr.io/tinycrowslab/bw-api@${D}`);
    assert.ok(!('sandbox' in images));
    assert.ok(!JSON.stringify(images).includes('bw-sandbox@'));
    assert.ok(!JSON.stringify(images).includes('blackwing-'));
  });

  it('fails when a service has no or a malformed digest (isolated failure leaves no images.json)', () => {
    const missing = allDigests();
    delete missing.web;
    assert.throws(() => buildImagesJson(missing), /web/);
    assert.throws(() => buildImagesJson({ ...allDigests(), api: 'latest' }), /api/);
  });

  it('refuses a bw-sandbox digest', () => {
    assert.throws(() => buildImagesJson({ ...allDigests(), sandbox: D }), /unexpected/);
  });

  it('writes images.json and a summary table from digest files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-images-'));
    try {
      const d = path.join(dir, 'digests');
      mkdirSync(d);
      for (const s of SERVICES) writeFileSync(path.join(d, s), D);
      const out = path.join(dir, 'images.json');
      const summary = path.join(dir, 'summary.md');
      assert.equal(buildMain(['--digests', d, '--out', out, '--summary', summary]), 0);
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(Object.keys(/** @type {object} */ (parsed)).length, 9);
      assert.ok(readFileSync(summary, 'utf8').includes('bw-egress-gateway@'));
      rmSync(path.join(d, 'cli'));
      assert.equal(buildMain(['--digests', d, '--out', out]), 1);
      assert.equal(buildMain([]), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders a table', () => {
    assert.ok(summaryTable(buildImagesJson(allDigests())).includes('| api |'));
  });
});
