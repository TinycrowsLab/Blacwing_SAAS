import { describe, expect, it } from 'vitest';

import { claims, harness, tokens, type Harness } from './auth.test-helpers.js';
import {
  IdpRejectedError,
  IdpUnavailableError,
  InvalidIdTokenError,
  type TokenSet,
} from './oidc.js';
import { codeChallenge } from './pkce.js';
import { identityFromClaims, LOGIN_TTL_MS, REFRESH_SKEW_MS } from './service.js';
import { SessionStoreUnavailableError } from './session-store.js';

const MINUTE = 60_000;

interface Started {
  readonly loginCookie: string;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
}

async function start(h: Harness, returnTo: string | null = null): Promise<Started> {
  const { loginCookie, location } = await h.service.startLogin(returnTo);
  const url = new URL(location);
  return {
    loginCookie,
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
  };
}

async function login(h: Harness, returnTo: string | null = null): Promise<string> {
  const s = await start(h, returnTo);
  const outcome = await h.service.completeLogin({
    code: 'code-1',
    state: s.state,
    idpError: undefined,
    loginCookie: s.loginCookie,
  });
  if (!outcome.ok) throw new Error(`login failed: ${outcome.reason}`);
  return outcome.sessionCookie;
}

function sessionKeys(h: Harness): string[] {
  return [...h.valkey.data.keys()].filter((key) => key.startsWith('bw:web:sess:'));
}

describe('startLogin', () => {
  it('redirects with a PKCE S256 challenge, state and nonce, and seals the verifier', async () => {
    const h = harness();
    const s = await start(h);
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.state).not.toBe(s.nonce);
    expect(s.loginCookie).not.toContain(s.state);

    const outcome = await h.service.completeLogin({
      code: 'c',
      state: s.state,
      idpError: undefined,
      loginCookie: s.loginCookie,
    });
    expect(outcome.ok).toBe(true);
    const exchange = h.oidc.exchangeCode.mock.calls[0]?.[0];
    expect(exchange).toMatchObject({ code: 'c', nonce: s.nonce });
    expect(codeChallenge(exchange?.verifier ?? '')).toBe(s.challenge);
  });

  it('uses fresh randomness for every login', async () => {
    const h = harness();
    const [a, b] = [await start(h), await start(h)];
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('only ever returns to an internal path', async () => {
    const h = harness();
    const ok = await login(h, '/runs/123');
    expect(ok).toBeTruthy();
    for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const s = await start(h, evil);
      const outcome = await h.service.completeLogin({
        code: 'c',
        state: s.state,
        idpError: undefined,
        loginCookie: s.loginCookie,
      });
      expect(outcome).toMatchObject({ ok: true, returnTo: '/' });
    }
    const s = await start(h, '/runs/123');
    const outcome = await h.service.completeLogin({
      code: 'c',
      state: s.state,
      idpError: undefined,
      loginCookie: s.loginCookie,
    });
    expect(outcome).toMatchObject({ ok: true, returnTo: '/runs/123' });
  });
});

