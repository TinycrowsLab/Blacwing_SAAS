import { SignJWT, type JWTPayload } from 'jose';

import { seal } from '@blackwing/crypto';

import { NOW_MS, NOW_S, type SigningKeys } from '../fixtures.test-helpers.js';
import { OPERATOR_SESSION_LAYOUT } from './operator-session.js';

/** The platform-operator realm and its API audience (#838). Distinct from the tenant realm on purpose. */
export const OPERATOR_ISSUER = 'https://idp.example.test/realms/blackwing-operators';
export const OPERATOR_AUDIENCE = 'operator-api';
export const OPERATOR_ID = 'op_0001';
const TOKEN_LIFETIME_S = 300;
const MS_PER_SECOND = 1000;
const SESSION_TTL_MS = 600_000;

/** Claims a platform-operator access token carries after the operator second factor (#838). */
export function operatorClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    sub: OPERATOR_ID,
    iss: OPERATOR_ISSUER,
    aud: OPERATOR_AUDIENCE,
    iat: NOW_S,
    exp: NOW_S + TOKEN_LIFETIME_S,
    auth_time: NOW_S,
    acr: 'operator_strong',
    jti: 'jti-0001',
    roles: ['platform_operator'],
    ...overrides,
  };
}

/** Signs `claims` with the RS256 test key, using the realm's `kid` (what the JWKS publishes). */
export async function signOperatorToken(keys: SigningKeys, claims: JWTPayload): Promise<string> {
  const { iss, aud, sub, iat, exp, nbf, ...rest } = claims;
  let builder = new SignJWT(rest).setProtectedHeader({ alg: 'RS256', kid: keys.rsa.kid });
  if (typeof iss === 'string') builder = builder.setIssuer(iss);
  if (typeof aud === 'string' || Array.isArray(aud)) builder = builder.setAudience(aud);
  if (typeof sub === 'string') builder = builder.setSubject(sub);
  if (typeof iat === 'number') builder = builder.setIssuedAt(iat);
  if (typeof exp === 'number') builder = builder.setExpirationTime(exp);
  if (typeof nbf === 'number') builder = builder.setNotBefore(nbf);
  return builder.sign(keys.rsa.privateKey);
}

/** An operator session record as the operator BFF stores it under `op_session:<sid>` (#838). */
export function operatorSessionRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sub: OPERATOR_ID,
    roles: ['platform_operator'],
    acr: 'operator_strong',
    accessToken: 'opaque-operator-access-token',
    accessExpiresAt: NOW_MS + TOKEN_LIFETIME_S * MS_PER_SECOND,
    csrf: 'operator-csrf-secret',
    ...overrides,
  };
}

/** Seals a platform-operator session cookie for the browser (purpose `operator-session-cookie`). */
export function sealedOperatorCookie(
  key: Buffer,
  sid: string,
  ttlMs = 600_000,
  at = NOW_MS,
): string {
  return seal(key, OPERATOR_SESSION_LAYOUT.cookiePurpose, { sid }, ttlMs, at);
}

/** Seals an operator session record for Valkey under `op_session:<sid>` (purpose `operator-session:<sid>`). */
export function sealedOperatorRecord(
  key: Buffer,
  sid: string,
  record: Record<string, unknown>,
  at = NOW_MS,
): string {
  return seal(
    key,
    `${OPERATOR_SESSION_LAYOUT.recordPurposePrefix}${sid}`,
    record,
    SESSION_TTL_MS,
    at,
  );
}
