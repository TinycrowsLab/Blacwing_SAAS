import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  createLocalJWKSet,
  type JWK,
  type CryptoKey,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createOidcClient,
  IdpRejectedError,
  IdpUnavailableError,
  InvalidIdTokenError,
  InvalidLogoutTokenError,
  type OidcClient,
} from './oidc.js';

const ISSUER = 'https://id.example.com/realms/blackwing';
const CLIENT_ID = 'bw-console-bff';
const NOW = 1_800_000_000_000;
const NONCE = 'nonce-1';

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
};

let privateKey: CryptoKey;
let publicJwk: JWK;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

interface IdTokenOptions {
  readonly iss?: string;
  readonly aud?: string;
  readonly nonce?: string | undefined;
  readonly iat?: number;
  readonly exp?: number;
  readonly key?: CryptoKey;
}

function idToken(options: IdTokenOptions = {}): Promise<string> {
  const iat = options.iat ?? Math.floor(NOW / 1000);
  const claims: Record<string, unknown> = { tenantId: 't1', roles: ['org_admin'] };
  if (!('nonce' in options) || options.nonce !== undefined) claims.nonce = options.nonce ?? NONCE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? CLIENT_ID)
    .setSubject('user-1')
    .setIssuedAt(iat)
    .setExpirationTime(options.exp ?? iat + 300)
    .sign(options.key ?? privateKey);
}

interface FakeIdp {
  readonly client: OidcClient;
  readonly fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly tokenBodies: URLSearchParams[];
}

function setup(
  tokenResponse: () => Response | Promise<Response>,
  options: { doc?: unknown; secret?: string; discoveryStatus?: number } = {},
): FakeIdp {
  const tokenBodies: URLSearchParams[] = [];
  const fakeFetch = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        Response.json(options.doc ?? discovery, { status: options.discoveryStatus ?? 200 }),
      );
    }
    if (url === discovery.token_endpoint) {
      tokenBodies.push(init?.body instanceof URLSearchParams ? init.body : new URLSearchParams());
      return Promise.resolve(tokenResponse());
    }
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
  const client = createOidcClient(
    {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: options.secret,
      redirectUri: 'https://app.example.com/auth/callback',
      consoleOrigin: 'https://app.example.com',
    },
    { fetch: fakeFetch, now: () => NOW, getKeySet: () => createLocalJWKSet({ keys: [publicJwk] }) },
  );
  return { client, fetch: fakeFetch, tokenBodies };
}

async function tokenOk(token: IdTokenOptions = {}, extra: object = {}): Promise<Response> {
  return Response.json({
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: 'rt-1',
    refresh_expires_in: 1800,
    id_token: await idToken(token),
    ...extra,
  });
}

const exchange = (client: OidcClient): ReturnType<OidcClient['exchangeCode']> =>
  client.exchangeCode({ code: 'code-1', verifier: 'verifier-1', nonce: NONCE });