describe('completeLogin', () => {
  it('creates a session whose cookie holds no token and whose tokens stay server-side', async () => {
    const h = harness();
    const cookie = await login(h);
    for (const secret of ['access-token-1', 'refresh-token-1', 'id-token-1']) {
      expect(cookie).not.toContain(secret);
      expect(Buffer.from(cookie, 'base64url').toString('utf8')).not.toContain(secret);
    }
    const state = await h.service.authenticate(cookie);
    expect(state).toMatchObject({
      status: 'ok',
      record: {
        sub: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        roles: ['asset_owner'],
        accessToken: 'access-token-1',
      },
    });
    expect(h.audit).toEqual([
      { action: 'auth.login', outcome: 'success', userId: 'user-1', tenantId: 'tenant-1' },
    ]);
    expect(h.metrics.login).toEqual(['success']);
  });

  it('gives each login a new session id and csrf secret', async () => {
    const h = harness();
    await login(h);
    await login(h);
    expect(sessionKeys(h)).toHaveLength(2);
  });

  const failures: [
    string,
    (h: Harness) => Promise<Parameters<Harness['service']['completeLogin']>[0]>,
    string,
  ][] = [
    [
      'a missing login cookie',
      async (h) => ({ ...(await fresh(h)), loginCookie: undefined }),
      'invalid_state',
    ],
    [
      'a garbage login cookie',
      async (h) => ({ ...(await fresh(h)), loginCookie: 'garbage' }),
      'invalid_state',
    ],
    ['a state mismatch', async (h) => ({ ...(await fresh(h)), state: 'forged' }), 'invalid_state'],
    ['a missing state', async (h) => ({ ...(await fresh(h)), state: undefined }), 'invalid_state'],
    ['a missing code', async (h) => ({ ...(await fresh(h)), code: undefined }), 'invalid_state'],
    ['an IdP error', async (h) => ({ ...(await fresh(h)), idpError: 'access_denied' }), 'denied'],
  ];

  async function fresh(h: Harness): Promise<Parameters<Harness['service']['completeLogin']>[0]> {
    const s = await start(h);
    return { code: 'code-1', state: s.state, idpError: undefined, loginCookie: s.loginCookie };
  }

  it.each(failures)('refuses %s without creating a session', async (_label, build, reason) => {
    const h = harness();
    const outcome = await h.service.completeLogin(await build(h));
    expect(outcome).toEqual({ ok: false, reason });
    expect(h.oidc.exchangeCode).not.toHaveBeenCalled();
    expect(sessionKeys(h)).toEqual([]);
    expect(h.metrics.login).toEqual([reason]);
    expect(h.audit[0]).toMatchObject({ action: 'auth.login_failed', outcome: 'failure', reason });
  });

  it('refuses a login cookie after its lifetime', async () => {
    const h = harness();
    const input = await fresh(h);
    h.clock.advance(LOGIN_TTL_MS);
    expect(await h.service.completeLogin(input)).toEqual({ ok: false, reason: 'invalid_state' });
  });

  it('refuses a login cookie sealed under an unknown key', async () => {
    const a = harness();
    const b = harness();
    const input = await fresh(a);
    expect(await b.service.completeLogin(input)).toEqual({ ok: false, reason: 'invalid_state' });
  });

  it.each([
    ['the code exchange is refused', new IdpRejectedError('invalid_grant'), 'exchange_failed'],
    ['the ID token does not verify', new InvalidIdTokenError(), 'invalid_token'],
    ['the IdP is down', new IdpUnavailableError(), 'idp_unavailable'],
  ])('creates no partial session when %s', async (_label, error, reason) => {
    const h = harness();
    h.oidc.exchangeCode.mockRejectedValueOnce(error);
    const outcome = await h.service.completeLogin(await fresh(h));
    expect(outcome).toEqual({ ok: false, reason });
    expect(sessionKeys(h)).toEqual([]);
  });

  it('lets the user retry after a failure', async () => {
    const h = harness();
    h.oidc.exchangeCode.mockRejectedValueOnce(new IdpUnavailableError());
    expect((await h.service.completeLogin(await fresh(h))).ok).toBe(false);
    expect((await h.service.completeLogin(await fresh(h))).ok).toBe(true);
  });

  it('rejects a replayed callback: the cookie is single-use at the IdP', async () => {
    const h = harness();
    const input = await fresh(h);
    expect((await h.service.completeLogin(input)).ok).toBe(true);
    h.oidc.exchangeCode.mockRejectedValueOnce(new IdpRejectedError('invalid_grant'));
    expect(await h.service.completeLogin(input)).toEqual({ ok: false, reason: 'exchange_failed' });
    expect(sessionKeys(h)).toHaveLength(1);
  });

  it('refuses an identity without a tenant', async () => {
    const h = harness();
    h.oidc.exchangeCode.mockResolvedValueOnce(tokens({ claims: claims({ tenantId: undefined }) }));
    expect(await h.service.completeLogin(await fresh(h))).toEqual({
      ok: false,
      reason: 'no_tenant',
    });
    expect(sessionKeys(h)).toEqual([]);
  });

  it('creates no session when Valkey is down', async () => {
    const h = harness();
    const input = await fresh(h);
    h.valkey.failing = true;
    expect(await h.service.completeLogin(input)).toEqual({
      ok: false,
      reason: 'store_unavailable',
    });
    h.valkey.failing = false;
    expect(sessionKeys(h)).toEqual([]);
  });

  it('does not accept the login cookie as a session cookie', async () => {
    const h = harness();
    const s = await start(h);
    expect(await h.service.authenticate(s.loginCookie)).toEqual({ status: 'none' });
  });

  it('bounds the session lifetime by the refresh token lifetime, capped at 12 hours', async () => {
    const h = harness();
    h.oidc.exchangeCode.mockResolvedValueOnce(tokens({ refreshExpiresInSeconds: 60 }));
    const short = await login(h);
    h.oidc.exchangeCode.mockResolvedValueOnce(tokens({ refreshExpiresInSeconds: 10 ** 7 }));
    const long = await login(h);
    h.clock.advance(61_000);
    expect(await h.service.authenticate(short)).toEqual({ status: 'none' });
    h.clock.advance(11 * 60 * MINUTE);
    expect((await h.service.authenticate(long, false)).status).toBe('ok');
    h.clock.advance(61 * MINUTE);
    expect(await h.service.authenticate(long, false)).toEqual({ status: 'none' });
  });
});

