// DEMO-STORY run report tests: SARIF mapping and the HTML/Markdown/JSON envelopes of a run report.
import { describe, expect, it } from 'vitest';

import { renderReport, renderRunReport } from './report.js';

import type { AssetRow, FindingRow, RequestRow, RunRow } from './store.js';

const finding = (severity: string, cwe: string, title: string): FindingRow =>
  ({
    id: '0197a5d0-aaaa-7000-8000-000000000002',
    title,
    severity,
    cwe_id: cwe,
    owasp_category: 'A01',
    agent: 'authz-specialist',
    description: 'd',
    repro_curl: 'curl x',
    evidence: {}, confidence: '0.9', triaged_at: null, delivery_status: null,
    location: { method: 'GET', url: 'http://lab/rest/basket/2' },
    status: 'released',
    created_at: new Date('2026-11-05T10:00:00Z'),
  }) as unknown as FindingRow;

const input = {
  run: { id: '0197a5d0-aaaa-7000-8000-000000000001', state: 'completed', created_at: new Date(), started_at: null, finished_at: null, kill_requested_at: null, requests_used: 3, budget_requests: 100, cost_usd: '0.5', summary: 'done', pins: {} } as unknown as RunRow,
  asset: { name: 'Lab', base_url: 'http://lab', ownership_status: 'verified', allowed_origins: ['http://lab'], excluded_paths: [], created_at: new Date(), verified_at: null } as unknown as AssetRow,
  request: { intrusiveness: 'passive', requester_name: 'A', approver_name: 'B', scope: {}, test_accounts: [], cost_cap_usd: '5', created_at: new Date(), decided_at: null } as unknown as RequestRow,
  findings: [finding('high', 'CWE-639', 'IDOR'), finding('low', 'CWE-200', 'Leak <b>')],
};

describe('renderRunReport', () => {
  it('maps released findings to SARIF 2.1.0', () => {
    const report = renderRunReport(input, 'sarif');
    expect(report.contentType).toBe('application/sarif+json');
    expect(report.filename).toBe('run-0197a5d0.sarif');
    const sarif = JSON.parse(report.body) as {
      version: string;
      runs: {
        tool: { driver: { rules: unknown[] } };
        results: { level: string; locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[];
      }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.rules).toEqual([{ id: 'CWE-639' }, { id: 'CWE-200' }]);
    expect(sarif.runs[0]?.results.map((r) => r.level)).toEqual(['error', 'note']);
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('http://lab/rest/basket/2');
  });

  it('counts severities in JSON and escapes titles in HTML', () => {
    expect((JSON.parse(renderRunReport(input, 'json').body) as { counts: unknown }).counts).toMatchObject({ high: 1, low: 1, critical: 0 });
    const html = renderRunReport(input, 'html');
    expect(html.body).toContain('Leak &lt;b&gt;');
    expect(html.body).toContain('agent-written, not verified');
    expect(renderRunReport(input, 'md').contentType).toBe('text/markdown; charset=utf-8');
  });
});

describe('renderReport', () => {
  it('does not claim validation for a finding an analyst released after the validator rejected it', () => {
    const released = { ...finding('high', 'CWE-639', 'IDOR'), evidence: { reason: 'negative control matched', replays: [] } } as unknown as FindingRow;
    for (const format of ['md', 'html'] as const) {
      const { body } = renderReport({ ...input, finding: released }, format);
      expect(body).toContain('Not validated: the validator rejected it (negative control matched)');
      expect(body).not.toContain('Validated by deterministic replay');
      expect(body).not.toContain('oracle not matched');
    }
  });
});
