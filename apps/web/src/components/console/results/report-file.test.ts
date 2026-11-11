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
    expect(reportLede(list)).toBe('2 issues were released to this report, all 2 proven by replay: 1 high and 1 low.');
    expect(reportLede([])).toContain('no issues');
  });
  it('splits proven from hand-released issues and never claims what did not happen', () => {
    const unproven = { ...finding('u', 'medium', 'Unproven'), evidence: { ...finding('u', 'medium', 'x').evidence, reason: 'probe replay 2 did not match the oracle' } };
    const src = reportSourceSchema.parse({ ...raw, findings: [finding('h', 'high', 'High'), unproven] });
    expect(reportLede(ordered(src))).toBe(
      '2 issues were released to this report (1 proven, 1 released without proof): 1 high and 1 medium.',
    );
    const md = renderMarkdown(source, list);
    expect(md).not.toMatch(/no data was taken/i);
    expect(md).toContain('No browser is used, so DOM-based XSS is not tested.');
    expect(md).toContain(
      'Blackwing did not record test-case coverage for this audit, so it cannot list the cases that did not run.',
    );
  });
  it('reports the roles actually used and the cases that did not run', () => {
    const src = reportSourceSchema.parse({
      ...raw,
      run: { ...raw.run, endReason: 'duration_budget', summary: 'Tested A.\n\n## Not covered\nThe payment flow, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh' },
      request: { ...raw.request, testAccounts: [{ role: 'alice' }, { role: 'bob' }], excludedPaths: ['/setup.php'] },
      coverage: {
        cases: [
          { id: 'a', title: 'Search SQLi', agent: 'web-api-specialist', status: 'executed' },
          { id: 'b', title: 'Basket IDOR', agent: 'authz-specialist', status: 'not_run' },
          { id: 'c', title: 'Admin page', agent: 'web-api-specialist', status: 'blocked', note: 'needed a denied POST' },
          { id: 'd', title: 'Account takeover', agent: 'authz-specialist', status: 'model_declined', note: 'out of the agreed scope' },
        ],
        rolesConfigured: ['alice', 'bob'],
        rolesUsed: { alice: 14 },
      },
    });
    const md = renderMarkdown(src, ordered(src));
    expect(md).toContain('**Signed-in testing:** Configured: alice, bob · used in 14 requests (alice 14, bob 0)');
    expect(md).toContain('**Test cases:** 1 of 4 planned test cases ran');
    expect(md).toContain('- **Basket IDOR:** Not tried: the time limit came first');
    expect(md).toContain('- **Admin page:** Blocked: needed a denied POST');
    expect(md).toContain('- **Account takeover:** Declined by Blackwing AI: out of the agreed scope');
    expect(md).toContain('- **/setup.php:** Left out on purpose: the plan excluded these paths');
    expect(md).toContain('Blackwing AI’s own note (not verified):');
    expect(md).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(md).not.toContain('Tested A.');
    const none = reportSourceSchema.parse({ ...raw, request: { ...raw.request, testAccounts: [{ role: 'alice' }] }, coverage: { cases: [], rolesUsed: {} } });
    expect(renderMarkdown(none, [])).toContain('Configured: alice · not used in any request');
  });
  it('scrubs secrets the site gave the agents, at render time too', () => {
    const leaky = {
      ...finding('s', 'high', 'Config leak'),
      reproCurl: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh' http://127.0.0.1:3082/x",
      evidence: {
        ...finding('s', 'high', 'x').evidence,
        probe: {
          request: { method: 'GET', url: 'http://127.0.0.1:3082/config/config.inc.php.bak' },
          response: { status: 200, bodyExcerpt: "$_DVWA[ 'db_password' ] = 'vulnerables';" },
        },
      },
    };
    const src = reportSourceSchema.parse({ ...raw, findings: [leaky] });
    const html = renderHtml(src, ordered(src), '2026-11-07T00:00:00.000Z');
    const md = renderMarkdown(src, ordered(src));
    const json = renderJson({ ...raw, findings: [leaky] }, ordered(src));
    for (const out of [html, md, json]) {
      expect(out).not.toContain('vulnerables');
      expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0');
    }
    expect(md).toContain('[redacted:');
  });
});

describe('kept-back appendix and evidence', () => {
  const kept = { ...finding('k', 'low', 'Maybe XSS'), status: 'suspected', triage: null, evidence: { probe: {}, control: {}, replays: [], reason: 'no_control: only data open to everyone may be proven without a control' } };
  const src = reportSourceSchema.parse({ ...raw, keptBack: [kept] });
  it('lists kept-back issues as not proven and keeps replays and control evidence', () => {
    for (const out of [renderMarkdown(src, ordered(src)), renderHtml(src, ordered(src), '2026-11-06T10:00:00Z')]) {
      expect(out).toContain('Maybe XSS');
      expect(out.toLowerCase()).toContain('not proven');
      expect(out).toContain('What was not tested and why');
      expect(out).toContain('Replay');
    }
    expect(JSON.parse(renderJson({ ...raw, keptBack: [kept] }, ordered(src)))).toMatchObject({ scope: { keptBackCount: 1 }, notTested: { recorded: false } });
  });
});
