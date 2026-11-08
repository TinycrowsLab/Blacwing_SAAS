import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { awaitDecision, closePendingAsks, modelView, sendRequest, takeNotices, watchGate2 } from './http-tool.js';

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
  labOrigins: [],
};
const SECRET = 'Bearer s3cret-token-value';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const PUBLIC_IP = '93.184.215.14';

interface SetupOptions {
  gate2TimeoutMs?: number;
  abort?: AbortController;
  decide?: (store: FakeStore) => void;
  run?: Partial<HuntRun>;
  respond?: string;
  responseHeaders?: Record<string, string>;
  resolve?: (host: string) => string[];
}

function setup(options: SetupOptions = {}) {
  const store = new FakeStore();
  const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
  const looked: string[] = [];
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
        return Promise.resolve(new Response(options.respond ?? 'hello', { status: 200, headers: { 'content-type': 'text/plain', ...options.responseHeaders } }));
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
      lookup: (host) => {
        looked.push(host);
        return Promise.resolve((options.resolve?.(host) ?? [PUBLIC_IP]).map((address) => ({ address })));
      },
    },
    state: newHuntState(),
  };
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { ctx, store, sent, looked, advance };
}

const kinds = (store: FakeStore): string[] => store.events.map((e) => e.kind);
const approveAll = (s: FakeStore): void => {
  for (const entry of s.gate2.values()) if (entry.status === 'pending') entry.status = 'approved';
};
const opts = { purpose: 'p', askGate2: true } as const;

