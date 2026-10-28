import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import {
  discoveryDocument,
  fakeFetch,
  jsonResponse,
  OIDC_DISCOVERY_URL,
  OIDC_ISSUER,
} from './fixtures.test-helpers.js';
import { discoverOidc, normaliseIssuer } from './oidc-discovery.js';

const discover = (routes: Parameters<typeof fakeFetch>[0], issuer = OIDC_ISSUER) => {
  const { fetch } = fakeFetch(routes);
  return discoverOidc(issuer, { fetch, timeoutMs: 1000 });
};

describe('discoverOidc', () => {
  it('returns the endpoints of a valid discovery document', async () => {
    const found = await discover({ [OIDC_DISCOVERY_URL]: () => jsonResponse(discoveryDocument()) });
    expect(found).toEqual({
      issuer: OIDC_ISSUER,
      authorizationEndpoint: `${OIDC_ISSUER}/authorize`,
      tokenEndpoint: `${OIDC_ISSUER}/token`,
      jwksUri: `${OIDC_ISSUER}/jwks`,
      userinfoEndpoint: `${OIDC_ISSUER}/userinfo`,
    });
  });

  it('accepts an issuer with a trailing slash and compares it normalised', async () => {
    const found = await discover(
      { [OIDC_DISCOVERY_URL]: () => jsonResponse(discoveryDocument()) },
      `${OIDC_ISSUER}/`,
    );
    expect(found.issuer).toBe(OIDC_ISSUER);
  });

  it('omits the userinfo endpoint when the document has none', async () => {
    const doc = discoveryDocument();
    delete doc.userinfo_endpoint;
    const found = await discover({ [OIDC_DISCOVERY_URL]: () => jsonResponse(doc) });
    expect(found).not.toHaveProperty('userinfoEndpoint');
  });

  it('fails with a retryable error when the issuer is unreachable', async () => {
    const error = await discover({
      [OIDC_DISCOVERY_URL]: () => Promise.reject(new TypeError('fetch failed')),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXTERNAL_BACKEND_UNAVAILABLE', retryable: true });
  });

  it('refuses an issuer that is not https before fetching anything', async () => {
    const { fetch, seen } = fakeFetch({});
    await expect(
      discoverOidc('http://idp.example.test', { fetch, timeoutMs: 1000 }),
    ).rejects.toThrow(ValidationError);
    expect(seen).toHaveLength(0);
  });

  it('refuses a discovery document whose issuer is a different one (issuer mix-up)', async () => {
    const error = await discover({
      [OIDC_DISCOVERY_URL]: () =>
        jsonResponse(discoveryDocument({ issuer: 'https://attacker.example.test' })),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as ValidationError).detail)).toMatch(/must equal the configured issuer/);
  });

  it('refuses a document that is not JSON', async () => {
    const error = await discover({
      [OIDC_DISCOVERY_URL]: () => new Response('<html>', { status: 200 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
    'refuses a document without %s',
    async (field) => {
      const doc = Object.fromEntries(
        Object.entries(discoveryDocument()).filter(([key]) => key !== field),
      );
      await expect(discover({ [OIDC_DISCOVERY_URL]: () => jsonResponse(doc) })).rejects.toThrow(
        ValidationError,
      );
    },
  );

  it('refuses a provider that does not offer the code response type', async () => {
    await expect(
      discover({
        [OIDC_DISCOVERY_URL]: () =>
          jsonResponse(discoveryDocument({ response_types_supported: ['token'] })),
      }),
    ).rejects.toThrow(/authorization code flow/);
  });

  it('refuses a provider that does not offer PKCE with S256', async () => {
    await expect(
      discover({
        [OIDC_DISCOVERY_URL]: () =>
          jsonResponse(discoveryDocument({ code_challenge_methods_supported: ['plain'] })),
      }),
    ).rejects.toThrow(/PKCE/);
  });

  it.each([
    [
      'an http authorization endpoint',
      { authorization_endpoint: 'http://idp.example.test/authorize' },
    ],
    ['a private token endpoint', { token_endpoint: 'https://10.0.0.5/token' }],
    ['a file jwks URI', { jwks_uri: 'file:///etc/passwd' }],
    [
      'credentials in the userinfo endpoint',
      { userinfo_endpoint: 'https://u:p@idp.example.test/userinfo' },
    ],
  ])('refuses %s', async (_name, override) => {
    await expect(
      discover({ [OIDC_DISCOVERY_URL]: () => jsonResponse(discoveryDocument(override)) }),
    ).rejects.toThrow(ValidationError);
  });

  it('keeps AppError semantics: the failure is a subclass of AppError', async () => {
    const error = await discover({
      [OIDC_DISCOVERY_URL]: () => jsonResponse(discoveryDocument({ jwks_uri: 'http://x' })),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
  });
});

describe('normaliseIssuer', () => {
  it('strips trailing slashes only', () => {
    expect(normaliseIssuer('https://idp.example.test//')).toBe('https://idp.example.test');
    expect(normaliseIssuer('https://idp.example.test/realms/a')).toBe(
      'https://idp.example.test/realms/a',
    );
  });
});
