import { describe, expect, it } from 'vitest';

import { EventLog, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { modelView, sendRequest } from './http-tool.js';

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
  intrusiveness: 'active_safe',
  testAccounts: [],
  releaseProven: 'auto',
};
const SECRET = 'Bearer s3cret-token-value';

function setup(options: { gate2TimeoutMs?: number; abort?: AbortController; decide?: (store: FakeStore) => void; run?: Partial<HuntRun>; respond?: string } = {}) {
  const store = new FakeStore();
  const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
  let clock = 0;
  const abort = options.abort ?? new AbortController();
  const ctx: HuntContext = {
    run: { ...run, ...options.run },
    store,
    log: new EventLog(store, run.id, { warn: () => undefined, error: () => undefined }),
    signal: abort.signal,
    deps: {
      fetch: (input, init) => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        sent.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) } });
        return Promise.resolve(new Response(options.respond ?? 'hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
      },
      sleep: (ms) => {
        clock += ms;
        options.decide?.(store);
        return Promise.resolve();
      },
      now: () => clock,
      gate2TimeoutMs: options.gate2TimeoutMs ?? 3000,
      webhookUrl: null,
      consoleOrigin: 'http://console.test',
    },
    state: { requestsUsed: 0, exchangeSeq: 0, paused: false, findings: 0, approved: new Set(), cases: new Map() },
  };
  return { ctx, store, sent };
}

const kinds = (store: FakeStore): string[] => store.events.map((e) => e.kind);

describe('sendRequest policy', () => {
  it('sends an in-scope GET and records the exchange', async () => {
    const { ctx, store, sent } = setup();
    const result = await sendRequest(ctx, 'recon', { method: 'get', url: 'https://t.example/a?x=1' }, { purpose: 'p', askGate2: true });
    expect(result).toMatchObject({ ok: true, status: 200, body: 'hello' });
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: 'https://t.example/a?x=1', method: 'GET' }]);
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

  it('puts the exact request body (clamped) on gate2.requested, never a test-account credential', async () => {
    const { ctx, store } = setup({
      gate2TimeoutMs: 1000,
      run: { testAccounts: [{ role: 'customer_a', headerName: 'Authorization', headerValue: SECRET }] },
    });
    const body = `{"couponData":"X","pad":"${'p'.repeat(3000)}"}`;
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/rest/basket/7/checkout', body, as_role: 'customer_a' }, { purpose: 'coupon', askGate2: true });
    const requested = store.events.find((e) => e.kind === 'gate2.requested');
    expect(requested?.data).toMatchObject({ method: 'POST', asRole: 'customer_a' });
    expect(requested?.data.body).toBe(body.slice(0, 2048));
    expect(JSON.stringify(store.events)).not.toContain(SECRET);
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

describe('passive ceiling', () => {
  it('refuses POST, PUT and PATCH without raising Gate 2, including validator replays', async () => {
    const { ctx, store, sent } = setup({ run: { intrusiveness: 'passive' } });
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const result = await sendRequest(ctx, 'authz-specialist', { method, url: 'https://t.example/api/x' }, { purpose: 'p', askGate2: true });
      expect(result.ok).toBe(false);
    }
    const replay = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/x' }, { purpose: 'p', askGate2: false });
    expect(replay.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(store.gate2.size).toBe(0);
    expect(store.events.map((e) => e.data.rule)).toEqual(new Array<string>(4).fill('above_max_intrusiveness'));
  });

  it('still sends GET, HEAD and OPTIONS', async () => {
    const { ctx, sent } = setup({ run: { intrusiveness: 'passive' } });
    for (const method of ['GET', 'HEAD', 'OPTIONS']) await sendRequest(ctx, 'recon', { method, url: 'https://t.example/' }, { purpose: 'p', askGate2: true });
    expect(sent.map((s) => s.method)).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });
});

describe('grey-box test accounts', () => {
  const testAccounts = [{ role: 'customer', headerName: 'Authorization', headerValue: SECRET }];

  it('injects the credential header by role and keeps the value out of everything stored or returned', async () => {
    const { ctx, store, sent } = setup({ run: { testAccounts }, respond: `echo ${SECRET} end` });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', as_role: 'customer' }, { purpose: 'p', askGate2: true });
    expect(sent[0]?.headers.authorization).toBe(SECRET);
    if (!result.ok) throw new Error('expected a response');
    expect(JSON.stringify(modelView(result))).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(store.exchanges)).not.toContain(SECRET);
    expect(JSON.stringify(store.events)).not.toContain(SECRET);
    expect(store.exchanges[0]?.requestHeaders).toEqual({ Authorization: '[redacted: role customer]' });
    expect(store.exchanges[0]?.responseBody).toBe('echo [redacted] end');
    expect(store.events[0]?.data.asRole).toBe('customer');
  });

  it('redacts bare, JSON-escaped and other-account tokens, also without a role', async () => {
    const accounts = [...testAccounts, { role: 'admin', headerName: 'Authorization', headerValue: 'Bearer adm/n-token' }];
    const { ctx, store } = setup({ run: { testAccounts: accounts }, respond: '{"a":"s3cret-token-value","b":"adm\\/n-token","c":"adm/n-token"}' });
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/me' }, { purpose: 'p', askGate2: true });
    if (!result.ok) throw new Error('expected a response');
    expect(result.body).toBe('{"a":"[redacted]","b":"[redacted]","c":"[redacted]"}');
    expect(store.exchanges[0]?.responseBody).toBe(result.body);
  });

  it('asks Gate 2 again when an approved request is sent as another role', async () => {
    const accounts = [...testAccounts, { role: 'admin', headerName: 'Authorization', headerValue: 'Bearer admin-token' }];
    const { ctx, store, sent } = setup({
      run: { testAccounts: accounts },
      decide: (s) => {
        for (const entry of s.gate2.values()) if (entry.status === 'pending') entry.status = 'approved';
      },
    });
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/items', as_role: 'customer' }, { purpose: 'p', askGate2: true });
    const replay = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/items', as_role: 'admin' }, { purpose: 'p', askGate2: false });
    expect(replay.ok).toBe(false);
    expect(sent).toHaveLength(1);
    expect(store.events.at(-1)?.data.rule).toBe('gate2_required');
    expect([...store.gate2.values()][0]?.row.whyOutside).toContain('as test account role customer');
  });

  it('overrides a header of the same name sent by the model', async () => {
    const { ctx, sent } = setup({ run: { testAccounts } });
    await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', headers: { authorization: 'Bearer guess' }, as_role: 'customer' }, { purpose: 'p', askGate2: true });
    expect(sent[0]?.headers.authorization).toBe(SECRET);
  });

  it('refuses an unknown role without sending', async () => {
    const { ctx, store, sent } = setup({ run: { testAccounts } });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', as_role: 'admin' }, { purpose: 'p', askGate2: true });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(store.events[0]?.data.rule).toBe('unknown_role');
  });
});