describe('sendRequest policy', () => {
  it('sends an in-scope GET and records the exchange', async () => {
    const { ctx, store, sent } = setup();
    const result = await sendRequest(ctx, 'recon', { method: 'get', url: 'https://t.example/a?x=1' }, opts);
    expect(result).toMatchObject({ ok: true, status: 200, body: 'hello' });
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: 'https://t.example/a?x=1', method: 'GET' }]);
    expect(kinds(store)).toEqual(['http.sent']);
    expect(store.exchanges[0]).toMatchObject({ outcome: 'sent', agent: 'recon', seq: 1 });
  });

  it('refuses out-of-scope, excluded and destructive requests without any I/O', async () => {
    const { ctx, store, sent, looked } = setup();
    for (const [method, url] of [['GET', 'https://other.example/'], ['GET', 'https://t.example/private/x'], ['DELETE', 'https://t.example/a'], ['TRACE', 'https://t.example/a'], ['GET', 'https://t.example//private;x']] as const) {
      const result = await sendRequest(ctx, 'recon', { method, url }, opts);
      expect(result.ok).toBe(false);
    }
    expect(sent).toEqual([]);
    expect(looked).toEqual([]);
    expect(kinds(store)).toEqual(new Array<string>(5).fill('policy.blocked'));
    expect(store.events.map((e) => e.data.rule)).toEqual(['out_of_scope_origin', 'excluded_path', 'destructive_method', 'destructive_method', 'excluded_path']);
    expect(store.exchanges.every((e) => e.outcome === 'blocked')).toBe(true);
    expect(ctx.state.requestsUsed).toBe(0);
  });

  it('enforces the request budget', async () => {
    const { ctx, store } = setup();
    for (let i = 0; i < 3; i += 1) await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(result.ok).toBe(false);
    expect(store.events.at(-1)?.data.rule).toBe('request_budget');
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
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('non-blocking Gate 2', () => {
  it('returns pending at once without waiting or sending, and a repeat returns the same ask', async () => {
    let slept = 0;
    const { ctx, store, sent } = setup({
      decide: () => {
        slept += 1;
      },
    });
    const first = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x', body: '{}' }, { ...opts, caseId: 'c1' });
    const again = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x?b=2', body: '{"b":2}' }, opts);
    expect(first).toMatchObject({ ok: false, pending: true });
    expect(again).toMatchObject({ ok: false, pending: true, gate2Id: (first.ok ? undefined : first.gate2Id) ?? '' });
    expect(first.ok ? '' : first.refusal).toContain('Carry on with other test cases');
    expect(slept).toBe(0);
    expect(sent).toEqual([]);
    expect(store.gate2.size).toBe(1);
    expect(kinds(store)).toEqual(['gate2.requested']);
    expect(store.events[0]?.data).toMatchObject({ blocking: false, caseId: 'c1' });
  });

  it('delivers an approval as a notice once; the resend is sent and names the approval', async () => {
    const { ctx, store, sent } = setup();
    const ask = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x', body: '{}' }, opts);
    approveAll(store);
    await watchGate2(ctx);
    await watchGate2(ctx);
    expect(takeNotices(ctx, 'authz-specialist')).toEqual(['Gate 2 approved: POST /api/x as no test account. Send it again now.']);
    expect(takeNotices(ctx, 'authz-specialist')).toEqual([]);
    const resend = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x', body: '{}' }, opts);
    const replay = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/x?a=2' }, { purpose: 'p', askGate2: false });
    const other = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/y' }, { purpose: 'p', askGate2: false });
    expect([resend.ok, replay.ok, other.ok]).toEqual([true, true, false]);
    expect(sent).toHaveLength(2);
    expect(store.gate2.size).toBe(1);
    expect(kinds(store).filter((k) => k === 'gate2.decided')).toHaveLength(1);
    expect(store.events.find((e) => e.kind === 'http.sent')?.data.gate2Id).toBe(ask.ok ? '' : ask.gate2Id);
    expect(store.events.at(-1)?.data.rule).toBe('gate2_required');
  });

  it('never asks again after a denial or an expiry', async () => {
    const { ctx, store, sent, advance } = setup({ gate2TimeoutMs: 3000 });
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x' }, opts);
    for (const entry of store.gate2.values()) entry.status = 'denied';
    await sendRequest(ctx, 'web-api-specialist', { method: 'PUT', url: 'https://t.example/api/y' }, opts);
    await watchGate2(ctx);
    advance(3000);
    await watchGate2(ctx);
    expect([...store.gate2.values()].map((g) => g.status)).toEqual(['denied', 'expired']);
    expect(takeNotices(ctx, 'authz-specialist')[0]).toContain('Gate 2 denied: POST /api/x');
    expect(takeNotices(ctx, 'web-api-specialist')[0]).toContain('Gate 2 expired (no answer in time): PUT /api/y');
    const denied = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x' }, opts);
    const expired = await sendRequest(ctx, 'authz-specialist', { method: 'PUT', url: 'https://t.example/api/y' }, opts);
    expect(denied.ok ? '' : denied.refusal).toContain('Do not ask for it again');
    expect(store.gate2.size).toBe(2);
    expect(sent).toEqual([]);
    expect(store.events.filter((e) => e.kind === 'policy.blocked').map((e) => e.data.rule)).toEqual(['gate2_denied', 'gate2_expired']);
    expect(store.events.filter((e) => e.kind === 'gate2.decided').map((e) => e.data)).toEqual([
      { gate2Id: expect.any(String) as string, status: 'denied' },
      { gate2Id: expect.any(String) as string, status: 'expired', reason: 'deadline' },
    ]);
    expect(expired.ok).toBe(false);
  });

  it('await_decision waits for the human and honours kill', async () => {
    let polls = 0;
    const { ctx, store } = setup({
      decide: (s) => {
        polls += 1;
        if (polls === 2) approveAll(s);
      },
    });
    const ask = await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x' }, opts);
    const id = ask.ok ? '' : (ask.gate2Id ?? '');
    expect(await awaitDecision(ctx, id, 30_000)).toBe('approved');
    expect(await awaitDecision(ctx, 'nope', 1000)).toBe('unknown');
    expect(store.events.at(-1)).toMatchObject({ kind: 'gate2.decided', data: { status: 'approved' } });

    const abort = new AbortController();
    const killed = setup({
      abort,
      decide: () => {
        abort.abort();
      },
    });
    const pending = await sendRequest(killed.ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x' }, opts);
    expect(await awaitDecision(killed.ctx, pending.ok ? '' : (pending.gate2Id ?? ''), 30_000)).toBe('halted');
  });

  it('puts the exact request body (clamped, scrubbed) on the ask, never a test-account credential', async () => {
    const { ctx, store } = setup({ run: { testAccounts: [{ role: 'customer_a', headerName: 'Authorization', headerValue: SECRET }] } });
    const body = `{"couponData":"X","pad":"${'p'.repeat(3000)}"}`;
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/rest/basket/7/checkout', body, as_role: 'customer_a' }, { purpose: 'coupon', askGate2: true });
    const requested = store.events.find((e) => e.kind === 'gate2.requested');
    expect(requested?.data).toMatchObject({ method: 'POST', asRole: 'customer_a' });
    expect(requested?.data.body).toBe(body.slice(0, 2048));
    expect([...store.gate2.values()][0]?.row).toMatchObject({ body: body.slice(0, 2048), asRole: 'customer_a' });
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/rest/user/login', body: '{"email":"a@b.c","password":"hunter2"}' }, opts);
    expect(JSON.stringify(store.events)).not.toContain('hunter2');
    expect(JSON.stringify([...store.gate2.values()])).not.toContain('hunter2');
    expect(JSON.stringify(store.events)).not.toContain(SECRET);
  });

  it('raises Gate 2 for a GET that looks state-changing and says why', async () => {
    const { ctx, store, sent } = setup();
    const result = await sendRequest(ctx, 'web-api-specialist', { method: 'GET', url: 'https://t.example/vulnerabilities/csrf/?password_new=a&Change=Change' }, opts);
    expect(result).toMatchObject({ ok: false, pending: true });
    expect(sent).toEqual([]);
    expect([...store.gate2.values()][0]?.row.whyOutside).toContain('This GET looks like it changes state (password)');
  });

  it('closes every pending ask at the end of the run', async () => {
    const { ctx, store } = setup();
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/x' }, opts);
    await closePendingAsks(ctx, 'killed');
    expect([...store.gate2.values()].map((g) => g.status)).toEqual(['denied']);
    expect(store.events.at(-1)).toMatchObject({ kind: 'gate2.decided', data: { status: 'denied', reason: 'killed' } });
    expect([...ctx.state.asks.values()][0]?.closedUnanswered).toBe(true);
    await closePendingAsks(ctx, 'run_ended');
    expect(kinds(store).filter((k) => k === 'gate2.decided')).toHaveLength(1);
  });
});

describe('passive ceiling', () => {
  it('refuses POST, PUT, PATCH and a state-changing GET without raising Gate 2, including validator replays', async () => {
    const { ctx, store, sent } = setup({ run: { intrusiveness: 'passive' } });
    for (const [method, path] of [['POST', '/api/x'], ['PUT', '/api/x'], ['PATCH', '/api/x'], ['GET', '/logout']] as const) {
      const result = await sendRequest(ctx, 'authz-specialist', { method, url: `https://t.example${path}` }, opts);
      expect(result.ok).toBe(false);
    }
    const replay = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/x' }, { purpose: 'p', askGate2: false });
    expect(replay.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(store.gate2.size).toBe(0);
    expect(store.events.map((e) => e.data.rule)).toEqual(new Array<string>(5).fill('above_max_intrusiveness'));
  });

  it('still sends GET, HEAD and OPTIONS', async () => {
    const { ctx, sent } = setup({ run: { intrusiveness: 'passive' } });
    for (const method of ['GET', 'HEAD', 'OPTIONS']) await sendRequest(ctx, 'recon', { method, url: 'https://t.example/' }, opts);
    expect(sent.map((s) => s.method)).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });
});

describe('private-range guard at send time', () => {
  it('refuses an origin that resolves to a private or loopback address, without sending or spending budget', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '::1', '169.254.169.254']) {
      const { ctx, store, sent } = setup({ resolve: () => [PUBLIC_IP, address] });
      const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
      expect(result.ok).toBe(false);
      expect(sent).toEqual([]);
      expect(ctx.state.requestsUsed).toBe(0);
      expect(store.events[0]?.data.rule).toBe('private_address');
    }
  });

  it('lets an operator-listed lab origin reach loopback, never link-local or metadata', async () => {
    const lab = { scope: { allowedOrigins: ['http://127.0.0.1:3001'], excludedPaths: [] }, labOrigins: ['http://127.0.0.1:3001'] };
    const ok = setup({ run: lab, resolve: () => ['127.0.0.1'] });
    expect((await sendRequest(ok.ctx, 'recon', { method: 'GET', url: 'http://127.0.0.1:3001/' }, opts)).ok).toBe(true);
    expect(ok.looked).toEqual(['127.0.0.1']);
    for (const address of ['169.254.169.254', '0.0.0.0', 'fd00:ec2::254', '::ffff:169.254.169.254']) {
      const refused = setup({ run: lab, resolve: () => [address] });
      expect((await sendRequest(refused.ctx, 'recon', { method: 'GET', url: 'http://127.0.0.1:3001/' }, opts)).ok).toBe(false);
      expect(refused.store.events[0]?.data.rule).toBe('private_address');
    }
    const notLab = setup({ run: { ...lab, labOrigins: [] }, resolve: () => ['127.0.0.1'] });
    expect((await sendRequest(notLab.ctx, 'recon', { method: 'GET', url: 'http://127.0.0.1:3001/' }, opts)).ok).toBe(false);
  });

  it('records a host that does not resolve as an error, nothing sent', async () => {
    const { ctx, store, sent } = setup({ resolve: () => [] });
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(store.exchanges[0]).toMatchObject({ outcome: 'error', reason: 'dns_failed' });
  });
});

describe('stored evidence is scrubbed; the model view is not', () => {
  it('scrubs a JWT, Set-Cookie and a password field at store time and keeps them for the model', async () => {
    const respond = `{"authentication":{"token":"${JWT}"},"password":"vulnerables"}`;
    const { ctx, store } = setup({ respond, responseHeaders: { 'set-cookie': `token=${JWT}; Path=/` } });
    const result = await sendRequest(ctx, 'recon', { method: 'POST', url: 'https://t.example/rest/user/login', headers: { Authorization: `Bearer ${JWT}` }, body: '{"password":"hunter2"}' }, opts);
    expect(result.ok).toBe(false); // a POST asks first
    approveAll(store);
    await watchGate2(ctx);
    const sent = await sendRequest(ctx, 'recon', { method: 'POST', url: 'https://t.example/rest/user/login', headers: { Authorization: `Bearer ${JWT}` }, body: '{"password":"hunter2"}' }, opts);
    if (!sent.ok) throw new Error('expected a response');
    expect(modelView(sent).body).toContain(JWT);
    expect(sent.headers['set-cookie']).toContain(JWT);
    const stored = JSON.stringify(store.exchanges);
    for (const secret of [JWT, 'vulnerables', 'hunter2']) expect(stored).not.toContain(secret);
    expect(JSON.stringify(sent.request)).not.toContain(JWT);
    expect(JSON.stringify(store.events)).not.toContain(JWT);
  });

  it('records the headers actually sent, with the credential as a role placeholder', async () => {
    const { ctx, store, sent } = setup({ run: { testAccounts: [{ role: 'customer', headerName: 'Authorization', headerValue: SECRET }] } });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', headers: { 'X-Trace': '1', Host: 'evil' }, as_role: 'customer' }, opts);
    if (!result.ok) throw new Error('expected a response');
    expect(sent[0]?.headers).toEqual({ 'user-agent': 'blackwing-hunt/1', 'x-trace': '1', authorization: SECRET });
    const recorded = { 'user-agent': 'blackwing-hunt/1', 'x-trace': '1', authorization: '[redacted: role customer]' };
    expect(store.exchanges[0]?.requestHeaders).toEqual(recorded);
    expect(result.request).toEqual({ method: 'GET', url: 'https://t.example/me', headers: recorded, body: null, asRole: 'customer' });
  });
});

describe('grey-box test accounts', () => {
  const testAccounts = [{ role: 'customer', headerName: 'Authorization', headerValue: SECRET }];

  it('injects the credential header by role and keeps the value out of everything stored or returned', async () => {
    const { ctx, store, sent } = setup({ run: { testAccounts }, respond: `echo ${SECRET} end` });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', as_role: 'customer' }, opts);
    expect(sent[0]?.headers.authorization).toBe(SECRET);
    if (!result.ok) throw new Error('expected a response');
    expect(JSON.stringify(modelView(result))).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(store.exchanges)).not.toContain(SECRET);
    expect(JSON.stringify(store.events)).not.toContain(SECRET);
    expect(store.exchanges[0]?.responseBody).toBe('echo [redacted] end');
    expect(store.events[0]?.data.asRole).toBe('customer');
  });

  it('redacts bare, JSON-escaped and other-account tokens, also without a role', async () => {
    const accounts = [...testAccounts, { role: 'admin', headerName: 'Authorization', headerValue: 'Bearer adm/n-token' }];
    const { ctx, store } = setup({ run: { testAccounts: accounts }, respond: '{"a":"s3cret-token-value","b":"adm\\/n-token","c":"adm/n-token"}' });
    const result = await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/me' }, opts);
    if (!result.ok) throw new Error('expected a response');
    expect(result.body).toBe('{"a":"[redacted]","b":"[redacted]","c":"[redacted]"}');
    expect(store.exchanges[0]?.responseBody).toBe(result.body);
  });

  it('asks Gate 2 again when an approved request is sent as another role', async () => {
    const accounts = [...testAccounts, { role: 'admin', headerName: 'Authorization', headerValue: 'Bearer admin-token' }];
    const { ctx, store, sent } = setup({ run: { testAccounts: accounts } });
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/items', as_role: 'customer' }, opts);
    approveAll(store);
    await watchGate2(ctx);
    await sendRequest(ctx, 'authz-specialist', { method: 'POST', url: 'https://t.example/api/items', as_role: 'customer' }, opts);
    const replay = await sendRequest(ctx, 'validator', { method: 'POST', url: 'https://t.example/api/items', as_role: 'admin' }, { purpose: 'p', askGate2: false });
    expect(replay.ok).toBe(false);
    expect(sent).toHaveLength(1);
    expect(store.events.at(-1)?.data.rule).toBe('gate2_required');
    expect([...store.gate2.values()][0]?.row.whyOutside).toContain('as test account role customer');
  });

  it('overrides a header of the same name sent by the model', async () => {
    const { ctx, sent } = setup({ run: { testAccounts } });
    await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', headers: { authorization: 'Bearer guess' }, as_role: 'customer' }, opts);
    expect(sent[0]?.headers.authorization).toBe(SECRET);
  });

  it('refuses an unknown role without sending', async () => {
    const { ctx, store, sent } = setup({ run: { testAccounts } });
    const result = await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', as_role: 'admin' }, opts);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(store.events[0]?.data.rule).toBe('unknown_role');
  });

  it('counts requests per role and per test case', async () => {
    const { ctx } = setup({ run: { testAccounts } });
    ctx.state.cases.set('c1', { title: 't', agent: 'authz-specialist', status: 'proposed', note: null, requests: 0, candidates: 0 });
    await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me', as_role: 'Customer' }, { ...opts, caseId: 'c1' });
    await sendRequest(ctx, 'authz-specialist', { method: 'GET', url: 'https://t.example/me' }, { ...opts, caseId: 'c1' });
    expect(Object.fromEntries(ctx.state.roleCounts)).toEqual({ customer: 1 });
    expect(ctx.state.cases.get('c1')?.requests).toBe(2);
  });
});

