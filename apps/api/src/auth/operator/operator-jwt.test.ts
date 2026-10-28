import { createLocalJWKSet, type JWTVerifyGetKey, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import {
  AUDIENCE,
  createSigningKeys,
  ISSUER,
  NOW_MS,
  NOW_S,
  type SigningKeys,
  signToken,
  TENANT,
} from '../fixtures.test-helpers.js';
import { createOperatorJwtValidator, type OperatorJwtValidator } from './operator-jwt.js';
import {
  OPERATOR_AUDIENCE,
  OPERATOR_ID,
  OPERATOR_ISSUER,
  operatorClaims,
  signOperatorToken,
} from './operator.test-helpers.js';

const LEEWAY = 60;
let keys: SigningKeys;
let resolveKey: JWTVerifyGetKey;
let validator: OperatorJwtValidator;

beforeAll(async () => {
  keys = await createSigningKeys();
  resolveKey = createLocalJWKSet(keys.jwks);
  validator = createOperatorJwtValidator({
    issuer: OPERATOR_ISSUER,
    audience: OPERATOR_AUDIENCE,
    leewaySeconds: LEEWAY,
    resolveKey,
    now: () => NOW_MS,
  });
});

/** The AppError code a refused token carries, or the thrown value's name. */
async function refusedWith(token: string): Promise<string> {
  try {
    await validator.validate(token);
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
  throw new Error('the operator token was accepted');
}

describe('operator JWT validation (#838)', () => {
  it('accepts an operator token that completed the second factor and yields a principal with no tenant', async () => {
    const principal = await validator.validate(await signOperatorToken(keys, operatorClaims()));
    expect(principal).toEqual({
      operatorId: OPERATOR_ID,
      kind: 'operator',
      roles: ['platform_operator'],
      acr: 'operator_strong',
      tokenId: 'jti-0001',
      authMethod: 'operator_jwt',
    });
    expect('tenantId' in principal).toBe(false);
  });

  it('reads roles from realm_access when the roles claim is absent', async () => {
    const token = await signOperatorToken(
      keys,
      operatorClaims({ roles: undefined, realm_access: { roles: ['platform_admin'] } }),
    );
    expect((await validator.validate(token)).roles).toEqual(['platform_admin']);
  });

  it('refuses a tenant token (wrong issuer and audience) as not an operator credential', async () => {
    const tenant = await signToken(keys, {
      sub: 'usr_01',
      iss: ISSUER,
      aud: AUDIENCE,
      iat: NOW_S,
      exp: NOW_S + 300,
      tenantId: TENANT,
      roles: ['tenant_admin'],
      acr: 'strong',
    });
    expect(await refusedWith(tenant)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an operator-realm token addressed to the tenant API audience', async () => {
    expect(
      await refusedWith(await signOperatorToken(keys, operatorClaims({ aud: AUDIENCE }))),
    ).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token from another issuer', async () => {
    expect(
      await refusedWith(
        await signOperatorToken(
          keys,
          operatorClaims({ iss: 'https://evil.example/realms/blackwing-operators' }),
        ),
      ),
    ).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an operator token that carries a tenant claim (never a tenant-scoped operator)', async () => {
    expect(
      await refusedWith(await signOperatorToken(keys, operatorClaims({ tenantId: TENANT }))),
    ).toBe('AUTH_INVALID_TOKEN');
  });

  it.each([
    ['a password-only token (no second factor)', { acr: 'password' }],
    ['a token with no acr at all', { acr: undefined }],
    ['a tenant-style strong acr', { acr: 'strong' }],
  ])('blocks %s with OPERATOR_MFA_REQUIRED', async (_name, overrides) => {
    expect(await refusedWith(await signOperatorToken(keys, operatorClaims(overrides)))).toBe(
      'OPERATOR_MFA_REQUIRED',
    );
  });

  it('refuses an auth_time in the future beyond the leeway, and accepts one inside it', async () => {
    expect(
      await refusedWith(
        await signOperatorToken(keys, operatorClaims({ auth_time: NOW_S + LEEWAY + 30 })),
      ),
    ).toBe('AUTH_INVALID_TOKEN');
    const within = await signOperatorToken(keys, operatorClaims({ auth_time: NOW_S + LEEWAY - 5 }));
    await expect(validator.validate(within)).resolves.toMatchObject({ acr: 'operator_strong' });
  });

  it('refuses an expired operator token as expired (the console signs in again)', async () => {
    expect(
      await refusedWith(
        await signOperatorToken(keys, operatorClaims({ iat: NOW_S - 900, exp: NOW_S - 600 })),
      ),
    ).toBe('AUTH_EXPIRED');
  });

  it('refuses an HS256 token signed with a key the JWKS does not hold (algorithm confusion)', async () => {
    const forged = await new SignJWT({ roles: ['platform_operator'], acr: 'operator_strong' })
      .setProtectedHeader({ alg: 'HS256', kid: keys.rsa.kid })
      .setIssuer(OPERATOR_ISSUER)
      .setAudience(OPERATOR_AUDIENCE)
      .setSubject(OPERATOR_ID)
      .setIssuedAt(NOW_S)
      .setExpirationTime(NOW_S + 300)
      .sign(new TextEncoder().encode('a'.repeat(32)));
    expect(await refusedWith(forged)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an unsigned (alg none) token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(operatorClaims())).toString('base64url');
    expect(await refusedWith(`${header}.${body}.`)).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a token issued in the future beyond the leeway', async () => {
    expect(
      await refusedWith(
        await signOperatorToken(keys, operatorClaims({ iat: NOW_S + LEEWAY + 60 })),
      ),
    ).toBe('AUTH_INVALID_TOKEN');
  });
});
