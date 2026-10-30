// The five BFF route handlers end to end over the real auth service, an in-memory Valkey and a fake
// IdP (IAM-002, #334). Only the process-wide wiring (`runtime`) is replaced.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as callback } from './callback/route';
import { GET as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as refresh } from './refresh/route';
import { GET as sessionRoute } from './session/route';
import { harness, tokens, CONSOLE_ORIGIN, type Harness } from '../../../lib/auth/auth.test-helpers';
import { IdpRejectedError, IdpUnavailableError } from '../../../lib/auth/oidc';
import { SessionStoreUnavailableError } from '../../../lib/auth/session-store';

import type { AuthRuntime } from '../../../lib/auth/runtime';

const state: { h: Harness } = { h: harness() };

vi.mock('../../../lib/auth/runtime', () => ({
  getAuthRuntime: (): AuthRuntime => ({
    config: {
      issuer: 'https://id.example.com',
      clientId: 'c',
      clientSecret: undefined,
      consoleOrigin: CONSOLE_ORIGIN,
      redirectUri: `${CONSOLE_ORIGIN}/auth/callback`,
      redisUrl: 'redis://unused',
      sessionKeys: state.h.keys,
      sessionAdmin: undefined,
    },
    service: state.h.service,
    revocation: state.h.revocation,
  }),
}));

beforeEach(() => {
  state.h = harness();
});

const API = `${CONSOLE_ORIGIN}/api/auth`;

function cookieOf(response: Response, name: string): string | undefined {
  const line = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';')[0];
}

function req(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const { cookie, headers, ...rest } = init;
  return new Request(`${API}/${path}`, {
    ...rest,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(headers as Record<string, string>),
    },
  });
}

/** Runs login + callback through the handlers; returns the session cookie header and CSRF token. */
async function signIn(returnTo = '/runs/1'): Promise<{ cookie: string; csrf: string }> {
  const start = await login(req(`login?returnTo=${encodeURIComponent(returnTo)}`));
  const target = new URL(start.headers.get('location') ?? '');
  const done = await callback(
    req(`callback?code=c1&state=${target.searchParams.get('state')}`, {
      cookie: `__Host-bw_login=${cookieOf(start, '__Host-bw_login')}`,
    }),
  );
  const session = cookieOf(done, '__Host-bw_session');
  if (session === undefined) throw new Error('no session cookie');
  const cookie = `__Host-bw_session=${session}`;
  const whoami = await sessionRoute(req('session', { cookie }));
  const body = (await whoami.json()) as { csrfToken: string };
  return { cookie, csrf: body.csrfToken };
}

