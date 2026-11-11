import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { sendRequest } from './http-tool.js';
import { applySetCookies, cookieHeader, findLoginForm } from './login.js';

import type { HuntRun } from './types.js';

const LOGIN_PAGE = `<html><form action="login.php" method="post"><input type="text" name="username">
<input type="password" name="password"><input type="submit" name="Login" value="Login"><input type='hidden' name='user_token' value='tok123'></form></html>`;
const PASSWORD = 'p4ss-w0rd!';

describe('login form parsing and cookie jar', () => {
  it('finds the credential fields, submit button and hidden CSRF input', () => {
    expect(findLoginForm(LOGIN_PAGE)).toEqual({
      action: 'login.php',
      method: 'POST',
      userField: 'username',
      passwordField: 'password',
      fields: [{ name: 'Login', value: 'Login' }, { name: 'user_token', value: 'tok123' }],
    });
    expect(findLoginForm('<form><input name="q"></form>')).toBeNull();
  });

  it('keeps, replaces and drops cookies; the model\'s own cookie wins', () => {
    const jar = new Map<string, string>();
    applySetCookies(jar, ['a=1; Path=/', 'b=2; HttpOnly', 'a=3']);
    applySetCookies(jar, ['b=; Max-Age=0']);
    expect([...jar]).toEqual([['a', '3']]);
    expect(cookieHeader(jar, 'security=low; a=9')).toBe('a=9; security=low');
  });
});

function site(accounts?: HuntRun['testAccounts']) {
  const sent: { method: string; path: string; cookie: string | undefined; body: string | undefined }[] = [];
  let valid = false;
  let sessions = 0;
  const events = new FakeStore();
  const run: HuntRun = {
    id: 'r', tenantId: 't', requestId: 'q', assetId: 'a', assetName: 'A', objective: 'o',
    scope: { allowedOrigins: ['http://t.example'], excludedPaths: [] },
    budgetRequests: 20, budgetSeconds: 60, costCapUsd: 1, intrusiveness: 'active_safe',
    testAccounts: accounts ?? [{ role: 'admin', headerName: 'Cookie', headerValue: '', login: { username: 'admin', password: PASSWORD, loginUrl: null } }],
    releaseProven: 'hold', labOrigins: [],
  };
  const ctx: HuntContext = {
    run, store: events,
    log: new EventLog(events, 'r', { warn: () => undefined, error: () => undefined }),
    signal: new AbortController().signal,
    deps: {
      fetch: (input, init) => {
        const url = new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
        const headers = init?.headers as Record<string, string>;
        sent.push({ method: init?.method ?? 'GET', path: url.pathname, cookie: headers.cookie, body: init?.body as string | undefined });
        const redirect = (to: string, extra: Record<string, string> = {}): Response => new Response('', { status: 302, headers: { location: to, ...extra } });
        if (url.pathname === '/login.php' && init?.method === 'POST') {
          const ok = new URLSearchParams(init.body as string).get('password') === PASSWORD && new URLSearchParams(init.body as string).get('user_token') === 'tok123';
          if (!ok) return Promise.resolve(redirect('/login.php'));
          valid = true;
          sessions += 1;
          return Promise.resolve(redirect('/index.php', { 'set-cookie': `PHPSESSID=session-${sessions}-secretvalue; Path=/` }));
        }
        if (url.pathname === '/login.php') return Promise.resolve(new Response(LOGIN_PAGE, { headers: { 'set-cookie': 'PHPSESSID=anon-session-value; Path=/' } }));
        if (url.pathname === '/') return Promise.resolve(redirect('/login.php'));
        if (!valid || !(headers.cookie ?? '').includes('secretvalue')) return Promise.resolve(redirect('/login.php'));
        return Promise.resolve(new Response(`welcome ${headers.cookie ?? ''} ${url.pathname}`));
      },
      sleep: () => Promise.resolve(), now: () => 0, gate2TimeoutMs: 1000, webhookUrl: null, consoleOrigin: 'http://c.test',
      lookup: () => Promise.resolve([{ address: '93.184.215.14' }]),
    },
    state: newHuntState(),
  };
  return { ctx, sent, store: events, expire: () => { valid = false; } };
}

describe('login-form test account', () => {
  it('signs in with the CSRF token, injects the session, redacts it, and signs in again when it is lost', async () => {
    const { ctx, sent, store, expire } = site();
    const first = await sendRequest(ctx, 'web-api-specialist', { method: 'GET', url: 'http://t.example/vulnerabilities/sqli/', as_role: 'admin' }, { purpose: 'p', askGate2: true });
    expect(first.ok && first.status).toBe(200);
    expect(first.ok && first.body).toContain('[redacted]');
    expect(first.ok && first.body).not.toContain('secretvalue');
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /', 'GET /login.php', 'POST /login.php', 'GET /index.php', 'GET /vulnerabilities/sqli/']);
    expect(ctx.state.requestsUsed).toBe(5); // logins count against the budget
    expect(store.events.some((e) => e.kind === 'login.performed')).toBe(true);
    expect(JSON.stringify([store.events, store.exchanges])).not.toContain(PASSWORD);
    expect(JSON.stringify([store.events, store.exchanges])).not.toContain('secretvalue');

    expire();
    const again = await sendRequest(ctx, 'web-api-specialist', { method: 'GET', url: 'http://t.example/vulnerabilities/xss_r/', as_role: 'admin' }, { purpose: 'p', askGate2: true });
    expect(again.ok && again.status).toBe(200);
    expect(store.events.filter((e) => e.kind === 'login.performed')).toHaveLength(2);
  });

  it('a wrong password fails once, sends nothing as that role and stays out of the model\'s sight', async () => {
    const { ctx, sent, store } = site([{ role: 'admin', headerName: 'Cookie', headerValue: '', login: { username: 'admin', password: 'wrong', loginUrl: null } }]);
    const res = await sendRequest(ctx, 'recon', { method: 'GET', url: 'http://t.example/a', as_role: 'admin' }, { purpose: 'p', askGate2: true });
    expect(res.ok).toBe(false);
    expect(sent.some((s) => s.path === '/a')).toBe(false);
    expect(store.events.some((e) => e.kind === 'login.failed')).toBe(true);
    const before = sent.length;
    await sendRequest(ctx, 'recon', { method: 'GET', url: 'http://t.example/b', as_role: 'admin' }, { purpose: 'p', askGate2: true });
    expect(sent.length).toBe(before);
  });
});

describe('login wall', () => {
  it('says once, plainly, that most of the site is behind a login when no test account exists', async () => {
    const { ctx, store } = site([]);
    for (const p of ['/a', '/b', '/c', '/d']) await sendRequest(ctx, 'recon', { method: 'GET', url: `http://t.example${p}` }, { purpose: 'p', askGate2: true });
    const walls = store.events.filter((e) => e.kind === 'login.wall');
    expect(walls.map((e) => e.message)).toEqual(['Most of this site is behind a login; add a test account to test it.']);
    expect(ctx.state.loginWall).toBe(true);
  });
});
