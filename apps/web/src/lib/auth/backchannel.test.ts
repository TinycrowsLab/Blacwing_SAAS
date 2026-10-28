import { describe, expect, it, vi } from 'vitest';

import { harness, tokens, type Harness } from './auth.test-helpers.js';
import { logoutTokenOf } from './backchannel.js';
import { IdpUnavailableError, InvalidLogoutTokenError } from './oidc.js';

describe('back-channel logout', () => {
  it('ends the session the Keycloak session names, so the next request must log in again', async () => {
    const h = harness();
    const cookie = await loginWithSid(h, 'idp-sid-1');
    expect(await h.service.authenticate(cookie, false)).toMatchObject({ status: 'ok' });

    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-1', sid: 'idp-sid-1', jti: 'j1' });
    expect(await h.service.backchannelLogout('token')).toBe('success');

    expect(await h.service.authenticate(cookie, false)).toEqual({ status: 'none' });
    expect(h.metrics.backchannel).toEqual(['success']);
    expect(h.audit.at(-1)).toMatchObject({
      action: 'auth.session_revoked',
      reason: 'backchannel_logout',
    });
  });

  it('leaves another Keycloak session of the same user alone when the token names one sid', async () => {
    const h = harness();
    const first = await loginWithSid(h, 'idp-sid-1');
    const second = await loginWithSid(h, 'idp-sid-2');
    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-1', sid: 'idp-sid-1', jti: 'j1' });
    await h.service.backchannelLogout('token');
    expect(await h.service.authenticate(first, false)).toEqual({ status: 'none' });
    expect(await h.service.authenticate(second, false)).toMatchObject({ status: 'ok' });
  });

  it('ends every session of the subject when the token names no sid', async () => {
    const h = harness();
    const a = await loginWithSid(h, 'idp-sid-1');
    const b = await loginWithSid(h, 'idp-sid-2');
    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-1', sid: undefined, jti: 'j2' });
    expect(await h.service.backchannelLogout('token')).toBe('success');
    expect(await h.service.authenticate(a, false)).toEqual({ status: 'none' });
    expect(await h.service.authenticate(b, false)).toEqual({ status: 'none' });
  });

  it('never ends another user’s session when the token names both a sid and a subject', async () => {
    const h = harness();
    const cookie = await loginWithSid(h, 'idp-sid-1');
    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-2', sid: 'idp-sid-1', jti: 'j3' });
    expect(await h.service.backchannelLogout('token')).toBe('success');
    expect(await h.service.authenticate(cookie, false)).toMatchObject({ status: 'ok' });
  });

  it('succeeds without effect when no session matches, so Keycloak does not retry', async () => {
    const h = harness();
    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-9', sid: 'unknown', jti: 'j4' });
    expect(await h.service.backchannelLogout('token')).toBe('success');
    expect(h.audit).toEqual([]);
  });

  it('refuses a replayed logout token and ends nothing on the replay', async () => {
    const h = harness();
    await loginWithSid(h, 'idp-sid-1');
    h.oidc.verifyLogoutToken.mockResolvedValue({ sub: 'user-1', sid: 'idp-sid-1', jti: 'same' });
    expect(await h.service.backchannelLogout('token')).toBe('success');
    // A new session begins after the first logout; replaying the captured token must not end it.
    const later = await loginWithSid(h, 'idp-sid-1');
    expect(await h.service.backchannelLogout('token')).toBe('replayed');
    expect(await h.service.authenticate(later, false)).toMatchObject({ status: 'ok' });
    expect(h.metrics.backchannel).toEqual(['success', 'replayed']);
  });

  it('refuses a token that does not verify, with no effect', async () => {
    const h = harness();
    const cookie = await loginWithSid(h, 'idp-sid-1');
    h.oidc.verifyLogoutToken.mockRejectedValueOnce(new InvalidLogoutTokenError());
    expect(await h.service.backchannelLogout('forged')).toBe('invalid_token');
    expect(await h.service.authenticate(cookie, false)).toMatchObject({ status: 'ok' });
    expect(h.metrics.backchannel).toEqual(['invalid_token']);
  });

  it('refuses a missing token', async () => {
    const h = harness();
    expect(await h.service.backchannelLogout(undefined)).toBe('invalid_token');
    expect(h.oidc.verifyLogoutToken).not.toHaveBeenCalled();
  });

  it('propagates an IdP outage so Keycloak retries, and counts it as unavailable', async () => {
    const h = harness();
    h.oidc.verifyLogoutToken.mockRejectedValueOnce(new IdpUnavailableError());
    await expect(h.service.backchannelLogout('token')).rejects.toBeInstanceOf(IdpUnavailableError);
    expect(h.metrics.backchannel).toEqual(['unavailable']);
  });

  it('fails closed on a Valkey outage: nothing is claimed, nothing reports success', async () => {
    const h = harness();
    h.oidc.verifyLogoutToken.mockResolvedValueOnce({ sub: 'user-1', sid: undefined, jti: 'j5' });
    h.valkey.failing = true;
    await expect(h.service.backchannelLogout('token')).rejects.toThrow(
      'The session store is unavailable',
    );
    expect(h.metrics.backchannel).toEqual(['unavailable']);
  });
});