describe('authenticate', () => {
  it('answers without cookie, with garbage and with an unknown session', async () => {
    const h = harness();
    expect(await h.service.authenticate(undefined)).toEqual({ status: 'none' });
    expect(await h.service.authenticate('garbage')).toEqual({ status: 'none' });
    const cookie = await login(h);
    for (const key of sessionKeys(h)) h.valkey.data.delete(key);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
  });

  it('does not call the IdP while the access token is fresh', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000 - REFRESH_SKEW_MS - 1);
    expect((await h.service.authenticate(cookie)).status).toBe('ok');
    expect(h.oidc.refresh).not.toHaveBeenCalled();
  });

  it('renews transparently near expiry, keeping the session id and csrf secret', async () => {
    const h = harness();
    const cookie = await login(h);
    const before = await h.service.authenticate(cookie);
    h.clock.advance(5 * 60_000 - REFRESH_SKEW_MS);
    h.oidc.refresh.mockResolvedValueOnce(
      tokens({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
        idToken: 'id-token-2',
      }),
    );
    const after = await h.service.authenticate(cookie);
    expect(h.oidc.refresh).toHaveBeenCalledWith('refresh-token-1');
    if (before.status !== 'ok' || after.status !== 'ok') throw new Error('expected a session');
    expect(after.sid).toBe(before.sid);
    expect(after.record).toMatchObject({
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      idToken: 'id-token-2',
      csrf: before.record.csrf,
      accessExpiresAt: h.clock.now + 5 * 60_000,
    });
    expect(h.metrics.refresh).toEqual(['success']);
    // The next call is served from the renewed record.
    await h.service.authenticate(cookie);
    expect(h.oidc.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the held refresh and ID tokens when the answer carries none', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(
      tokens({
        accessToken: 'access-token-2',
        refreshToken: undefined,
        idToken: undefined,
        claims: undefined,
      }),
    );
    const state = await h.service.authenticate(cookie);
    expect(state).toMatchObject({
      status: 'ok',
      record: {
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-1',
        idToken: 'id-token-1',
        roles: ['asset_owner'],
      },
    });
  });

  it('follows role changes carried by the refreshed ID token', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(tokens({ claims: claims({ roles: ['auditor'] }) }));
    expect(await h.service.authenticate(cookie)).toMatchObject({ record: { roles: ['auditor'] } });
  });

  it.each([
    ['a refreshed identity without a tenant', tokens({ claims: claims({ tenantId: undefined }) })],
    [
      'a refreshed identity of another subject',
      tokens({ claims: claims({ sub: 'someone-else' }) }),
    ],
  ])('ends the session on %s', async (_label, answer: TokenSet) => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(answer);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
  });

  it.each([
    ['revoked or expired', new IdpRejectedError('invalid_grant'), 'rejected'],
    ['reused after rotation', new IdpRejectedError('invalid_grant'), 'rejected'],
    ['answered with an unverifiable ID token', new InvalidIdTokenError(), 'invalid_token'],
  ])('forces re-login when the refresh token is %s', async (_label, error, result) => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockRejectedValueOnce(error);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(sessionKeys(h)).toEqual([]);
    expect(h.metrics.refresh).toEqual([result]);
    expect(h.audit.at(-1)).toMatchObject({
      action: 'auth.session_revoked',
      userId: 'user-1',
      reason: result,
    });
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
  });

  it('forces re-login when the session holds no refresh token', async () => {
    const h = harness();
    h.oidc.exchangeCode.mockResolvedValueOnce(tokens({ refreshToken: undefined }));
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(h.oidc.refresh).not.toHaveBeenCalled();
  });

  it('keeps the session when the IdP is down and recovers afterwards', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockRejectedValueOnce(new IdpUnavailableError());
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'unavailable' });
    expect(h.metrics.refresh).toEqual(['idp_unavailable']);
    expect((await h.service.authenticate(cookie)).status).toBe('ok');
  });

  it('reports a Valkey outage as unavailable and never as signed out', async () => {
    const h = harness();
    const cookie = await login(h);
    h.valkey.failing = true;
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'unavailable' });
  });

  it('does not refresh when asked only to look the session up', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    expect((await h.service.authenticate(cookie, false)).status).toBe('ok');
    expect(h.oidc.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent requests (single-flight across tabs)', async () => {
    // Waiters must really yield to the event loop while the holder's refresh is in flight.
    const h = harness({ sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    let release: (set: TokenSet) => void = () => undefined;
    h.oidc.refresh.mockImplementation(
      () => new Promise<TokenSet>((resolve) => (release = resolve)),
    );
    const calls = [
      h.service.authenticate(cookie),
      h.service.authenticate(cookie),
      h.service.authenticate(cookie),
    ];
    // Let the waiters poll at least once before the holder finishes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    release(tokens({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2' }));
    const states = await Promise.all(calls);
    expect(h.oidc.refresh).toHaveBeenCalledTimes(1);
    for (const state of states) {
      expect(state).toMatchObject({ status: 'ok', record: { accessToken: 'access-token-2' } });
    }
    expect(
      h.valkey.data.has('bw:web:sess-lock:' + (states[0]?.status === 'ok' ? states[0].sid : '')),
    ).toBe(false);
  });

  it('gives up waiting on a peer that never finishes', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    const first = await h.service.authenticate(cookie, false);
    if (first.status !== 'ok') throw new Error('expected a session');
    await h.store.tryLock(first.sid, 'stuck-peer', 60_000);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'unavailable' });
    expect(h.metrics.refresh).toEqual(['busy']);
    expect(h.oidc.refresh).not.toHaveBeenCalled();
  });

  it('answers none to a waiter whose session was ended meanwhile', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    const first = await h.service.authenticate(cookie, false);
    if (first.status !== 'ok') throw new Error('expected a session');
    await h.store.tryLock(first.sid, 'peer', 60_000);
    await h.store.delete(first.sid);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
  });

  it('does not resurrect a session that was logged out during the refresh', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(5 * 60_000);
    h.oidc.refresh.mockImplementationOnce(async () => {
      await h.service.logout(cookie);
      return tokens();
    });
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
    expect(sessionKeys(h)).toEqual([]);
  });

  it('refuses a session cookie after its lifetime', async () => {
    const h = harness();
    const cookie = await login(h);
    h.clock.advance(31 * MINUTE);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
  });
});

