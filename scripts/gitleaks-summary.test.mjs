// Unit tests for scripts/gitleaks-summary.mjs (CI-012, #146): counts only, never a secret.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { countFindings, main, renderSummary } from './gitleaks-summary.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'bw-gitleaks-summary-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = ['bw', 'pat', 'UNREDACTEDVALUE0123456789'].join('_');
const sarif = {
  runs: [
    {
      results: [
        {
          ruleId: 'blackwing-personal-access-token',
          message: { text: `found ${SECRET}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'apps/api/secret.ts' },
                region: { snippet: { text: SECRET } },
              },
            },
          ],
        },
        { ruleId: 'blackwing-personal-access-token' },
        { ruleId: 'private-key' },
        { ruleId: `evil ${SECRET} | injected` },
      ],
    },
  ],
};

describe('gitleaks-summary', () => {
  it('counts findings per rule', () => {
    const counts = countFindings(sarif);
    assert.equal(counts.total, 4);
    assert.equal(counts.byRule.get('blackwing-personal-access-token'), 2);
    assert.equal(counts.byRule.get('private-key'), 1);
    assert.equal(counts.byRule.get('unknown-rule'), 1);
  });

  it('prints counts only: no secret, snippet, message or path, even from an unredacted report', () => {
    const text = renderSummary(countFindings(sarif), 'pr');
    assert.match(text, /\*\*4 finding\(s\)\*\*/);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('apps/api/secret.ts'));
    assert.ok(!text.includes('found'));
  });

  it('reports a clean scan', () => {
    assert.match(
      renderSummary(countFindings({ runs: [{ results: [] }] }), 'full'),
      /No secrets found\./,
    );
  });

  it('appends to GITHUB_STEP_SUMMARY and rejects a missing or malformed report', () => {
    const report = path.join(dir, 'r.sarif');
    const summary = path.join(dir, 'summary.md');
    writeFileSync(report, JSON.stringify(sarif));
    writeFileSync(summary, '');
    assert.equal(main([report, '--mode', 'push'], { GITHUB_STEP_SUMMARY: summary }), 0);
    const written = readFileSync(summary, 'utf8');
    assert.match(written, /gitleaks, push/);
    assert.ok(!written.includes(SECRET));

    assert.equal(main([path.join(dir, 'missing.sarif')], {}), 2);
    writeFileSync(path.join(dir, 'bad.sarif'), '{"version":"2.1.0"}');
    assert.equal(main([path.join(dir, 'bad.sarif')], {}), 2);
    assert.equal(main([], {}), 2);
  });
});
