// Tests for the SBOM validator and the sbom job wiring (CI-008, #142).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { SERVICES, WORKFLOW } from './check-images.mjs';
import { main, purlType, summaryLine, validateSbom } from './check-sbom.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const comp = (/** @type {string} */ purl) => ({ type: 'library', name: purl, purl });
const sbom = (/** @type {unknown[]} */ components, specVersion = '1.5') =>
  JSON.stringify({ bomFormat: 'CycloneDX', specVersion, components });
const node = [comp('pkg:npm/zod@3.0.0'), comp('pkg:deb/debian/libc6@2.36')];
const go = [comp('pkg:golang/github.com/x/y@v1'), comp('pkg:deb/debian/base-files@12')];

describe('validateSbom', () => {
  it('accepts npm + OS for a node service and golang + OS for egress-gateway', () => {
    assert.deepEqual(validateSbom(sbom(node), 'api').errors, []);
    assert.deepEqual(validateSbom(sbom(go), 'egress-gateway').errors, []);
    assert.equal(validateSbom(sbom(node), 'api').total, 2);
  });

  it('accepts a distroless-style SBOM with few OS packages but app deps', () => {
    const r = validateSbom(
      sbom([comp('pkg:golang/a/b@v1'), comp('pkg:deb/debian/tzdata@1')]),
      'egress-gateway',
    );
    assert.deepEqual(r.errors, []);
  });

  it('rejects empty, non-JSON, non-object and wrong-format SBOMs', () => {
    assert.ok(validateSbom(sbom([]), 'api').errors.includes('SBOM has no components'));
    assert.ok(validateSbom('{nope', 'api').errors.length > 0);
    assert.ok(validateSbom('[]', 'api').errors.length > 0);
    const spdx = JSON.stringify({ bomFormat: 'SPDX', components: node });
    assert.ok(validateSbom(spdx, 'api').errors.length > 0);
  });

  it('rejects other spec versions', () => {
    assert.ok(validateSbom(sbom(node, '1.4'), 'api').errors.some((e) => e.includes('1.5')));
  });

  it('rejects a missing language ecosystem or missing OS packages', () => {
    const osOnly = sbom([comp('pkg:deb/debian/libc6@1')]);
    assert.ok(validateSbom(osOnly, 'api').errors.some((e) => e.includes('npm')));
    assert.ok(validateSbom(sbom(node), 'egress-gateway').errors.some((e) => e.includes('golang')));
    const noOs = sbom([comp('pkg:npm/a@1')]);
    assert.ok(validateSbom(noOs, 'api').errors.some((e) => e.includes('OS packages')));
  });

  it('counts components without a purl as other', () => {
    const r = validateSbom(sbom([...node, { name: 'x' }]), 'api');
    assert.equal(r.counts.other, 1);
    assert.equal(purlType('pkg:npm/%40a/b@1'), 'npm');
  });
});

describe('main', () => {
  it('exits 1 on invalid, 0 on valid and writes the summary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbom-'));
    try {
      const bad = path.join(dir, 'bad.json');
      const good = path.join(dir, 'good.json');
      const sum = path.join(dir, 'sum.md');
      writeFileSync(bad, sbom([]));
      writeFileSync(good, sbom(node));
      assert.equal(main(['--service', 'api', '--sbom', bad]), 1);
      assert.equal(main(['--service', 'api', '--sbom', path.join(dir, 'missing.json')]), 1);
      assert.equal(main(['--service', 'api']), 2);
      const args = ['--service', 'api', '--sbom', good, '--image', 'r@sha256:x', '--summary', sum];
      assert.equal(main(args), 0);
      assert.equal(
        readFileSync(sum, 'utf8'),
        summaryLine('api', 'r@sha256:x', { npm: 1, deb: 1 }, 2),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sbom job in build-images workflow', () => {
  const text = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');
  /**
   * @typedef {{ needs: string | string[], if: string, permissions: Record<string, string>,
   *   strategy: { 'fail-fast': boolean, matrix: { service: string[] } }, steps: { run?: string }[] }} Job
   */
  /** @type {Job} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- parsed YAML is untyped
  const job = /** @type {{ jobs: { sbom: Job } }} */ (parse(text)).jobs.sbom;

  it('runs after images-json, only online on trusted non-fork events', () => {
    assert.ok(job, 'sbom job exists');
    assert.ok([job.needs].flat().includes('images-json'));
    assert.match(job.if, /BW_ONLINE == 'true'/);
    assert.match(job.if, /github\.event_name != 'pull_request'/);
    assert.match(job.if, /fork == false/);
  });

  it('scans every service by digest and attaches CycloneDX 1.5', () => {
    const steps = JSON.stringify(job.steps);
    assert.deepEqual([...job.strategy.matrix.service].sort(), [...SERVICES].sort());
    assert.ok(!text.includes('pull_request_target'));
    assert.match(steps, /cyclonedx-json@1\.5/);
    assert.match(steps, /cosign attach sbom/);
    assert.match(steps, /check-sbom\.mjs/);
    assert.match(steps, /upload-artifact/);
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.permissions.packages, 'write');
  });

  it('validates before attaching', () => {
    const run = job.steps.map((s) => s.run ?? '').join('\n');
    assert.ok(run.indexOf('check-sbom.mjs') < run.indexOf('cosign attach sbom'));
  });
});
