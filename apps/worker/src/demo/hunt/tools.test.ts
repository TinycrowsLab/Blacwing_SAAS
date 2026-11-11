import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { watchGate2 } from './http-tool.js';
import { huntTools, recordProven } from './tools.js';

import type { HuntRun } from './types.js';

const run: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'test',
  scope: { allowedOrigins: ['https://t.example'], excludedPaths: [] },
  budgetRequests: 10,
  budgetSeconds: 60,
  costCapUsd: 1,
  intrusiveness: 'active_safe',
  testAccounts: [],
  releaseProven: 'hold',
  labOrigins: [],
};

function setup(releaseProven: HuntRun['releaseProven'], respond: string | ((url: string) => string) = 'ok') {
  const store = new FakeStore();
  const posted: string[] = [];
  const ctx: HuntContext = {
    run: { ...run, releaseProven },
    store,
    log: new EventLog(store, run.id, { warn: () => undefined, error: () => undefined }),
    signal: new AbortController().signal,
    deps: {
      fetch: (input) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        posted.push(url);
        return Promise.resolve(new Response(typeof respond === 'string' ? respond : respond(url)));
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      gate2TimeoutMs: 1000,
      webhookUrl: 'https://hooks.example/x',
      consoleOrigin: 'http://console.test',
      lookup: () => Promise.resolve([{ address: '93.184.215.14' }]),
    },
    state: newHuntState(),
  };
  return { ctx, store, posted };
}

const row = {
  id: 'f1',
  fingerprint: 'fp',
  identityKey: null,
  agent: 'web-api-specialist',
  title: 'SQL injection in search',
  vulnClass: 'sqli',
  cwe: 'CWE-89',
  owasp: 'A03',
  severity: 'critical',
  description: 'd',
  location: {},
  oracle: {},
  evidence: {},
  replay: {},
  reproCurl: 'curl x',
  testCaseId: null,
};
const summary = { candidateId: 'c1', title: row.title, severity: row.severity };

describe('recordProven (release mode)', () => {
  it('hold: stores the finding as confirmed, emits no release and delivers no webhook', async () => {
    const { ctx, store, posted } = setup('hold');
    expect(await recordProven(ctx, row, summary)).toBe('f1');
    expect(store.findings.map((f) => f.status)).toEqual(['confirmed']);
    expect(store.events.map((e) => e.kind)).toEqual(['finding.confirmed']);
    expect(posted).toEqual([]);
    expect(store.deliveries).toEqual([]);
    expect(ctx.state.findings).toBe(1);
  });

  it('auto: releases at once and delivers the webhook (unchanged behaviour)', async () => {
    const { ctx, store, posted } = setup('auto');
    await recordProven(ctx, row, summary);
    expect(store.findings.map((f) => f.status)).toEqual(['released']);
    expect(store.events.map((e) => e.kind)).toEqual(['finding.confirmed', 'finding.released']);
    expect(store.events[1]?.data).toMatchObject({ auto: true, findingId: 'f1' });
    expect(posted).toEqual(['https://hooks.example/x']);
    expect(store.deliveries).toEqual([{ findingId: 'f1', status: 'delivered', detail: 'HTTP 200' }]);
  });

  it('a proven duplicate records nothing; a proven upgrade of a suspected one keeps its id', async () => {
    const { ctx, store } = setup('hold');
    store.findings.push({ ...row, id: 'old', status: 'suspected' });
    expect(await recordProven(ctx, { ...row, id: 'new' }, summary)).toBe('old');
    expect(store.findings.map((f) => [f.id, f.status])).toEqual([['old', 'confirmed']]);
    expect(await recordProven(ctx, { ...row, id: 'again' }, summary)).toBeNull();
  });

  it('an earlier audit\'s unreleased copy of the same issue gives way to the newer proof (ledgered, never released)', async () => {
    const { ctx, store } = setup('hold');
    store.findings.push({ ...row, id: 'older', fingerprint: 'other-run', identityKey: 'ik', status: 'confirmed' });
    store.findings.push({ ...row, id: 'kept', fingerprint: 'released-run', identityKey: 'ik', status: 'released' });
    expect(await recordProven(ctx, { ...row, identityKey: 'ik' }, summary)).toBe('f1');
    expect(store.findings.map((f) => [f.id, f.status])).toEqual([['kept', 'released'], ['f1', 'confirmed']]);
    expect(store.ledger).toEqual([{ action: 'finding.superseded', targetId: 'older', payload: { by: 'f1' } }]);
  });
});

type ToolName = 'http_request' | 'record_test_cases' | 'update_test_case' | 'submit_candidate' | 'list_exchanges' | 'await_decision';