describe('logout', () => {
  it('deletes the session and goes to the IdP end-session URL with the ID token hint', async () => {
    const h = harness();
    const cookie = await login(h);
    const result = await h.service.logout(cookie);
    expect(result.redirectTo).toBe('https://id.example.com/logout?id_token_hint=id-token-1');
    expect(sessionKeys(h)).toEqual([]);
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
    expect(h.metrics.logout).toBe(1);
    expect(h.audit.at(-1)).toEqual({
      action: 'auth.logout',
      outcome: 'success',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  it('is idempotent for a session that is already gone', async () => {
    const h = harness();
    const result = await h.service.logout('garbage');
    expect(result.redirectTo).toBe('https://id.example.com/logout?id_token_hint=');
    expect(h.audit.at(-1)).toEqual({ action: 'auth.logout', outcome: 'success' });
  });

  it('still ends the local session when the IdP cannot be asked, and without an end-session endpoint', async () => {
    const h = harness();
    const cookie = await login(h);
    h.oidc.endSessionUrl.mockRejectedValueOnce(new IdpUnavailableError());
    expect(await h.service.logout(cookie)).toEqual({ redirectTo: '/' });
    expect(sessionKeys(h)).toEqual([]);
    h.oidc.endSessionUrl.mockResolvedValueOnce(undefined);
    expect(await h.service.logout(await login(h))).toEqual({ redirectTo: '/' });
  });

  it('fails when the session cannot be deleted (Valkey down) instead of pretending', async () => {
    const h = harness();
    const cookie = await login(h);
    h.valkey.failing = true;
    await expect(h.service.logout(cookie)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
  });
});

describe('identityFromClaims', () => {
  it('reads the realm claims', () => {
    expect(identityFromClaims(claims())).toEqual({
      sub: 'user-1',
      email: 'owner@acme.test',
      name: 'Olive Owner',
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      roles: ['asset_owner'],
    });
  });

  it('falls back to the dev realm claims and Keycloak realm roles', () => {
    expect(
      identityFromClaims({
        sub: 'u',
        preferred_username: 'owner',
        tenant: 'acme',
        realm_access: { roles: ['asset_owner'] },
      }),
    ).toEqual({
      sub: 'u',
      email: 'owner',
      name: 'owner',
      tenantId: 'acme',
      tenantSlug: 'acme',
      roles: ['asset_owner'],
    });
  });

  it('refuses missing or malformed claims', () => {
    expect(identityFromClaims(undefined)).toBeNull();
    expect(identityFromClaims({ sub: 'u' })).toBeNull();
    expect(identityFromClaims({ sub: 'u', tenantId: 't', roles: 'admin' })).toBeNull();
    expect(identityFromClaims({ tenantId: 't' })).toBeNull();
  });
});