describe('authorizationUrl', () => {
  it('asks for the code flow with PKCE S256, state and nonce', async () => {
    const { client } = setup(() => new Response());
    const url = await client.authorizationUrl({ state: 's1', nonce: 'n1', challenge: 'c1' });
    expect(`${url.origin}${url.pathname}`).toBe(discovery.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://app.example.com/auth/callback',
      scope: 'openid profile email',
      state: 's1',
      nonce: 'n1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    });
  });

  it('discovers once and caches the document', async () => {
    const { client, fetch: fetchMock } = setup(() => new Response());
    await client.authorizationUrl({ state: 'a', nonce: 'b', challenge: 'c' });
    await client.authorizationUrl({ state: 'a', nonce: 'b', challenge: 'c' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an issuer that differs', { ...discovery, issuer: 'https://evil.example.com/realms/x' }],
    [
      'an endpoint on another origin',
      { ...discovery, token_endpoint: 'https://evil.example.com/token' },
    ],
    [
      'an end-session endpoint on another origin',
      { ...discovery, end_session_endpoint: 'https://evil.example.com/logout' },
    ],
    ['a malformed document', { issuer: ISSUER }],
  ])('refuses discovery with %s', async (_label, doc) => {
    const { client } = setup(() => new Response(), { doc });
    await expect(
      client.authorizationUrl({ state: 'a', nonce: 'b', challenge: 'c' }),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
  });

  it('treats a failing discovery as an outage', async () => {
    const { client } = setup(() => new Response(), { discoveryStatus: 503 });
    await expect(
      client.authorizationUrl({ state: 'a', nonce: 'b', challenge: 'c' }),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
  });
});

describe('exchangeCode', () => {
  it('posts the code with the PKCE verifier and returns verified tokens and claims', async () => {
    const { client, tokenBodies } = setup(() => tokenOk());
    const tokens = await exchange(client);
    expect(Object.fromEntries(tokenBodies[0] ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://app.example.com/auth/callback',
      code_verifier: 'verifier-1',
      client_id: CLIENT_ID,
    });
    expect(tokens).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresInSeconds: 300,
      refreshExpiresInSeconds: 1800,
    });
    expect(tokens.claims).toMatchObject({ sub: 'user-1', tenantId: 't1', nonce: NONCE });
  });

  it('authenticates a confidential client with its secret', async () => {
    const { client, tokenBodies } = setup(() => tokenOk(), { secret: 'shh' });
    await exchange(client);
    expect(tokenBodies[0]?.get('client_secret')).toBe('shh');
  });

  it('rejects a nonce mismatch (replayed or foreign token)', async () => {
    const { client } = setup(() => tokenOk({ nonce: 'other' }));
    await expect(exchange(client)).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it('rejects an ID token without a nonce, without an ID token, and a wrong issuer or audience', async () => {
    for (const response of [
      () => tokenOk({ nonce: undefined }),
      () => tokenOk({ iss: 'https://evil.example.com/realms/blackwing' }),
      () => tokenOk({ aud: 'some-other-client' }),
      () => tokenOk({}, { id_token: undefined }),
    ]) {
      await expect(exchange(setup(response).client)).rejects.toBeInstanceOf(InvalidIdTokenError);
    }
  });

  it('rejects a token signed by another key and an unsigned token', async () => {
    await expect(exchange(setup(() => tokenOk({ key: otherKey })).client)).rejects.toBeInstanceOf(
      InvalidIdTokenError,
    );
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'u',
        nonce: NONCE,
        exp: 9_999_999_999,
        iat: 1,
      }),
    ).toString('base64url')}.`;
    await expect(
      exchange(setup(() => tokenOk({}, { id_token: unsigned })).client),
    ).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it('allows a small clock skew and rejects an expired token beyond it', async () => {
    const issuedAt = Math.floor(NOW / 1000) - 600;
    // Expired 10 s ago: inside the 30 s leeway.
    await expect(
      exchange(setup(() => tokenOk({ iat: issuedAt, exp: Math.floor(NOW / 1000) - 10 })).client),
    ).resolves.toBeDefined();
    // Expired 120 s ago: outside it.
    await expect(
      exchange(setup(() => tokenOk({ iat: issuedAt, exp: Math.floor(NOW / 1000) - 120 })).client),
    ).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it('maps a 4xx answer to a rejection carrying only the OAuth error code', async () => {
    const { client } = setup(() =>
      Response.json(
        { error: 'invalid_grant', error_description: 'secret detail' },
        { status: 400 },
      ),
    );
    const error = await exchange(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdpRejectedError);
    expect((error as IdpRejectedError).oauthError).toBe('invalid_grant');
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('maps an unusable 2xx body to a rejection', async () => {
    const { client } = setup(() => Response.json({ access_token: 'x' }));
    await expect(exchange(client)).rejects.toBeInstanceOf(IdpRejectedError);
  });

  it('maps 5xx and network failures to an outage', async () => {
    await expect(
      exchange(setup(() => new Response('boom', { status: 502 })).client),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
    await expect(
      exchange(setup(() => Promise.reject(new TypeError('fetch failed'))).client),
    ).rejects.toBeInstanceOf(IdpUnavailableError);
  });
});

describe('refresh', () => {
  it('posts the refresh token and accepts an answer without an ID token', async () => {
    const { client, tokenBodies } = setup(() =>
      Response.json({ access_token: 'at-2', token_type: 'bearer', expires_in: 300 }),
    );
    const tokens = await client.refresh('rt-1');
    expect(Object.fromEntries(tokenBodies[0] ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: CLIENT_ID,
    });
    expect(tokens).toMatchObject({
      accessToken: 'at-2',
      refreshToken: undefined,
      claims: undefined,
    });
  });

  it('verifies an ID token in the answer (no nonce on refresh)', async () => {
    const { client } = setup(() => tokenOk({ nonce: undefined }));
    expect((await client.refresh('rt-1')).claims).toMatchObject({ sub: 'user-1' });
    const bad = setup(() => tokenOk({ nonce: undefined, key: otherKey })).client;
    await expect(bad.refresh('rt-1')).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it('reports a revoked or reused refresh token as a rejection', async () => {
    const { client } = setup(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(client.refresh('rt-1')).rejects.toBeInstanceOf(IdpRejectedError);
  });
});

describe('endSessionUrl', () => {
  it('builds the RP-initiated logout URL with the ID token hint', async () => {
    const { client } = setup(() => new Response());
    const url = await client.endSessionUrl({ idToken: 'idt' });
    expect(`${url?.origin}${url?.pathname}`).toBe(discovery.end_session_endpoint);
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      client_id: CLIENT_ID,
      post_logout_redirect_uri: 'https://app.example.com/',
      id_token_hint: 'idt',
    });
  });

  it('omits the hint when there is none and returns undefined without an endpoint', async () => {
    const { client } = setup(() => new Response());
    expect(
      (await client.endSessionUrl({ idToken: undefined }))?.searchParams.has('id_token_hint'),
    ).toBe(false);
    const withoutEnd = Object.fromEntries(
      Object.entries(discovery).filter(([key]) => key !== 'end_session_endpoint'),
    );
    const none = setup(() => new Response(), { doc: withoutEnd }).client;
    expect(await none.endSessionUrl({ idToken: 'idt' })).toBeUndefined();
  });
});

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

interface LogoutOptions {
  readonly iss?: string;
  readonly aud?: string;
  readonly iat?: number;
  readonly sub?: string | undefined;
  readonly sid?: string | undefined;
  readonly jti?: string | undefined;
  readonly events?: Record<string, unknown> | undefined;
  readonly nonce?: string;
  readonly key?: CryptoKey;
}

/** A back-channel logout token as Keycloak signs it; every field can be overridden or removed. */
function logoutToken(options: LogoutOptions = {}): Promise<string> {
  const iat = options.iat ?? Math.floor(NOW / 1000);
  const claims: Record<string, unknown> = {
    events: options.events ?? { [LOGOUT_EVENT]: {} },
  };
  if (options.nonce !== undefined) claims.nonce = options.nonce;
  const sub = 'sub' in options ? options.sub : 'user-1';
  const sid = 'sid' in options ? options.sid : 'kc-session-1';
  const jti = 'jti' in options ? options.jti : 'jti-1';
  if (sub !== undefined) claims.sub = sub;
  if (sid !== undefined) claims.sid = sid;
  if (jti !== undefined) claims.jti = jti;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? CLIENT_ID)
    .setIssuedAt(iat)
    .sign(options.key ?? privateKey);
}

describe('verifyLogoutToken', () => {
  it('accepts a signed logout token and returns its subject, session and id', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    await expect(client.verifyLogoutToken(await logoutToken())).resolves.toEqual({
      sub: 'user-1',
      sid: 'kc-session-1',
      jti: 'jti-1',
    });
  });

  it('accepts a token that names only a subject, or only a session', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    await expect(
      client.verifyLogoutToken(await logoutToken({ sid: undefined })),
    ).resolves.toMatchObject({
      sub: 'user-1',
      sid: undefined,
    });
    await expect(
      client.verifyLogoutToken(await logoutToken({ sub: undefined })),
    ).resolves.toMatchObject({
      sub: undefined,
      sid: 'kc-session-1',
    });
  });

  it('refuses a forged token, a wrong issuer or audience, and a token from another key', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    await expect(
      client.verifyLogoutToken(await logoutToken({ key: otherKey })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
    await expect(
      client.verifyLogoutToken(await logoutToken({ iss: 'https://evil.example' })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
    await expect(
      client.verifyLogoutToken(await logoutToken({ aud: 'other-client' })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
  });

  it('refuses a token without the back-channel logout event, or that is an ID token with a nonce', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    await expect(
      client.verifyLogoutToken(await logoutToken({ events: {} })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
    await expect(
      client.verifyLogoutToken(await logoutToken({ events: { 'https://other/event': {} } })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
    await expect(
      client.verifyLogoutToken(await logoutToken({ nonce: NONCE })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
  });

  it('refuses a token that names neither a subject nor a session, or has no jti (no replay tracking)', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    await expect(
      client.verifyLogoutToken(await logoutToken({ sub: undefined, sid: undefined })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
    await expect(
      client.verifyLogoutToken(await logoutToken({ jti: undefined })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
  });

  it('refuses a token older than the maximum age, and one issued in the future', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')));
    const old = Math.floor(NOW / 1000) - 121;
    const future = Math.floor(NOW / 1000) + 60;
    await expect(client.verifyLogoutToken(await logoutToken({ iat: old }))).rejects.toBeInstanceOf(
      InvalidLogoutTokenError,
    );
    await expect(
      client.verifyLogoutToken(await logoutToken({ iat: future })),
    ).rejects.toBeInstanceOf(InvalidLogoutTokenError);
  });

  it('reports an unreachable IdP as unavailable, not as an invalid token', async () => {
    const { client } = setup(() => Promise.reject(new Error('unused')), { discoveryStatus: 503 });
    await expect(client.verifyLogoutToken(await logoutToken())).rejects.toBeInstanceOf(
      IdpUnavailableError,
    );
  });
});
