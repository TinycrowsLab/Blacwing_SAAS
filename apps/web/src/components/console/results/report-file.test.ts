import { describe, expect, it } from 'vitest';

import {
  ordered,
  renderHtml,
  renderJson,
  renderMarkdown,
  reportFilename,
  reportLede,
  reportSourceSchema,
} from './report-file';

const finding = (id: string, severity: string, title: string) => ({
  id,
  title,
  severity,
  status: 'released',
  createdAt: '2026-11-06T10:00:00.000Z',
  description: 'Anyone can read **it**.',
  oracle: { type: 'body_contains', value: 'secret' },
  evidence: {
    probe: {
      request: { method: 'GET', url: 'http://127.0.0.1:3001/a' },
      response: { status: 200, bodyExcerpt: '<b>x</b>' },
    },
    control: {
      request: { method: 'GET', url: 'http://127.0.0.1:3001/b' },
      response: { status: 200 },
    },
    replays: [{ n: 1, status: 200, matched: true }],
  },
  triage: { at: '2026-11-06T10:05:00.000Z', by: 'Jatin', reason: 'Proven by replay' },
});
const raw = {
  run: {
    id: '01a1b015-0000-0000-0000-000000000000',
    summary: 'Seven issues incl. the dismissed CORS one',
    startedAt: '2026-11-06T09:00:00.000Z',
    finishedAt: '2026-11-06T09:04:55.000Z',
    requestsUsed: 65,
    costUsd: 0.48,
    budget: { requests: 300, seconds: 480, costUsd: 3 },
  },
  asset: {
    name: 'Local shop',
    baseUrl: 'http://127.0.0.1:3001',
    ownership: { status: 'verified', verifiedBy: 'Jatin', verifiedAt: null },
  },
  request: {
    objective: '',
    intrusiveness: 'active_safe',
    approver: { name: 'Jatin' },
    decisionReason: 'Our own test lab',
    decidedAt: null,
  },
  counts: {},
  findings: [finding('l', 'low', 'Low one'), finding('h', 'high', 'High <one>')],
};

describe('run report file', () => {
  const source = reportSourceSchema.parse(raw);
  const list = ordered(source);
  it('lists released issues most severe first, in plain words, without the agent summary', () => {
    const html = renderHtml(source, list, '2026-11-07T00:00:00.000Z');
    expect(html).not.toContain('Seven issues');
    expect(html).not.toContain('active_safe');
    expect(html).toContain('Probe gently');
    expect(html.indexOf('High &lt;one&gt;')).toBeLessThan(html.indexOf('Low one'));
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(renderMarkdown(source, list)).not.toContain('Seven issues');
    const json = JSON.parse(renderJson(raw, list)) as {
      run: Record<string, unknown>;
      findings: { id: string }[];
    };
    expect(json.run.summary).toBeUndefined();
    expect(json.findings.map((f) => f.id)).toEqual(['h', 'l']);
  });
  it('names the file after the target and the day', () => {
    expect(reportFilename(source, 'html')).toBe('blackwing-report-local-shop-2026-11-06.html');
    expect(reportLede(list)).toBe(
      'Claude proved 2 issues that you released to this report: 1 high and 1 low.',
    );
    expect(reportLede([])).toContain('no issues');
  });
});
