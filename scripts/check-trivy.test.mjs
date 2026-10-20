// Tests for the Trivy allowlist guard, SARIF summary and workflow wiring (CI-009, #143).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  checkWiring,
  IMAGES_WORKFLOW,
  main,
  MAX_DAYS,
  parseDate,
  summarizeSarif,
  summaryLine,
  validateIgnore,
  WORKFLOW,
} from './check-trivy.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const TODAY = '2026-06-01';
const entry = (
  /** @type {string} */ id,
  reason = 'false positive, see #1234',
  exp = '2026-08-01',
) => `# reason: ${reason}\n# expires: ${exp}\n${id} exp:${exp}\n`;

describe('validateIgnore', () => {
  it('accepts an empty allowlist and comments only', () => {
    assert.deepEqual(validateIgnore('# nothing\n\n', TODAY).errors, []);
  });

  it('accepts a justified entry with a valid future expiry', () => {
    const r = validateIgnore(entry('CVE-2024-12345') + '\n' + entry('GHSA-abcd-efgh-ijkl'), TODAY);
    assert.deepEqual(r.errors, []);
    assert.equal(r.entries.length, 2);
  });

  it('accepts misconfiguration ids', () => {
    assert.deepEqual(
      validateIgnore(entry('AVD-DS-0002') + '\n' + entry('DS002'), TODAY).errors,
      [],
    );
  });

  it('rejects an expired entry, including one expiring today', () => {
    const past = validateIgnore(entry('CVE-2024-1', undefined, '2026-05-31'), TODAY);
    assert.ok(past.errors.some((e) => e.includes('expired on 2026-05-31')));
    const same = validateIgnore(entry('CVE-2024-1', undefined, TODAY), TODAY);
    assert.ok(same.errors.some((e) => e.includes('expired')));
  });

  it('rejects an entry without an expiry', () => {
    const r = validateIgnore('# reason: false positive, see #1234\nCVE-2024-1\n', TODAY);
    assert.ok(r.errors.some((e) => e.includes('missing `# expires')));
  });

  it('rejects an entry without a justification', () => {
    const none = validateIgnore('# expires: 2026-08-01\nCVE-2024-1 exp:2026-08-01\n', TODAY);
    assert.ok(none.errors.some((e) => e.includes('missing justification')));
    const short = validateIgnore(entry('CVE-2024-1', 'fp'), TODAY);
    assert.ok(short.errors.some((e) => e.includes('missing justification')));
  });

  it('does not let a blank line carry a previous entry metadata to the next id', () => {
    const r = validateIgnore(`${entry('CVE-2024-1')}\nCVE-2024-2 exp:2026-08-01\n`, TODAY);
    assert.ok(r.errors.some((e) => e.includes('CVE-2024-2') && e.includes('justification')));
  });

  it('does not reuse one block for two ids', () => {
    const r = validateIgnore(`${entry('CVE-2024-1')}CVE-2024-2 exp:2026-08-01\n`, TODAY);
    assert.ok(r.errors.some((e) => e.includes('CVE-2024-2')));
  });

  it('rejects malformed, impossible and too-distant expiries', () => {
    assert.ok(
      validateIgnore(entry('CVE-2024-1', undefined, '2026-13-40'), TODAY).errors.length > 0,
    );
    assert.ok(validateIgnore(entry('CVE-2024-1', undefined, 'soon'), TODAY).errors.length > 0);
    const far = validateIgnore(entry('CVE-2024-1', undefined, '2028-01-01'), TODAY);
    assert.ok(far.errors.some((e) => e.includes(String(MAX_DAYS))));
  });

  it('requires Trivy exp: on the id line to match the comment', () => {
    const missing = validateIgnore(
      '# reason: false positive, see #1\n# expires: 2026-08-01\nCVE-2024-1\n',
      TODAY,
    );
    assert.ok(missing.errors.some((e) => e.includes('exp:2026-08-01')));
    const differs = validateIgnore(
      '# reason: false positive, see #1\n# expires: 2026-08-01\nCVE-2024-1 exp:2027-01-01\n',
      TODAY,
    );
    assert.ok(differs.errors.length > 0);
  });

  it('rejects bad ids, trailing text and duplicates', () => {
    assert.ok(validateIgnore(entry('not an id'), TODAY).errors.length > 0);
    assert.ok(
      validateIgnore(entry('*'), TODAY).errors.some((e) => e.includes('not a vulnerability')),
    );
    const extra = validateIgnore(
      '# reason: false positive, see #1\n# expires: 2026-08-01\nCVE-2024-1 exp:2026-08-01 because\n',
      TODAY,
    );
    assert.ok(extra.errors.some((e) => e.includes('unexpected text')));
    const dup = validateIgnore(entry('CVE-2024-1') + '\n' + entry('CVE-2024-1'), TODAY);
    assert.ok(dup.errors.some((e) => e.includes('duplicate')));
  });

  it('rejects an invalid reference date', () => {
    assert.ok(validateIgnore('', 'yesterday').errors.length > 0);
    assert.equal(parseDate('2026-02-30'), undefined);
  });

  it('the committed .trivyignore is valid today', () => {
    const text = readFileSync(path.join(REPO_ROOT, '.trivyignore'), 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(validateIgnore(text, today).errors, []);
  });
});

const sarif = (/** @type {string[]} */ sevs) =>
  JSON.stringify({
    runs: [
      {
        tool: {
          driver: {
            rules: sevs.map((s, i) => ({
              id: `CVE-${String(i)}`,
              properties: { tags: ['vulnerability', s] },
            })),
          },
        },
        results: sevs.map((_, i) => ({ ruleId: `CVE-${String(i)}` })),
      },
    ],
  });

describe('summarizeSarif', () => {
  it('counts results per severity', () => {
    const r = summarizeSarif(sarif(['HIGH', 'HIGH', 'CRITICAL']));
    assert.equal(r.total, 3);
    assert.equal(r.counts.HIGH, 2);
    assert.equal(r.counts.CRITICAL, 1);
    assert.equal(
      summaryLine('api', r.counts, r.total),
      '| api | 3 | CRITICAL 1 | HIGH 2 | MEDIUM 0 | LOW 0 | UNKNOWN 0 |',
    );
  });

  it('handles clean scans and results with unknown rules', () => {
    assert.equal(summarizeSarif('{"runs":[{"results":[]}]}').total, 0);
    assert.equal(summarizeSarif('{"runs":[{"results":[{"ruleId":"x"}]}]}').counts.UNKNOWN, 1);
  });

  it('reports invalid SARIF', () => {
    assert.ok(summarizeSarif('{nope').error);
    assert.ok(summarizeSarif('{}').error);
  });
});

describe('main', () => {
  it('ignore exits 1 on an expired entry and 0 on a valid one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trivy-'));
    try {
      const file = path.join(dir, '.trivyignore');
      writeFileSync(file, entry('CVE-2024-1', undefined, '2026-08-01'));
      assert.equal(main(['ignore', '--file', file, '--today', '2026-06-01']), 0);
      assert.equal(main(['ignore', '--file', file, '--today', '2026-09-01']), 1);
      assert.equal(main(['ignore', '--file', path.join(dir, 'missing')]), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summary validates input and appends a row', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trivy-'));
    try {
      const good = path.join(dir, 'a.sarif');
      const sum = path.join(dir, 'sum.md');
      writeFileSync(good, sarif(['HIGH']));
      writeFileSync(path.join(dir, 'bad.sarif'), 'x');
      assert.equal(main(['summary', '--sarif', good, '--label', 'api', '--summary', sum]), 0);
      assert.ok(readFileSync(sum, 'utf8').startsWith('| api | 1 |'));
      assert.equal(main(['summary', '--sarif', path.join(dir, 'bad.sarif')]), 1);
      assert.equal(main(['summary']), 1);
      assert.equal(main(['bogus']), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow wiring', () => {
  it('the committed workflows satisfy the policy', () => {
    assert.deepEqual(checkWiring(REPO_ROOT), []);
  });

  it('flags a missing gate, SARIF upload and digest pinning', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trivy-'));
    try {
      mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
      const weak = [
        'on: push',
        'jobs:',
        '  allowlist:',
        '    runs-on: x',
        '    steps: []',
        '  fs:',
        '    runs-on: x',
        '    steps: []',
        '',
      ].join('\n');
      writeFileSync(path.join(dir, WORKFLOW), weak);
      writeFileSync(
        path.join(dir, IMAGES_WORKFLOW),
        'on: push\njobs:\n  build:\n    runs-on: x\n    steps: []\n',
      );
      const errors = checkWiring(dir).join('\n');
      for (const needle of [
        'SARIF is not uploaded',
        'exit-code 1',
        'HIGH,CRITICAL',
        'misconfig',
        "job 'trivy' is missing",
      ]) {
        assert.ok(errors.includes(needle), needle);
      }
      assert.deepEqual(checkWiring(path.join(dir, 'nowhere')), [
        `${WORKFLOW} is missing or invalid`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an image scan that is not pinned to a digest or lacks packages restraint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trivy-'));
    try {
      mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(path.join(dir, WORKFLOW), readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8'));
      const img = readFileSync(path.join(REPO_ROOT, IMAGES_WORKFLOW), 'utf8')
        .replaceAll('@sha256:', '@tag:')
        .replaceAll('ignore-unfixed', 'x');
      writeFileSync(path.join(dir, IMAGES_WORKFLOW), img);
      const errors = checkWiring(dir).join('\n');
      assert.ok(errors.includes('pinned by digest'));
      assert.ok(errors.includes('ignore-unfixed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
