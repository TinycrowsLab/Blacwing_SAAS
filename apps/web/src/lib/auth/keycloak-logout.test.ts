import { describe, expect, it, vi } from 'vitest';

import { createKeycloakSessionLogout } from './keycloak-logout.js';
import { IdpRejectedError, IdpUnavailableError } from './oidc.js';

const ISSUER = 'https://id.example.com/realms/blackwing';
const CONFIG = { issuer: ISSUER, clientId: 'bw-session-admin', clientSecret: 'admin-secret-value' };
const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`;
const LOGOUT_URL = 'https://id.example.com/admin/realms/blackwing/users/user-1/logout';

type Reply = Response | Error;

/** Routes the token request and the logout request to scripted answers. */
function transport(tokenReply: Reply, logoutReply: Reply) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    const reply = url === TOKEN_URL ? tokenReply : logoutReply;
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  return { fetch: fakeFetch, requests };
}

const tokenOk = () => Response.json({ access_token: 'admin-token', expires_in: 60 });

describe('Keycloak session logout', () => {
  it('asks for a service token, then logs the user out through the Admin API', async () => {
    const t = transport(tokenOk(), new Response(null, { status: 204 }));
    await createKeycloakSessionLogout(CONFIG, { fetch: t.fetch }).logoutUser('user-1');

    const [tokenRequest, logoutRequest] = t.requests;
    expect(tokenRequest?.url).toBe(TOKEN_URL);
    const body = tokenRequest?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('grant_type')).toBe('client_credentials');
    expect(logoutRequest?.url).toBe(LOGOUT_URL);
    expect(logoutRequest?.init?.method).toBe('POST');
    expect(new Headers(logoutRequest?.init?.headers).get('authorization')).toBe(
      'Bearer admin-token',
    );
    expect(logoutRequest?.init?.redirect).toBe('error');
  });

  it('treats a user with no Keycloak session left (404) as logged out', async () => {
    const t = transport(tokenOk(), new Response(null, { status: 404 }));
    await expect(
      createKeycloakSessionLogout(CONFIG, { fetch: t.fetch }).logoutUser('user-1'),
    ).resolves.toBeUndefined();
  });

  it('retries nothing itself, and reports a server error as unavailable', async () => {
    const t = transport(tokenOk(), new Response(null, { status: 503 }));
    await expect(
      createKeycloakSessionLogout(CONFIG, { fetch: t.fetch }).logoutUser('user-1'),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
  });

  it('reports a refused admin call as rejected, without copying the body', async () => {
    const t = transport(
      tokenOk(),
      new Response('{"errorMessage":"user-1 secret"}', { status: 403 }),
    );
    const error = await createKeycloakSessionLogout(CONFIG, { fetch: t.fetch })
      .logoutUser('user-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdpRejectedError);
    expect(String(error)).not.toContain('secret');
  });

  it('refuses when the service token is refused, and never reaches the Admin API', async () => {
    const t = transport(
      Response.json({ error: 'unauthorized_client' }, { status: 401 }),
      new Response(null, { status: 204 }),
    );
    await expect(
      createKeycloakSessionLogout(CONFIG, { fetch: t.fetch }).logoutUser('user-1'),
    ).rejects.toBeInstanceOf(IdpRejectedError);
    expect(t.requests).toHaveLength(1);
  });

  it('treats a transport failure as unavailable', async () => {
    const t = transport(tokenOk(), new TypeError('fetch failed'));
    await expect(
      createKeycloakSessionLogout(CONFIG, { fetch: t.fetch }).logoutUser('user-1'),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
  });

  it('refuses an issuer that does not name a realm', () => {
    expect(() =>
      createKeycloakSessionLogout({ ...CONFIG, issuer: 'https://id.example.com' }, { fetch }),
    ).toThrow('does not name a realm');
  });
});