describe('accounts.unused warning', () => {
  const testAccounts = [
    { role: 'alice', headerName: 'Authorization', headerValue: 'Bearer a' },
    { role: 'bob', headerName: 'Authorization', headerValue: 'Bearer b' },
  ];
  const warnings = (store: FakeStore) => store.events.filter((e) => e.kind === 'accounts.unused');

  it('fires once when the first specialist sends and no request used a role yet', async () => {
    const { ctx, store } = setup({ run: { testAccounts, budgetRequests: 10 } });
    await sendRequest(ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(warnings(store)).toEqual([]);
    await sendRequest(ctx, 'web-api-specialist', { method: 'GET', url: 'https://t.example/a' }, opts);
    await sendRequest(ctx, 'web-api-specialist', { method: 'GET', url: 'https://t.example/b' }, opts);
    expect(warnings(store)).toEqual([
      { kind: 'accounts.unused', stage: 'policy', message: 'No request has used your test accounts yet (alice, bob).', data: { roles: ['alice', 'bob'], sentSoFar: 2 } },
    ]);
  });

  it('fires after 25 recon requests, and never once a role was used or without accounts', async () => {
    const recon = setup({ run: { testAccounts, budgetRequests: 30 } });
    for (let i = 0; i < 25; i += 1) await sendRequest(recon.ctx, 'recon', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(warnings(recon.store)).toHaveLength(1);
    const used = setup({ run: { testAccounts, budgetRequests: 10 } });
    await sendRequest(used.ctx, 'recon', { method: 'GET', url: 'https://t.example/', as_role: 'bob' }, opts);
    await sendRequest(used.ctx, 'web-api-specialist', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(warnings(used.store)).toEqual([]);
    const none = setup();
    await sendRequest(none.ctx, 'web-api-specialist', { method: 'GET', url: 'https://t.example/' }, opts);
    expect(warnings(none.store)).toEqual([]);
  });
});
