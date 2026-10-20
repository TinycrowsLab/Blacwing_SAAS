// Integration check for the Trivy gate (CI-009, #143). Needs the `trivy` binary and a vulnerability
// DB (downloaded on first use). Not part of `pnpm test:scripts` (no network in unit tests); run with
// `pnpm test:trivy`. It seeds a temp project with a known fixable HIGH vulnerability and proves that
// the gate fails, that an allowlisted CVE with a future expiry passes, and that an expired one fails.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { DAY_MS, isoDate } from './check-trivy.mjs';

// lodash 4.17.15 is affected by CVE-2020-8203 (HIGH, fixed in 4.17.19) and CVE-2021-23337.
const LOCK = {
  name: 'seed',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'seed', version: '1.0.0', dependencies: { lodash: '4.17.15' } },
    'node_modules/lodash': { version: '4.17.15' },
  },
};
const dir = mkdtempSync(path.join(tmpdir(), 'trivy-int-'));
writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK));
writeFileSync(
  path.join(dir, 'package.json'),
  '{"name":"seed","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}',
);
const FUTURE_DAYS = 30;
const future = isoDate(new Date(Date.now() + FUTURE_DAYS * DAY_MS));
const past = '2020-01-01';

/** @param {string | undefined} ignore contents of the allowlist, or undefined for none */
function scan(ignore) {
  const file = path.join(dir, '.trivyignore');
  writeFileSync(file, ignore ?? '');
  return spawnSync(
    'trivy',
    [
      'fs',
      '--scanners',
      'vuln',
      '--severity',
      'HIGH,CRITICAL',
      '--ignore-unfixed',
      '--exit-code',
      '1',
      '--ignorefile',
      file,
      '--quiet',
      '--format',
      'json',
      dir,
    ],
    { encoding: 'utf8' },
  );
}

/** @typedef {{ Results?: { Vulnerabilities?: { VulnerabilityID: string }[] }[] }} Report */

/**
 * @param {string} json Trivy JSON report
 * @returns {string[]} unique vulnerability ids
 */
function vulnerabilityIds(json) {
  /** @type {unknown} */
  const raw = JSON.parse(json);
  const report = /** @type {Report} */ (raw);
  const ids = (report.Results ?? []).flatMap((r) =>
    (r.Vulnerabilities ?? []).map((v) => v.VulnerabilityID),
  );
  return [...new Set(ids)];
}

/** @type {string[]} */
let found = [];

/** @param {string} exp */
const allowAll = (exp) =>
  found
    .map((id) => `# reason: integration fixture, accepted\n# expires: ${exp}\n${id} exp:${exp}\n`)
    .join('\n');

describe('trivy gate (seeded vulnerability)', () => {
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a fixable HIGH/CRITICAL finding', () => {
    const r = scan(undefined);
    assert.equal(r.status, 1, r.stderr);
    found = vulnerabilityIds(r.stdout);
    assert.ok(found.includes('CVE-2020-8203'), found.join(','));
  });

  it('passes when every finding is allowlisted with a future expiry', () => {
    const r = scan(allowAll(future));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('fails again once the allowlist expiry has passed', () => {
    const r = scan(allowAll(past));
    assert.equal(r.status, 1, r.stderr);
  });
});
