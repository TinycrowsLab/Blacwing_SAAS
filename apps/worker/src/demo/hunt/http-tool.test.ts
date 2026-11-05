import { describe, expect, it } from 'vitest';

import { EventLog, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { sendRequest } from './http-tool.js';

import type { HuntRun } from './types.js';

const run: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'test',
  scope: { allowedOrigins: ['https://t.example'], excludedPaths: ['/private'] },
  budgetRequests: 3,
  budgetSeconds: 60,
  costCapUsd: 1,
};

function setup(options: { gate2TimeoutMs?: number; abort?: AbortController; decide?: (store: FakeStore) => void } = {}) {
  const store = new FakeStore();
  const sent: { url: string; method: string }[] = [];
  let clock = 0;
  const abort = options.abort ?? new AbortController();
  const ctx: HuntContext = {
    run,
    store,
    log: new EventLog(store, run.id, 1, { warn: () => undefined, error: () => undefined }),
    signal: abort.signal,
    deps: {
      fetch: (input, init) => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        sent.push({ url, method: init?.method ?? 'GET' });
        return Promise.resolve(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
      },
      sleep: (ms) => {
        clock += ms;
        options.decide?.(store);
        return Promise.resolve();
      },
      now: () => clock,
      gate2TimeoutMs: options.gate2TimeoutMs ?? 3000,
    },
    state: { requestsUsed: 0, exchangeSeq: 0, paused: false, findings: 0, approved: new Set() },
  };
  return { ctx, store, sent };
}

const kinds = (store: FakeStore): string[] => store.events.map((e) => e.kind);

describe('sendRequest policy', () => {
  it('sends an in-scope GET and records the exchange', async () => {
    const { ctx, store, sent } = setup();
    const result = await sendRequest(ctx, 'recon', { method: 'get', url: 'https://t.example/a?x=1' }, { purpose: 'p', askGate2: true });
    expect(result).toMatchObject({ ok: true, status: 200, body: 'hello' });
    expect(sent).toEqual([{ url: 'https://t.example/a?x=1', method: 'GET' }]);
    expect(kinds(store)).toEqual(['http.sent']);
    expect(store.exchanges[0]).toMatchObject({ outcome: 'sent', agent: 'recon', seq: 1 });
  });

  it('refuses out-of-scope, excluded and destructive requests without any I/O', async () => {
    const { ctx, store, sent } = setup();
    for (const [method, url] of [['GET', 'https://other.example/'], ['GET', 'https://t.example/private/x'], ['DELETE', 'https://t.example/a'], ['TRACE', 'https://t.example/a']] as const) {
      const result = await sendRequest(ctx, 'recon', { method, url }, { purpose: 'p', askGate2: true });
      expect(result.ok).toBe(false);
    }
    expect(sent).toEqual([]);
    expect(kinds(store)).toEqual(['policy.blocked', 'policy.blocked', 'policy.blocked', 'policy.blocked']);
    expect(store.events.map((e) => e.data.rule)).toEqual(['out_of_scope_origin', 'excluded_path', 'destructive_method', 'destructive_method']);
    expect(store.exchanges.every((e) => e.outcome === 'blocked')).toBe(true);
    expect(ctx.state.requestsUsed).toBe(0);
  });

  it('enforces the request budget', async () => {
    const { ctx, store } = setup();
    for (let i = 0; i < 3; i += 1) await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, { purpose: 'p', askGate2: true });
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, { purpose: 'p', askGate2: true });
    expect(result.ok).toBe(false);
    expect(store.events.at(-1)?.data.rule).toBe('request_budget');
  });

  it('denies a state-changing request when nobody decides before the deadline', async () => {
    const { ctx, store, sent } = setup({ gate2TimeoutMs: 3000 });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x', body: '{}' }, { purpose: 'need it', askGate2: true });
    expect(result).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    expect([...store.gate2.values()].map((g) => g.status)).toEqual(['expired']);
    expect(kinds(store)).toEqual(['gate2.requested', 'gate2.decided']);
    expect(store.exchanges[0]).toMatchObject({ outcome: 'denied', reason: 'gate2_expired' });
  });

  it('sends after approval and remembers the approval for that method and path only', async () => {
    const { ctx, store, sent } = setup({
      decide: (s) => {
        for (const entry of s.gate2.values()) if (entry.status === 'pending') entry.status = 'approved';
      },
    });
    const first = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x?a=1', body: '{}' }, { purpose: 'p', askGate2: true });
    const second = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/x?a=2' }, { purpose: 'p', askGate2: false });
    const other = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/y' }, { purpose: 'p', askGate2: false });
    expect([first.ok, second.ok, other.ok]).toEqual([true, true, false]);
    expect(sent).toHaveLength(2);
    expect(store.gate2.size).toBe(1);
    expect(store.events.at(-1)?.data.rule).toBe('gate2_required');
  });

  it('denies a pending Gate 2 request when the run is killed', async () => {
    const abort = new AbortController();
    const { ctx, store, sent } = setup({
      abort,
      decide: () => {
        abort.abort();
      },
    });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'PUT', url: 'https://t.example/api/x' }, { purpose: 'p', askGate2: true });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect([...store.gate2.values()].map((g) => g.status)).toEqual(['denied']);
  });

  it('waits while paused and does not send once halted', async () => {
    const abort = new AbortController();
    const { ctx, sent } = setup({
      abort,
      decide: () => {
        abort.abort();
      },
    });
    ctx.state.paused = true;
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, { purpose: 'p', askGate2: true });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
