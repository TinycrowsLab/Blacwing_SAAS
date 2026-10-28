import { describe, expect, it } from 'vitest';

import {
  OPERATOR_ID,
  operatorClaims,
  operatorHarness,
  operatorTokens,
  tenantLoginCookie,
  type OperatorHarness,
} from './operator.test-helpers';
import { operatorIdentityFromClaims } from './service';
import { OPERATOR_SESSION_LAYOUT, type OperatorSessionRecord } from './session-store';
import { operatorSessionView } from './session-view';
import { Clock } from '../auth/auth.test-helpers';
import { IdpRejectedError, IdpUnavailableError, InvalidIdTokenError } from '../auth/oidc';
import { seal } from '../auth/seal';

/** Runs the login from start to the callback and returns the sealed operator session cookie (or the failure). */
async function signIn(h: OperatorHarness, claims = operatorClaims()) {
  h.oidc.exchangeCode.mockResolvedValueOnce(operatorTokens({ claims }));
  const started = await h.service.startLogin('/operator/kill');
  const state = new URL(started.location).searchParams.get('state') ?? '';
  return h.service.completeLogin({
    code: 'code-1',
    state,
    idpError: undefined,
    loginCookie: started.loginCookie,
  });
}

/** The operator session's Valkey key for a sid (the `op_session:` keyspace, never the tenant's). */
const sessionKey = (sid: string) => OPERATOR_SESSION_LAYOUT.keyPrefix + sid;

async function sessionOf(
  h: OperatorHarness,
): Promise<{ sid: string; cookie: string; record: OperatorSessionRecord }> {
  const outcome = await signIn(h);
  if (!outcome.ok) throw new Error(`sign-in failed: ${outcome.reason}`);
  const found = [...h.valkey.data.keys()].find((k) =>
    k.startsWith(OPERATOR_SESSION_LAYOUT.keyPrefix),
  );
  if (found === undefined) throw new Error('no operator session stored');
  const sid = found.slice(OPERATOR_SESSION_LAYOUT.keyPrefix.length);
  const record = await h.store.get(sid);
  if (record === null) throw new Error('operator session not readable');
  return { sid, cookie: outcome.sessionCookie, record };
}