async function call(ctx: HuntContext, name: ToolName, args: Record<string, unknown>): Promise<string> {
  const found = huntTools(ctx).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  const handler = found.handler as unknown as (input: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;
  const result = await handler(args, {});
  return result.content.map((c) => c.text).join('');
}

describe('test cases and coverage counting', () => {
  const candidate = {
    title: 'Reflected marker',
    vulnClass: 'xss',
    cwe: 'CWE-79',
    owasp: 'A03',
    severity: 'medium',
    description: 'd',
    probe: { method: 'GET', url: 'https://t.example/?q=bw7x' },
    control: { method: 'GET', url: 'https://t.example/?q=plain' },
    oracle: { type: 'body_contains', value: 'bw7x' },
  };

  it('requires a known case_id on submit_candidate once cases exist, spending no validation', async () => {
    const { ctx, posted } = setup('hold');
    await call(ctx, 'record_test_cases', { cases: [{ id: 'xss-search', title: 'XSS in search', agent: 'web-api-specialist', target: '/?q=' }], agent: 'orchestrator' });
    expect(await call(ctx, 'submit_candidate', { ...candidate, agent: 'web-api-specialist' })).toContain('case_id is required');
    expect(await call(ctx, 'submit_candidate', { ...candidate, case_id: 'nope', agent: 'web-api-specialist' })).toContain('xss-search');
    expect(posted).toEqual([]);
    expect(ctx.state.cases.get('xss-search')).toMatchObject({ title: 'XSS in search', agent: 'web-api-specialist', candidates: 0 });
  });

  it('a candidate merged into an already stored finding still ends with one candidate.merged event', async () => {
    const { ctx, store } = setup('hold', (url) => (url.includes('bw7x') ? 'bw7x' : 'ok'));
    await call(ctx, 'submit_candidate', { ...candidate, agent: 'web-api-specialist' });
    await call(ctx, 'submit_candidate', { ...candidate, title: 'Same issue again', agent: 'web-api-specialist' });
    const ends = store.events.filter((e) => ['finding.confirmed', 'finding.suspected', 'candidate.merged', 'candidate.rejected'].includes(e.kind));
    expect(ends.map((e) => e.kind)).toEqual(['finding.confirmed', 'candidate.merged']);
    expect(ends[1]?.message).toBe('Merged into: Reflected marker');
    expect(ends[1]?.data).toMatchObject({ title: 'Reflected marker', findingId: store.findings[0]?.id });
    expect(typeof ends[1]?.data.candidateId).toBe('string');
  });

  it('counts http_request case_id and candidates per case; a skip keeps its note', async () => {
    const { ctx } = setup('hold', 'bw7x');
    await call(ctx, 'record_test_cases', {
      cases: [
        { id: 'xss-search', title: 'XSS in search', agent: 'web-api-specialist', target: '/?q=' },
        { id: 'idor', title: 'IDOR', agent: 'authz-specialist', target: '/api/x/1' },
      ],
    });
    await call(ctx, 'http_request', { method: 'GET', url: 'https://t.example/?q=a', purpose: 'p', case_id: 'xss-search', agent: 'web-api-specialist' });
    await call(ctx, 'submit_candidate', { ...candidate, case_id: 'xss-search', agent: 'web-api-specialist' });
    await call(ctx, 'update_test_case', { id: 'idor', status: 'skipped', note: 'no second object', agent: 'authz-specialist' });
    expect(ctx.state.cases.get('xss-search')).toMatchObject({ requests: 1, candidates: 1 });
    expect(ctx.state.cases.get('idor')).toMatchObject({ status: 'skipped', note: 'no second object' });
    await call(ctx, 'update_test_case', { id: 'idor', status: 'model_declined', note: 'would need a real user', agent: 'authz-specialist' });
    expect(ctx.state.cases.get('idor')).toMatchObject({ status: 'model_declined', note: 'would need a real user' });
  });
});

describe('Gate 2 notices on tool results', () => {
  it('prefixes the asking agent\'s next tool result once, and await_decision reports the status itself', async () => {
    const { ctx, store } = setup('hold');
    const asked = await call(ctx, 'http_request', { method: 'POST', url: 'https://t.example/api/Users', body: '{}', purpose: 'p', agent: 'authz-specialist' });
    expect(asked).toContain('Waiting for a human (Gate 2');
    const id = [...ctx.state.asks.keys()][0] ?? '';
    for (const entry of store.gate2.values()) entry.status = 'approved';
    expect(await call(ctx, 'await_decision', { gate2Id: id, max_seconds: 5, agent: 'authz-specialist' })).toBe(JSON.stringify({ gate2Id: id, status: 'approved' }));
    expect(await call(ctx, 'list_exchanges', { agent: 'authz-specialist' })).not.toContain('notices');

    await call(ctx, 'http_request', { method: 'PUT', url: 'https://t.example/api/Users/1', body: '{}', purpose: 'p', agent: 'authz-specialist' });
    for (const entry of store.gate2.values()) if (entry.status === 'pending') entry.status = 'denied';
    expect(await call(ctx, 'await_decision', { gate2Id: 'other', max_seconds: 1, agent: 'web-api-specialist' })).toBe('Unknown Gate 2 id other.');
    await watchGate2(ctx);
    const mine = await call(ctx, 'list_exchanges', { agent: 'authz-specialist' });
    expect(mine.startsWith('notices: ["Gate 2 denied: PUT /api/Users/1 as no test account. It was not sent; do not ask for it again."]\n')).toBe(true);
    expect(await call(ctx, 'list_exchanges', { agent: 'authz-specialist' })).not.toContain('notices');
  });

  it('await_decision refuses to wait while the agent still has cases to run', async () => {
    const { ctx } = setup('hold');
    await call(ctx, 'record_test_cases', { cases: [{ id: 'a', title: 'A', agent: 'authz-specialist', target: '/a' }, { id: 'b', title: 'B', agent: 'authz-specialist', target: '/b' }] });
    await call(ctx, 'http_request', { method: 'POST', url: 'https://t.example/api/a', body: '{}', purpose: 'p', case_id: 'a', agent: 'authz-specialist' });
    const id = [...ctx.state.asks.keys()][0] ?? '';
    expect(await call(ctx, 'await_decision', { gate2Id: id, max_seconds: 1, agent: 'authz-specialist' })).toContain('Not waiting: you still have test cases to run (b)');
  });
});
