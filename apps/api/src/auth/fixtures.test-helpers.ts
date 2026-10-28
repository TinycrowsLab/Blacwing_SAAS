import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';

import { seal } from '@blackwing/crypto';

const MS_PER_SECOND = 1000;
const TOKEN_LIFETIME_S = 300;
const SESSION_TTL_MS = 600_000;

/** A fixed clock: every token and session in these tests is judged at this instant. */
export const NOW_MS = Date.parse('2026-10-28T12:00:00Z');
export const NOW_S = NOW_MS / MS_PER_SECOND;
export const ISSUER = 'https://idp.example.test/realms/blackwing';
export const AUDIENCE = 'blackwing-api';
export const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
export const OTHER_TENANT = '0198f0a0-0000-7000-8000-00000000000b';
export const SUBJECT = 'usr_01';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface SigningKeys {
  readonly rsa: { readonly kid: string; readonly privateKey: PrivateKey };
  readonly ec: { readonly kid: string; readonly privateKey: PrivateKey };
  /** The public key set the validators are given (`createLocalJWKSet` input). */
  readonly jwks: { keys: JWK[] };
}

/** RS256 and ES256 key pairs with their public JWKS, exactly what a Keycloak realm publishes. */
export async function createSigningKeys(): Promise<SigningKeys> {
  const rsa = await generateKeyPair('RS256', { extractable: true });
  const ec = await generateKeyPair('ES256', { extractable: true });
  const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
  const ecJwk = { ...(await exportJWK(ec.publicKey)), kid: 'ec-1', alg: 'ES256', use: 'sig' };
  return {
    rsa: { kid: 'rsa-1', privateKey: rsa.privateKey },
    ec: { kid: 'ec-1', privateKey: ec.privateKey },
    jwks: { keys: [rsaJwk, ecJwk] },
  };
}

/** The claims a Keycloak access token of a tenant user carries (see infra/keycloak/realm-blackwing.json). */
export function keycloakClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  const claims: Record<string, unknown> = {
    sub: SUBJECT,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW_S,
    exp: NOW_S + TOKEN_LIFETIME_S,
    tenantId: TENANT,
    roles: ['tenant_admin'],
    scope: 'openid profile',
    preferred_username: 'alice',
    ...overrides,
  };
  return claims;
}

/** Signs `claims` with the RS256 key (default) or ES256, using the realm's `kid`. */
export async function signToken(
  keys: SigningKeys,
  claims: JWTPayload,
  alg: 'RS256' | 'ES256' = 'RS256',
): Promise<string> {
  const key = alg === 'RS256' ? keys.rsa : keys.ec;
  const { iss, aud, sub, iat, exp, nbf, ...rest } = claims;
  let builder = new SignJWT(rest).setProtectedHeader({ alg, kid: key.kid });
  if (typeof iss === 'string') builder = builder.setIssuer(iss);
  if (typeof aud === 'string' || Array.isArray(aud)) builder = builder.setAudience(aud);
  if (typeof sub === 'string') builder = builder.setSubject(sub);
  if (typeof iat === 'number') builder = builder.setIssuedAt(iat);
  if (typeof exp === 'number') builder = builder.setExpirationTime(exp);
  if (typeof nbf === 'number') builder = builder.setNotBefore(nbf);
  return builder.sign(key.privateKey);
}

/** A BFF session record as the web app stores it in Valkey (only the fields the API reads matter). */
export function sessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: SUBJECT,
    email: 'alice@example.test',
    name: 'Alice',
    tenantId: TENANT,
    tenantSlug: 'acme',
    roles: ['tenant_admin'],
    accessToken: 'opaque-access-token',
    accessExpiresAt: NOW_MS + TOKEN_LIFETIME_S * MS_PER_SECOND,
    csrf: 'csrf-secret',
    ...overrides,
  };
}

/** Seals a session id for the browser (purpose `session-cookie`), as `apps/web` does. */
export function sealedSessionCookie(
  key: Buffer,
  sid: string,
  ttlMs = 600_000,
  at = NOW_MS,
): string {
  return seal(key, 'session-cookie', { sid }, ttlMs, at);
}

/** Seals a record for Valkey under `bw:web:sess:<sid>` (purpose `session:<sid>`), as `apps/web` does. */
export function sealedSessionRecord(
  key: Buffer,
  sid: string,
  record: Record<string, unknown>,
  ttlMs = SESSION_TTL_MS,
  at = NOW_MS,
): string {
  return seal(key, `session:${sid}`, record, ttlMs, at);
}