describe('operator BFF login (#838)', () => {
  it('starts PKCE S256 against the operator client with a sealed, operator-only login cookie', async () => {
    const h = operatorHarness(new Clock());
    const started = await h.service.startLogin('/operator/kill');
    const url = new URL(started.location);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(started.loginCookie).toBeTruthy();
  });

  it('signs an operator in with the second factor and the platform role, storing the session under op_session:', async () => {
    const h = operatorHarness(new Clock());
    const outcome = await signIn(h);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.returnTo).toBe('/operator/kill');
    const stored = [...h.valkey.data.keys()];
    expect(stored.some((k) => k.startsWith(sessionKey('')))).toBe(true);
    expect(stored.some((k) => k.startsWith('bw:web:sess:'))).toBe(false);
    expect(h.metrics.login).toEqual(['success']);
    expect(h.audit).toEqual([
      { action: 'auth.operator_login', outcome: 'success', operatorId: OPERATOR_ID },
    ]);
  });

  it('refuses a sign-in without the second factor (mfa_required): no session, counted and audited', async () => {
    const h = operatorHarness(new Clock());
    const outcome = await signIn(h, operatorClaims({ acr: 'password' }));
    expect(outcome).toEqual({ ok: false, reason: 'mfa_required' });
    expect(h.valkey.data.size).toBe(0);
    expect(h.metrics.mfaRequired).toBe(1);
    expect(h.audit).toEqual([
      { action: 'auth.operator_login', outcome: 'failure', reason: 'mfa_required' },
    ]);
  });

  it('refuses a sign-in with no acr at all as mfa_required (no proof of the second factor)', async () => {
    const h = operatorHarness(new Clock());
    expect(await signIn(h, operatorClaims({ acr: undefined }))).toEqual({
      ok: false,
      reason: 'mfa_required',
    });
  });

  it('refuses a realm account without the platform_operator role (not_operator): no session', async () => {
    const h = operatorHarness(new Clock());
    expect(await signIn(h, operatorClaims({ roles: ['verification_reviewer'] }))).toEqual({
      ok: false,
      reason: 'not_operator',
    });
    expect(h.valkey.data.size).toBe(0);
  });

  it('refuses a callback whose state does not match the browser that started the login', async () => {
    const h = operatorHarness(new Clock());
    const started = await h.service.startLogin(null);
    const outcome = await h.service.completeLogin({
      code: 'c',
      state: 'attacker-state',
      idpError: undefined,
      loginCookie: started.loginCookie,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_state' });
  });

  it('never accepts a tenant login cookie at the operator callback (purpose and key differ)', async () => {
    const h = operatorHarness(new Clock());
    const outcome = await h.service.completeLogin({
      code: 'c',
      state: 's',
      idpError: undefined,
      loginCookie: tenantLoginCookie(h.keys[0], h.clock.now),
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_state' });
    const foreign = await h.service.completeLogin({
      code: 'c',
      state: 's',
      idpError: undefined,
      loginCookie: seal(
        h.tenantKey,
        'operator-login-cookie',
        { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' },
        600_000,
        h.clock.now,
      ),
    });
    expect(foreign).toEqual({ ok: false, reason: 'invalid_state' });
  });

  it('reports the IdP-side outcomes: denied, idp_unavailable, invalid_token and exchange_failed', async () => {
    const h = operatorHarness(new Clock());
    const started = await h.service.startLogin(null);
    const state = new URL(started.location).searchParams.get('state') ?? '';
    const callback = (idpError?: string) =>
      h.service.completeLogin({ code: 'c', state, idpError, loginCookie: started.loginCookie });
    expect(await callback('access_denied')).toEqual({ ok: false, reason: 'denied' });

    h.oidc.exchangeCode.mockRejectedValueOnce(new IdpUnavailableError());
    expect(await callback()).toEqual({ ok: false, reason: 'idp_unavailable' });
    h.oidc.exchangeCode.mockRejectedValueOnce(new InvalidIdTokenError());
    expect(await callback()).toEqual({ ok: false, reason: 'invalid_token' });
    h.oidc.exchangeCode.mockRejectedValueOnce(new Error('boom'));
    expect(await callback()).toEqual({ ok: false, reason: 'exchange_failed' });
    expect(h.valkey.data.size).toBe(0);
  });

  it('refuses an ID token that carries no subject', async () => {
    const h = operatorHarness(new Clock());
    expect(await signIn(h, { roles: ['platform_operator'], acr: 'operator_strong' })).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('reports a store outage during sign-in as store_unavailable, with no partial session', async () => {
    const h = operatorHarness(new Clock());
    h.valkey.failing = true;
    expect(await signIn(h)).toEqual({ ok: false, reason: 'store_unavailable' });
  });
});

describe('operator identity claims (#838)', () => {
  it('reads roles from realm_access when the roles claim is absent, and an empty acr is not the second factor', () => {
    const identity = operatorIdentityFromClaims({
      sub: 'op-1',
      realm_access: { roles: ['platform_admin'] },
    });
    expect(identity).toEqual({
      sub: 'op-1',
      email: 'op-1',
      name: '',
      roles: ['platform_admin'],
      acr: '',
    });
  });

  it('has no tenant anywhere in an operator identity', () => {
    const identity = operatorIdentityFromClaims(
      operatorClaims({ tenantId: 'acme', tenant: 'acme' }),
    );
    expect(identity).not.toBeNull();
    expect(identity && 'tenantId' in identity).toBe(false);
  });
});

describe('operator BFF session (#838)', () => {
  it('resolves a live operator session and never a session without its cookie', async () => {
    const h = operatorHarness(new Clock());
    const { cookie, record } = await sessionOf(h);
    const state = await h.service.authenticate(cookie);
    expect(state).toMatchObject({ status: 'ok', record: { sub: OPERATOR_ID } });
    expect(await h.service.authenticate(undefined)).toEqual({ status: 'none' });
    expect(await h.service.authenticate('garbage')).toEqual({ status: 'none' });
    expect(record.acr).toBe('operator_strong');
  });

  it('never opens a tenant session cookie (other key and purpose)', async () => {
    const h = operatorHarness(new Clock());
    await sessionOf(h);
    const tenantCookie = seal(h.tenantKey, 'session-cookie', { sid: 'x' }, 600_000, h.clock.now);
    expect(await h.service.authenticate(tenantCookie)).toEqual({ status: 'none' });
  });

  it('answers the page with no token: the view carries identity, roles, csrf and expiry only', async () => {
    const h = operatorHarness(new Clock());
    const { record } = await sessionOf(h);
    const view = operatorSessionView(record);
    expect(Object.keys(view).sort()).toEqual(['csrfToken', 'expiresAt', 'operator', 'roles']);
    expect(JSON.stringify(view)).not.toContain('operator-access-1');
    expect(view.roles).toEqual(['platform_operator']);
  });

  it('renews the tokens near expiry, keeping the session id and the CSRF secret', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie, record } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(operatorTokens({ accessToken: 'operator-access-2' }));
    const state = await h.service.authenticate(cookie);
    expect(state).toMatchObject({
      status: 'ok',
      record: { accessToken: 'operator-access-2', csrf: record.csrf },
    });
    expect(h.metrics.refresh).toEqual(['success']);
  });

  it('ends the session when the renewed token lost the second factor (mfa_lost): forced re-login, audited', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie, sid } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(
      operatorTokens({ claims: operatorClaims({ acr: 'password' }) }),
    );
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(h.valkey.data.has(sessionKey(sid))).toBe(false);
    expect(h.metrics.refresh).toEqual(['mfa_lost']);
    expect(h.metrics.mfaRequired).toBe(1);
    expect(h.audit.at(-1)).toEqual({
      action: 'auth.operator_session_revoked',
      outcome: 'success',
      operatorId: OPERATOR_ID,
      reason: 'mfa_required',
    });
  });

  it('ends the session when the renewed token lost the platform role (not_operator)', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(
      operatorTokens({ claims: operatorClaims({ roles: ['verification_reviewer'] }) }),
    );
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(h.metrics.refresh).toEqual(['not_operator']);
  });

  it('ends the session when the renewed token names a different subject (identity_changed)', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockResolvedValueOnce(
      operatorTokens({ claims: operatorClaims({ sub: 'someone-else' }) }),
    );
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(h.audit.at(-1)).toMatchObject({ reason: 'identity_changed' });
  });

  it('ends the session when the IdP refuses the renewal (rejected)', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockRejectedValueOnce(new IdpRejectedError('invalid_grant'));
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'reauth' });
    expect(h.metrics.refresh).toEqual(['rejected']);
  });

  it('keeps the session when the IdP is unreachable during renewal (unavailable, not logged out)', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    const { cookie, sid } = await sessionOf(h);
    clock.advance(4 * 60_000);
    h.oidc.refresh.mockRejectedValueOnce(new IdpUnavailableError());
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'unavailable' });
    expect(h.valkey.data.has(sessionKey(sid))).toBe(true);
  });

  it('ends a session with no refresh token once its access token is near expiry', async () => {
    const clock = new Clock();
    const h = operatorHarness(clock);
    h.oidc.exchangeCode.mockResolvedValueOnce(operatorTokens({ refreshToken: undefined }));
    const started = await h.service.startLogin(null);
    const state = new URL(started.location).searchParams.get('state') ?? '';
    const outcome = await h.service.completeLogin({
      code: 'c',
      state,
      idpError: undefined,
      loginCookie: started.loginCookie,
    });
    if (!outcome.ok) throw new Error('sign-in failed');
    clock.advance(4 * 60_000);
    expect(await h.service.authenticate(outcome.sessionCookie)).toEqual({ status: 'reauth' });
    expect(h.metrics.refresh).toEqual(['no_refresh_token']);
  });

  it('reports an unreachable session store as unavailable, never as a served or logged-out session', async () => {
    const h = operatorHarness(new Clock());
    const { cookie } = await sessionOf(h);
    h.valkey.failing = true;
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'unavailable' });
  });

  it('logs out: deletes the session, audits the logout with the operator id and points at the end-session URL', async () => {
    const h = operatorHarness(new Clock());
    const { cookie, sid } = await sessionOf(h);
    const out = await h.service.logout(cookie);
    expect(out.redirectTo).toContain('/logout');
    expect(h.valkey.data.has(sessionKey(sid))).toBe(false);
    expect(h.audit.at(-1)).toEqual({
      action: 'auth.operator_logout',
      outcome: 'success',
      operatorId: OPERATOR_ID,
    });
    expect(h.metrics.logout).toBe(1);
  });

  it('a logout of an already-ended session is not an error and still audits', async () => {
    const h = operatorHarness(new Clock());
    const out = await h.service.logout(undefined);
    // The browser still goes to the operator realm's end-session endpoint, exactly as the tenant BFF does.
    expect(out.redirectTo).toContain('/logout');
    expect(h.audit.at(-1)).toEqual({ action: 'auth.operator_logout', outcome: 'success' });
  });
});