describe('revoked sessions cannot be refreshed', () => {
  it('a session revoked with its tokens expired is not renewed: the user logs in again', async () => {
    const h = harness();
    const cookie = await loginWithSid(h, 'idp-sid-1', 1);
    await h.revocation.revokeSessions({ userId: 'user-1', reason: 'user_disabled' });
    h.oidc.refresh.mockClear();
    expect(await h.service.authenticate(cookie)).toEqual({ status: 'none' });
    expect(h.oidc.refresh).not.toHaveBeenCalled();
  });

  it('a refresh still in flight when the session is revoked does not bring it back', async () => {
    const h = harness();
    const cookie = await loginWithSid(h, 'idp-sid-1', 1);
    let release: (() => void) | undefined;
    h.oidc.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(tokens({ accessToken: 'late' }));
          };
        }),
    );
    const pending = h.service.authenticate(cookie);
    await vi.waitFor(() => {
      expect(h.oidc.refresh).toHaveBeenCalled();
    });
    await h.revocation.revokeSessions({ userId: 'user-1', reason: 'admin_revoked' });
    release?.();
    expect(await pending).toEqual({ status: 'none' });
    expect([...h.valkey.data.keys()].some((key) => key.startsWith('bw:web:sess:'))).toBe(false);
  });
});

describe('logoutTokenOf', () => {
  const form = (body: string, type = 'application/x-www-form-urlencoded') =>
    new Request('https://app.example.com/api/auth/backchannel-logout', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  it('reads the logout_token field of a form post', async () => {
    expect(await logoutTokenOf(form('logout_token=abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('refuses a body that is not a form, a missing field, and an oversized body', async () => {
    expect(await logoutTokenOf(form('{"logout_token":"x"}', 'application/json'))).toBeUndefined();
    expect(await logoutTokenOf(form('other=1'))).toBeUndefined();
    expect(await logoutTokenOf(form('logout_token='))).toBeUndefined();
    expect(await logoutTokenOf(form(`logout_token=${'a'.repeat(9000)}`))).toBeUndefined();
  });
});

/** Logs in with a chosen Keycloak session id and an optional access-token lifetime in seconds. */
async function loginWithSid(h: Harness, idpSid: string, expiresInSeconds = 300): Promise<string> {
  const started = await h.service.startLogin(null);
  const state = new URL(started.location).searchParams.get('state') ?? '';
  h.oidc.exchangeCode.mockResolvedValueOnce(
    tokens({
      expiresInSeconds,
      claims: { sub: 'user-1', tenantId: 'tenant-1', roles: ['asset_owner'], sid: idpSid },
    }),
  );
  const outcome = await h.service.completeLogin({
    code: 'c',
    state,
    idpError: undefined,
    loginCookie: started.loginCookie,
  });
  if (!outcome.ok) throw new Error('login failed');
  return outcome.sessionCookie;
}