describe('GET /api/auth/login', () => {
  it('redirects to Keycloak with PKCE S256, state and nonce and a sealed host-prefixed login cookie', async () => {
    const response = await login(req('login'));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.origin).toBe('https://id.example.com');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('state')).toBeTruthy();
    expect(target.searchParams.get('nonce')).toBeTruthy();
    const [setCookie] = response.headers.getSetCookie();
    expect(setCookie).toMatch(
      /^__Host-bw_login=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    expect(setCookie).not.toContain(target.searchParams.get('state') ?? 'x');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when the IdP is down', async () => {
    state.h.oidc.authorizationUrl.mockRejectedValueOnce(new IdpUnavailableError());
    const response = await login(req('login'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
  });
});

describe('GET /api/auth/callback', () => {
  it('establishes the session, returns to the allowlisted path and sets only host-prefixed httpOnly cookies', async () => {
    const start = await login(req('login?returnTo=/runs/9'));
    const target = new URL(start.headers.get('location') ?? '');
    const done = await callback(
      req(`callback?code=c1&state=${target.searchParams.get('state')}`, {
        cookie: `__Host-bw_login=${cookieOf(start, '__Host-bw_login')}`,
      }),
    );
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/runs/9`);
    const cookies = done.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-bw_login=; .*Max-Age=0$/);
    expect(cookies[1]).toMatch(
      /^__Host-bw_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    for (const cookie of cookies) {
      expect(cookie).toMatch(/; HttpOnly; Secure; SameSite=Lax/);
      expect(cookie).not.toMatch(/access-token|refresh-token|id-token/);
    }
  });

  it('never redirects off site, whatever returnTo says', async () => {
    const { cookie } = await signIn('https://evil.example/phish');
    expect(cookie).toBeTruthy();
    const start = await login(req('login?returnTo=//evil.example'));
    const target = new URL(start.headers.get('location') ?? '');
    const done = await callback(
      req(`callback?code=c&state=${target.searchParams.get('state')}`, {
        cookie: `__Host-bw_login=${cookieOf(start, '__Host-bw_login')}`,
      }),
    );
    expect(done.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/`);
  });

  it.each([
    ['a state mismatch', 'callback?code=c&state=forged', 'invalid_state'],
    ['no parameters', 'callback', 'invalid_state'],
    ['an oversized code', `callback?code=${'a'.repeat(5000)}&state=s`, 'invalid_state'],
    ['an IdP error with a forged state', 'callback?error=access_denied&state=s', 'invalid_state'],
  ])('rejects %s and creates no session', async (_label, path, reason) => {
    const start = await login(req('login'));
    const response = await callback(
      req(path, { cookie: `__Host-bw_login=${cookieOf(start, '__Host-bw_login')}` }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/login?error=${reason}`);
    expect(cookieOf(response, '__Host-bw_session')).toBeUndefined();
    expect(cookieOf(response, '__Host-bw_login')).toBe('');
    expect([...state.h.valkey.data.keys()].filter((k) => k.includes(':sess:'))).toEqual([]);
  });

  it('reports a denied login and a failed exchange so the user can retry', async () => {
    const start = await login(req('login'));
    const target = new URL(start.headers.get('location') ?? '');
    const login1 = `__Host-bw_login=${cookieOf(start, '__Host-bw_login')}`;
    const denied = await callback(
      req(`callback?error=access_denied&state=${target.searchParams.get('state')}`, {
        cookie: login1,
      }),
    );
    expect(denied.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/login?error=denied`);
    state.h.oidc.exchangeCode.mockRejectedValueOnce(new IdpUnavailableError());
    const down = await callback(
      req(`callback?code=c&state=${target.searchParams.get('state')}`, { cookie: login1 }),
    );
    expect(down.headers.get('location')).toBe(`${CONSOLE_ORIGIN}/login?error=idp_unavailable`);
  });
});

describe('GET /api/auth/session', () => {
  it('returns the public identity and the CSRF token, and never a token', async () => {
    const { cookie } = await signIn();
    const response = await sessionRoute(req('session', { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      user: { id: 'user-1', email: 'owner@acme.test', name: 'Olive Owner' },
      tenant: { id: 'tenant-1', slug: 'acme' },
      roles: ['asset_owner'],
      expiresAt: new Date(state.h.clock.now + 300_000).toISOString(),
    });
    for (const secret of ['access-token', 'refresh-token', 'id-token']) {
      expect(text).not.toContain(secret);
    }
  });

  it('is 401 without a cookie and clears a cookie that no longer maps to a session', async () => {
    const none = await sessionRoute(req('session'));
    expect(none.status).toBe(401);
    expect(none.headers.getSetCookie()).toEqual([]);
    const stale = await sessionRoute(req('session', { cookie: '__Host-bw_session=garbage' }));
    expect(stale.status).toBe(401);
    expect(stale.headers.getSetCookie()[0]).toMatch(/^__Host-bw_session=; .*Max-Age=0$/);
  });

  it('renews silently near expiry and answers 401 when the refresh is refused', async () => {
    const { cookie } = await signIn();
    state.h.clock.advance(280_000);
    state.h.oidc.refresh.mockResolvedValueOnce(tokens({ accessToken: 'new-access' }));
    const renewed = await sessionRoute(req('session', { cookie }));
    expect(renewed.status).toBe(200);
    expect(state.h.oidc.refresh).toHaveBeenCalledTimes(1);

    state.h.clock.advance(300_000);
    state.h.oidc.refresh.mockRejectedValueOnce(new IdpRejectedError('invalid_grant'));
    const revoked = await sessionRoute(req('session', { cookie }));
    expect(revoked.status).toBe(401);
    expect(revoked.headers.getSetCookie()[0]).toMatch(/Max-Age=0$/);
  });

  it('answers 503 when Valkey is down, not 401', async () => {
    const { cookie } = await signIn();
    state.h.valkey.failing = true;
    expect((await sessionRoute(req('session', { cookie }))).status).toBe(503);
  });
});

describe('POST /api/auth/refresh', () => {
  it('requires the CSRF token', async () => {
    const { cookie } = await signIn();
    const missing = await refresh(req('refresh', { method: 'POST', cookie }));
    expect(missing.status).toBe(403);
    const wrong = await refresh(
      req('refresh', { method: 'POST', cookie, headers: { 'x-bw-csrf': 'nope' } }),
    );
    expect(wrong.status).toBe(403);
    const foreign = await refresh(
      req('refresh', {
        method: 'POST',
        cookie,
        headers: { 'x-bw-csrf': 'x', origin: 'https://evil.example' },
      }),
    );
    expect(foreign.status).toBe(403);
  });

  it('renews the session when the access token is about to expire', async () => {
    const { cookie, csrf } = await signIn();
    state.h.clock.advance(250_000);
    state.h.oidc.refresh.mockResolvedValueOnce(tokens({ accessToken: 'access-token-2' }));
    const response = await refresh(
      req('refresh', {
        method: 'POST',
        cookie,
        headers: { 'x-bw-csrf': csrf, origin: CONSOLE_ORIGIN },
      }),
    );
    expect(response.status).toBe(200);
    expect(state.h.oidc.refresh).toHaveBeenCalledTimes(1);
    expect(((await response.json()) as { expiresAt: string }).expiresAt).toBe(
      new Date(state.h.clock.now + 300_000).toISOString(),
    );
  });

  it('forces re-login (401, cookie cleared) when the refresh token is revoked', async () => {
    const { cookie, csrf } = await signIn();
    state.h.clock.advance(300_000);
    state.h.oidc.refresh.mockRejectedValueOnce(new IdpRejectedError('invalid_grant'));
    const response = await refresh(
      req('refresh', { method: 'POST', cookie, headers: { 'x-bw-csrf': csrf } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()[0]).toMatch(/^__Host-bw_session=; .*Max-Age=0$/);
  });

  it('is 401 without a session and 503 while the IdP is down', async () => {
    expect((await refresh(req('refresh', { method: 'POST' }))).status).toBe(401);
    const { cookie, csrf } = await signIn();
    state.h.clock.advance(300_000);
    state.h.oidc.refresh.mockRejectedValueOnce(new IdpUnavailableError());
    const down = await refresh(
      req('refresh', { method: 'POST', cookie, headers: { 'x-bw-csrf': csrf } }),
    );
    expect(down.status).toBe(503);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session and returns the Keycloak end-session URL', async () => {
    const { cookie, csrf } = await signIn();
    const response = await logout(
      req('logout', {
        method: 'POST',
        cookie,
        headers: { 'x-bw-csrf': csrf, origin: CONSOLE_ORIGIN },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectTo: 'https://id.example.com/logout?id_token_hint=id-token-1',
    });
    expect(response.headers.getSetCookie()[0]).toMatch(/^__Host-bw_session=; .*Max-Age=0$/);
    expect((await sessionRoute(req('session', { cookie }))).status).toBe(401);
  });

  it('refuses a forged request and leaves the session alone', async () => {
    const { cookie } = await signIn();
    const response = await logout(req('logout', { method: 'POST', cookie }));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await sessionRoute(req('session', { cookie }))).status).toBe(200);
  });

  it('succeeds for a session that is already gone and clears the cookie', async () => {
    const response = await logout(
      req('logout', { method: 'POST', cookie: '__Host-bw_session=stale' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toMatch(/Max-Age=0$/);
  });

  it('answers 503 and keeps the cookie when the session cannot be deleted', async () => {
    const { cookie, csrf } = await signIn();
    state.h.valkey.failing = true;
    const response = await logout(
      req('logout', { method: 'POST', cookie, headers: { 'x-bw-csrf': csrf } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('failure handling', () => {
  it('turns an unexpected error into a bare 500 without leaking its message', async () => {
    state.h.oidc.authorizationUrl.mockRejectedValueOnce(new Error('secret-internal-detail'));
    const response = await login(req('login'));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
  });

  it('maps a store outage anywhere to 503', async () => {
    state.h.oidc.authorizationUrl.mockRejectedValueOnce(new SessionStoreUnavailableError());
    expect((await login(req('login'))).status).toBe(503);
  });
});

describe('login route identity hint', () => {
  it('starts the Google broker only for the allow-listed idp value', async () => {
    await login(req('login?idp=google&returnTo=%2Fdemo'));
    expect(state.h.oidc.authorizationUrl.mock.calls.at(-1)?.[0]).toMatchObject({
      idpHint: 'google',
    });
  });

  it('ignores any other idp value instead of forwarding it', async () => {
    await login(req('login?idp=evil.example&returnTo=%2Fdemo'));
    expect(state.h.oidc.authorizationUrl.mock.calls.at(-1)?.[0]?.idpHint).toBeUndefined();
  });
});
