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
    fingerprint: `fp-${cwe}`,
    identity_key: cwe === 'CWE-639' ? 'idk-639' : null,
    seen_at: null,
  }) as unknown as FindingRow;

const input = {
  run: { id: '0197a5d0-aaaa-7000-8000-000000000001', state: 'completed', created_at: new Date(), started_at: null, finished_at: null, kill_requested_at: null, requests_used: 3, budget_requests: 100, cost_usd: '0.5', summary: 'done', pins: { runner: { name: 'ai-hunt', version: '1' } }, started_by_name: null, queue_ahead: null } as unknown as RunRow,
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
        tool: { driver: { version?: string; informationUri?: string; rules: Record<string, unknown>[] } };
        originalUriBaseIds: { TARGET: { uri: string } };
        results: {
          level: string;
          partialFingerprints: Record<string, string>;
          properties: { findingId: string };
          locations: { physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string } } }[];
        }[];
      }[];
    };
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run?.tool.driver.rules.map((r) => r.id)).toEqual(['CWE-639', 'CWE-200']);
    expect(run?.results.map((r) => r.level)).toEqual(['error', 'note']);
    expect(run?.results[0]?.locations[0]?.physicalLocation.artifactLocation).toEqual({ uri: 'rest/basket/2', uriBaseId: 'TARGET' });
    expect(run?.originalUriBaseIds.TARGET.uri).toBe('http://lab/');
  });

  it('gives SARIF rules their metadata and results stable cross-run fingerprints', () => {
    const report = renderRunReport({ ...input, consoleOrigin: 'http://localhost:3000' }, 'sarif');
    const run = (JSON.parse(report.body) as { runs: { tool: { driver: Record<string, unknown> }; results: Record<string, unknown>[] }[] }).runs[0];
    expect(run?.tool.driver).toMatchObject({ name: 'Blackwing', version: '1', informationUri: 'http://localhost:3000' });
    expect((run?.tool.driver.rules as unknown[])[0]).toEqual({
      id: 'CWE-639',
      name: 'CWE-639',
      shortDescription: { text: 'IDOR' },
      helpUri: 'https://cwe.mitre.org/data/definitions/639.html',
      properties: { tags: ['A01:2021 Broken Access Control', 'security'], 'security-severity': '8.0' },
    });
    expect(run?.results[0]).toMatchObject({
      partialFingerprints: { 'blackwingIdentity/v1': 'idk-639' },
      properties: { findingId: '0197a5d0-aaaa-7000-8000-000000000002' },
    });
    // No identity key on an older row: the per-run fingerprint stands in.
    expect(run?.results[1]).toMatchObject({ partialFingerprints: { 'blackwingIdentity/v1': 'fp-CWE-200' } });
  });

  it('adds coverage and the end reason to the JSON report', () => {
    const coverage = { cases: [{ id: 'c1', title: 'SQLi', agent: 'web', status: 'not_run' }], requestsSent: 3 };
    const body = JSON.parse(renderRunReport({ ...input, coverage, endReason: 'duration_budget' }, 'json').body) as {
      coverage: unknown;
      run: { endReason: string | null };
    };
    expect(body.coverage).toEqual(coverage);
    expect(body.run.endReason).toBe('duration_budget');
    expect((JSON.parse(renderRunReport(input, 'json').body) as { coverage: unknown }).coverage).toBeNull();
  });

  it('adds an External exposure section to every format, marking unverified intel', () => {
    const intel = {
      skipped: null,
      domains: ['example.com'],
      sources: [{ name: 'Certificate transparency (crt.sh)', status: 'done', note: '2 hostnames outside the approved scope' }],
      items: [
        { source: 'target', title: 'Exposed Git repository metadata (/.git/HEAD)', detail: 'd', severity: 'high', basis: 'finding' },
        { source: 'cve', title: 'nginx 1.18.0 announced', detail: 'CVE-2021-0001', severity: 'high', basis: 'unverified' },
      ],
      discoveredHosts: ['staging.example.com'],
      archivedPaths: [],
    };
    const json = JSON.parse(renderRunReport({ ...input, intel }, 'json').body) as { externalExposure: { items: unknown[] } | null };
    expect(json.externalExposure?.items).toHaveLength(2);
    expect((JSON.parse(renderRunReport(input, 'json').body) as { externalExposure: unknown }).externalExposure).toBeNull();
    for (const format of ['md', 'html'] as const) {
      const { body } = renderRunReport({ ...input, intel }, format);
      expect(body).toContain('External exposure');
      expect(body).toContain('intel, not verified');
      expect(body).toContain('staging.example.com');
    }
  });

  it('never prints a secret from evidence, curl or description, in any format', () => {
    const leaky = {
      ...finding('high', 'CWE-200', 'Config exposed'),
      description: "The file holds $_DVWA[ 'db_password' ] = 'vulnerables';",
      repro_curl: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' http://lab/x",
      evidence: { probe: { response: { status: 200, bodyExcerpt: '{"password":"hunter2","email":"a@b.c"}' } }, replays: [] },
    } as unknown as FindingRow;
    for (const format of ['html', 'md', 'json', 'sarif'] as const) {
      const { body } = renderRunReport({ ...input, findings: [leaky] }, format);
      expect(body, format).not.toContain('vulnerables');
      expect(body, format).not.toContain('hunter2');
      expect(body, format).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0');
    }
    const { body } = renderReport({ ...input, finding: leaky }, 'md');
    expect(body).not.toContain('vulnerables');
    expect(body).not.toContain('hunter2');
  });

  it('does not claim that no data was extracted', () => {
    for (const format of ['html', 'md'] as const) {
      expect(renderRunReport(input, format).body).not.toContain('no data was extracted');
    }
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

describe('renderReport proof screenshots', () => {
  const one = { finding: finding('high', 'CWE-639', 'IDOR'), run: input.run, asset: input.asset, request: input.request };
  it('embeds the probe and control PNGs as base64 in HTML and names them in Markdown', () => {
    const shots = { probe: 'UFJPQkU=', control: 'Q09OVFJPTA==' };
    const html = renderReport({ ...one, screenshots: shots }, 'html').body;
    expect(html).toContain('data:image/png;base64,UFJPQkU=');
    expect(html).toContain('data:image/png;base64,Q09OVFJPTA==');
    const md = renderReport({ ...one, screenshots: shots }, 'md').body;
    expect(md).toContain('Proof screenshots');
    expect(md).toContain('/screenshots/probe');
    expect(md).not.toContain('base64');
  });
  it('says why there is none when the capture was skipped', () => {
    const f = { ...one.finding, evidence: { screenshots: { status: 'skipped', note: 'No browser is installed.' } } } as unknown as FindingRow;
    expect(renderReport({ ...one, finding: f }, 'html').body).toContain('No browser is installed.');
  });

  it('puts the AI executive summary first in HTML, Markdown and JSON, and omits it when absent', () => {
    const executiveSummary = { markdown: '## Executive summary\nRisk is <high>.\n\n## Key risks\n- IDOR\n\n## Recommended next steps\n1. Fix it', model: 'claude-sonnet-5' };
    const html = renderRunReport({ ...input, executiveSummary }, 'html').body;
    expect(html.indexOf('Executive summary')).toBeLessThan(html.indexOf('Released findings:'));
    expect(html).toContain('Written by Blackwing AI, not verified');
    expect(html).toContain('Risk is &lt;high&gt;.');
    expect(html).toContain('<h3>Key risks</h3>');
    const md = renderRunReport({ ...input, executiveSummary }, 'md').body;
    expect(md.indexOf('## Executive summary')).toBeLessThan(md.indexOf('Released findings:'));
    expect(md.match(/## Executive summary/g)).toHaveLength(1);
    const json = JSON.parse(renderRunReport({ ...input, executiveSummary }, 'json').body) as { executiveSummary: { markdown: string } };
    expect(json.executiveSummary.markdown).toContain('Key risks');
    expect(JSON.stringify(json)).not.toMatch(/claude/i);
    for (const format of ['html', 'md', 'json'] as const) expect(renderRunReport(input, format).body).not.toContain('Executive summary');
  });

  it('embeds the proof screenshots of each released finding in the run HTML report', () => {
    const id = input.findings[0]?.id ?? '';
    const screenshots = { [id]: { probe: 'UFJPQkU=', control: 'Q09OVFJPTA==' } };
    const html = renderRunReport({ ...input, screenshots }, 'html').body;
    expect(html).toContain('data:image/png;base64,UFJPQkU=');
    expect(html).toContain('data:image/png;base64,Q09OVFJPTA==');
    expect(renderRunReport({ ...input, screenshots }, 'md').body).toContain(`/api/findings/${id}/screenshots/probe`);
  });
});
