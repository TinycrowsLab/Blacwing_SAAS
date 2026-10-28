import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';
import { harness, type Harness } from '../../../../lib/auth/auth.test-helpers';
import { IdpUnavailableError, InvalidLogoutTokenError } from '../../../../lib/auth/oidc';

import type { AuthRuntime } from '../../../../lib/auth/runtime';

const state: { h: Harness } = { h: harness() };

vi.mock('../../../../lib/auth/runtime', () => ({
  getAuthRuntime: (): AuthRuntime => ({
    config: {
      issuer: 'https://id.example.com/realms/blackwing',
      clientId: 'c',
      clientSecret: undefined,
      consoleOrigin: 'https://app.example.com',
      redirectUri: 'https://app.example.com/auth/callback',
      redisUrl: 'redis://unused',
      sessionKeys: state.h.keys,
      sessionAdmin: undefined,
    },
    service: state.h.service,
    revocation: state.h.revocation,
  }),
}));

afterEach(() => {
  state.h = harness();
});

function post(body: string, type = 'application/x-www-form-urlencoded'): Request {
  return new Request('https://app.example.com/api/auth/backchannel-logout', {
    method: 'POST',
    headers: { 'content-type': type },
    body,
  });
}

describe('POST /api/auth/backchannel-logout', () => {
  it('answers 200 with no body and no cache when the token is accepted', async () => {
    state.h.oidc.verifyLogoutToken.mockResolvedValueOnce({
      sub: 'user-1',
      sid: 'kc-1',
      jti: 'j-route',
    });
    const response = await POST(post('logout_token=signed.token.here'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('answers 400 for a token that does not verify, and for a request with no token', async () => {
    state.h.oidc.verifyLogoutToken.mockRejectedValueOnce(new InvalidLogoutTokenError());
    const forged = await POST(post('logout_token=forged'));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: 'invalid_request' });

    const missing = await POST(post('other=1'));
    expect(missing.status).toBe(400);
  });

  it('answers 503 while the IdP is unreachable, so Keycloak retries', async () => {
    state.h.oidc.verifyLogoutToken.mockRejectedValueOnce(new IdpUnavailableError());
    const response = await POST(post('logout_token=t'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
  });

  it('refuses a replayed token with 400', async () => {
    state.h.oidc.verifyLogoutToken.mockResolvedValue({
      sub: 'user-1',
      sid: 'kc-2',
      jti: 'replayed',
    });
    expect((await POST(post('logout_token=t'))).status).toBe(200);
    expect((await POST(post('logout_token=t'))).status).toBe(400);
  });
});
