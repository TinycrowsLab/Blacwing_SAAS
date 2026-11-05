import { describe, expect, it } from 'vitest';

import { EventLog, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { recordProven } from './tools.js';
import { buildEvidence, candidateSchema } from './validator.js';

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
};

function setup(releaseProven: HuntRun['releaseProven']) {
  const store = new FakeStore();
  const posted: string[] = [];
  const ctx: HuntContext = {
    run: { ...run, releaseProven },
    store,
    log: new EventLog(store, run.id, { warn: () => undefined, error: () => undefined }),
    signal: new AbortController().signal,
    deps: {
      fetch: (input) => {
        posted.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
        return Promise.resolve(new Response('ok'));
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      gate2TimeoutMs: 1000,
      webhookUrl: 'https://hooks.example/x',
      consoleOrigin: 'http://console.test',
    },
    state: { requestsUsed: 0, exchangeSeq: 0, paused: false, findings: 0, approved: new Set(), cases: new Map() },
  };
  return { ctx, store, posted };
}

const row = {
  id: 'f1',
  fingerprint: 'fp',
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
});

describe('remediation (optional, stored as evidence.remediation)', () => {
  const candidate = {
    title: 't',
    vulnClass: 'xss',
    cwe: 'CWE-79',
    owasp: 'A03',
    severity: 'high',
    description: 'd',
    probe: { method: 'GET', url: 'https://t.example/?q=<b>' },
    control: { method: 'GET', url: 'https://t.example/?q=b' },
    oracle: { type: 'body_contains', value: '<b>' },
  } as const;
  const sent = { ok: true as const, exchangeId: 'e', status: 200, headers: {}, body: '<b>', bodyBytes: 3 };

  it('is stored when given and absent otherwise', () => {
    const withFix = candidateSchema.parse({ ...candidate, remediation: ' Encode output. ' });
    expect(buildEvidence(withFix, sent, sent, [])).toMatchObject({ remediation: 'Encode output.' });
    expect(buildEvidence(candidateSchema.parse(candidate), sent, sent, [])).not.toHaveProperty('remediation');
    expect(candidateSchema.safeParse({ ...candidate, remediation: 'x'.repeat(1001) }).success).toBe(false);
  });
});
