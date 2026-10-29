import { createLocalJWKSet, errors as joseErrors, type JWTVerifyGetKey, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import {
  AUDIENCE,
  createSigningKeys,
  ISSUER,
  keycloakClaims,
  NOW_MS,
  NOW_S,
  OTHER_TENANT,
  signToken,
  SUBJECT,
  TENANT,
  type SigningKeys,
} from './fixtures.test-helpers.js';
import { createKeycloakJwtValidator, type KeycloakJwtValidator } from './keycloak-jwt.js';

const LEEWAY = 60;
let keys: SigningKeys;
let resolveKey: JWTVerifyGetKey;
let validator: KeycloakJwtValidator;

beforeAll(async () => {
  keys = await createSigningKeys();
  resolveKey = createLocalJWKSet(keys.jwks);
  validator = createKeycloakJwtValidator({
    issuer: ISSUER,
    audience: AUDIENCE,
    leewaySeconds: LEEWAY,
    resolveKey,
    now: () => NOW_MS,
  });
});

/** The AppError code a refused token carries. */
async function refusedWith(token: string): Promise<string> {
  try {
    await validator.validate(token);
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
  throw new Error('the token was accepted');
}

describe('Keycloak JWT validation', () => {
  it('accepts a valid RS256 token and maps it to the canonical principal', async () => {
    const token = await signToken(keys, keycloakClaims({ acr: '1' }));
    await expect(validator.validate(token)).resolves.toEqual({
      subjectId: SUBJECT,
      kind: 'user',
      tenantId: TENANT,
      roles: ['tenant_admin'],
      scopes: ['openid', 'profile'],
      acr: '1',
      authMethod: 'keycloak_jwt',
    });
  });

  it('carries the auth_time the IdP reported onto the principal (step-up input, AUTHZ-008)', async () => {
    const token = await signToken(keys, keycloakClaims({ acr: 'strong', auth_time: NOW_S - 30 }));
    await expect(validator.validate(token)).resolves.toMatchObject({
      acr: 'strong',
      authTime: NOW_S - 30,
    });
  });

  it('refuses a non-integer auth_time instead of guessing the freshness of the login', async () => {
    const token = await signToken(keys, keycloakClaims({ auth_time: 'yesterday' }));
    await expect(refusedWith(token)).resolves.toBe('AUTH_INVALID_TOKEN');
  });

  it('accepts an ES256 token signed by a key in the realm JWKS', async () => {
    const token = await signToken(keys, keycloakClaims(), 'ES256');
    await expect(validator.validate(token)).resolves.toMatchObject({ authMethod: 'keycloak_jwt' });
  });

  it('marks a service-account token as a service principal', async () => {
    const token = await signToken(
      keys,
      keycloakClaims({ preferred_username: 'service-account-bw-worker' }),
    );
    await expect(validator.validate(token)).resolves.toMatchObject({ kind: 'service' });
  });

  it('falls back to the realm_access roles when no roles claim is present', async () => {
    const token = await signToken(
      keys,
      keycloakClaims({ roles: undefined, realm_access: { roles: ['auditor'] } }),
    );
    await expect(validator.validate(token)).resolves.toMatchObject({ roles: ['auditor'] });
  });

  it('refuses a token for another audience', async () => {
    const token = await signToken(keys, keycloakClaims({ aud: 'some-other-api' }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token from another issuer', async () => {
    const token = await signToken(keys, keycloakClaims({ iss: 'https://evil.example/realms/x' }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token whose signature does not verify', async () => {
    const other = await createSigningKeys();
    // Same kid as the trusted key, signed by a different private key.
    const forged = await signToken(other, keycloakClaims());
    expect(await refusedWith(forged)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a tampered payload', async () => {
    const token = await signToken(keys, keycloakClaims());
    const [header, , signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...keycloakClaims(), tenantId: OTHER_TENANT }),
    ).toString('base64url');
    expect(await refusedWith(`${header}.${tamperedPayload}.${signature}`)).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('reports an expired token as AUTH_EXPIRED', async () => {
    const token = await signToken(
      keys,
      keycloakClaims({ iat: NOW_S - 3600, exp: NOW_S - (LEEWAY + 1) }),
    );
    expect(await refusedWith(token)).toBe('AUTH_EXPIRED');
  });

  it('accepts a token expired within the clock-skew leeway', async () => {
    const token = await signToken(keys, keycloakClaims({ iat: NOW_S - 600, exp: NOW_S - 30 }));
    await expect(validator.validate(token)).resolves.toMatchObject({ subjectId: SUBJECT });
  });

  it('refuses a token that is not yet valid beyond the leeway (nbf)', async () => {
    const token = await signToken(keys, keycloakClaims({ nbf: NOW_S + LEEWAY + 1 }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('accepts a token whose nbf is within the leeway', async () => {
    const token = await signToken(keys, keycloakClaims({ nbf: NOW_S + 30 }));
    await expect(validator.validate(token)).resolves.toMatchObject({ subjectId: SUBJECT });
  });

  it('refuses an iat in the future beyond the leeway', async () => {
    const token = await signToken(keys, keycloakClaims({ iat: NOW_S + LEEWAY + 5 }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('accepts an iat slightly ahead of this server within the leeway', async () => {
    const token = await signToken(keys, keycloakClaims({ iat: NOW_S + 10 }));
    await expect(validator.validate(token)).resolves.toMatchObject({ subjectId: SUBJECT });
  });

  it('refuses alg none (an unsigned token)', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(keycloakClaims())}.`;
    expect(await refusedWith(unsigned)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an HMAC token that names a trusted kid (algorithm confusion)', async () => {
    const hmacKey = new TextEncoder().encode('an-attacker-chosen-secret-of-length-32');
    const token = await new SignJWT(keycloakClaims())
      .setProtectedHeader({ alg: 'HS256', kid: keys.rsa.kid })
      .sign(hmacKey);
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token whose kid is not in the realm JWKS', async () => {
    const token = await new SignJWT(keycloakClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-kid' })
      .sign(keys.rsa.privateKey);
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token without a tenant claim', async () => {
    const token = await signToken(keys, keycloakClaims({ tenantId: undefined }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a tenant claim that is not a UUID', async () => {
    const token = await signToken(keys, keycloakClaims({ tenantId: 'acme' }));
    expect(await refusedWith(token)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token without a subject or without an expiry', async () => {
    expect(await refusedWith(await signToken(keys, keycloakClaims({ sub: undefined })))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    expect(await refusedWith(await signToken(keys, keycloakClaims({ exp: undefined })))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses something that is not a JWT at all', async () => {
    expect(await refusedWith('not-a-jwt')).toBe('AUTH_INVALID_TOKEN');
  });

  it('applies a zero leeway when configured (strict clocks)', async () => {
    const strict = createKeycloakJwtValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      leewaySeconds: 0,
      resolveKey,
      now: () => NOW_MS,
    });
    const token = await signToken(keys, keycloakClaims({ exp: NOW_S - 1 }));
    await expect(strict.validate(token)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('surfaces a JWKS lookup failure as a refusal, never as a pass', async () => {
    const failing: JWTVerifyGetKey = () => {
      throw new joseErrors.JWKSNoMatchingKey();
    };
    const strict = createKeycloakJwtValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      leewaySeconds: LEEWAY,
      resolveKey: failing,
      now: () => NOW_MS,
    });
    const token = await signToken(keys, keycloakClaims());
    await expect(strict.validate(token)).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
  });
});
