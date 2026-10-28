import { createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PLATFORM_OPERATOR_PERMISSIONS, type Principal } from '@blackwing/contracts';
import { deriveKey } from '@blackwing/crypto';
import { isAppError } from '@blackwing/errors';

import { AuthInvalidTokenError } from '../errors.js';
import {
  AUDIENCE,
  createSigningKeys,
  ISSUER,
  keycloakClaims,
  NOW_MS,
  NOW_S,
  type SigningKeys,
  sealedSessionCookie,
  sealedSessionRecord,
  sessionRecord,
  signToken,
} from '../fixtures.test-helpers.js';
import { createKeycloakJwtValidator, type KeycloakJwtValidator } from '../keycloak-jwt.js';
import {
  createSessionCookieValidator,
  SESSION_RECORD_KEY_PREFIX,
  type SessionCookieValidator,
} from '../session-cookie.js';
import { createOperatorJwtValidator, type OperatorJwtValidator } from './operator-jwt.js';
import {
  createOperatorSessionValidator,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_LAYOUT,
  type OperatorSessionValidator,
} from './operator-session.js';
import {
  OPERATOR_AUDIENCE,
  OPERATOR_ID,
  OPERATOR_ISSUER,
  operatorClaims,
  operatorSessionRecord,
  sealedOperatorCookie,
  sealedOperatorRecord,
  signOperatorToken,
} from './operator.test-helpers.js';
import {
  createOperatorAuthenticator,
  requireOperator,
  type OperatorAuthOptions,
} from './require-operator.js';

import type { BearerTokenValidator } from '../bearer.js';

const LEEWAY = 60;
const OPERATOR_KEY = deriveKey('o'.repeat(32));
const TENANT_KEY = deriveKey('t'.repeat(32));
const SID = 'sid_0001';
const OPERATOR_BEARER_PROBE_TOKEN = 'bw_pat_tenant_token';

let keys: SigningKeys;
let resolveKey: JWTVerifyGetKey;
let operatorJwt: OperatorJwtValidator;
let tenantJwt: KeycloakJwtValidator;
let tenantSession: SessionCookieValidator;
let tenantBearer: BearerTokenValidator;

/** A Valkey stand-in with the given records. */
const valkey = (entries: Record<string, string>) => ({
  get: (key: string): Promise<string | null> => Promise.resolve(entries[key] ?? null),
});

function operatorSessionWith(entries: Record<string, string>): OperatorSessionValidator {
  return createOperatorSessionValidator({
    keys: [OPERATOR_KEY],
    valkey: valkey(entries),
    now: () => NOW_MS,
  });
}

const operatorRecordFor = (record: Record<string, unknown> = operatorSessionRecord()) => ({
  [OPERATOR_SESSION_LAYOUT.recordKeyPrefix + SID]: sealedOperatorRecord(OPERATOR_KEY, SID, record),
});

function options(overrides: Partial<OperatorAuthOptions> = {}) {
  const metrics = { mfaRequired: vi.fn(), refused: vi.fn() };
  const audit = vi.fn();
  const logger = { warn: vi.fn() };
  const base: OperatorAuthOptions = {
    operatorJwt,
    operatorSession: operatorSessionWith(operatorRecordFor()),
    tenant: { keycloak: tenantJwt, session: tenantSession, bearer: tenantBearer },
    metrics,
    audit,
    logger,
  };
  return { ...base, ...overrides, metrics, audit, logger };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sessionCookie = (cookie: string) => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${cookie}` });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isAppError(error)
      ? error.code
      : error instanceof AuthInvalidTokenError
        ? 'AUTH_INVALID_TOKEN'
        : 'UNKNOWN';
  }
  throw new Error('the request was served');
}

beforeAll(async () => {
  keys = await createSigningKeys();
  resolveKey = createLocalJWKSet(keys.jwks);
  operatorJwt = createOperatorJwtValidator({
    issuer: OPERATOR_ISSUER,
    audience: OPERATOR_AUDIENCE,
    leewaySeconds: LEEWAY,
    resolveKey,
    now: () => NOW_MS,
  });
  tenantJwt = createKeycloakJwtValidator({
    issuer: ISSUER,
    audience: AUDIENCE,
    leewaySeconds: LEEWAY,
    resolveKey,
    now: () => NOW_MS,
  });
  tenantSession = createSessionCookieValidator({
    keys: [TENANT_KEY],
    valkey: valkey({
      [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(TENANT_KEY, SID, sessionRecord()),
    }),
    now: () => NOW_MS,
  });
  tenantBearer = {
    validate: (token: string): Promise<Principal> =>
      token === OPERATOR_BEARER_PROBE_TOKEN
        ? Promise.resolve({
            subjectId: 'usr_01',
            kind: 'user',
            tenantId: '0198f0a0-0000-7000-8000-00000000000a',
            roles: ['tenant_admin'],
            scopes: [],
            authMethod: 'keycloak_jwt',
          })
        : Promise.reject(new AuthInvalidTokenError()),
  };
});

describe('operator guard: operator credentials (#838)', () => {
  it('serves a platform operator with a bearer token and maps it to the kill principal', async () => {
    const token = await signOperatorToken(keys, operatorClaims());
    const opts = options();
    const principal = await createOperatorAuthenticator(opts).authenticate(bearer(token));
    expect(principal).toMatchObject({
      operatorId: OPERATOR_ID,
      kind: 'operator',
      authMethod: 'operator_jwt',
    });
    expect('tenantId' in principal).toBe(false);

    const killPrincipal = await requireOperator(opts)({ headers: bearer(token) });
    expect(killPrincipal).toEqual({
      id: OPERATOR_ID,
      role: 'platform_operator',
      permissions: [...PLATFORM_OPERATOR_PERMISSIONS],
      tokenId: 'jti-0001',
    });
    expect(opts.audit).not.toHaveBeenCalled();
  });

  it('serves a platform operator with a live operator BFF session cookie', async () => {
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    const principal = await createOperatorAuthenticator(options()).authenticate(
      sessionCookie(cookie),
    );
    expect(principal).toMatchObject({ operatorId: OPERATOR_ID, authMethod: 'operator_session' });
  });

  it('blocks an operator token without the second factor (OPERATOR_MFA_REQUIRED), counted and audited', async () => {
    const token = await signOperatorToken(keys, operatorClaims({ acr: 'password' }));
    const opts = options();
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(token)))).toBe(
      'OPERATOR_MFA_REQUIRED',
    );
    expect(opts.metrics.mfaRequired).toHaveBeenCalledTimes(1);
    expect(opts.metrics.refused).toHaveBeenCalledWith('OPERATOR_MFA_REQUIRED');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'OPERATOR_MFA_REQUIRED',
      credential: 'bearer',
    });
  });

  it('blocks an operator session whose stored acr is not operator_strong', async () => {
    const opts = options({
      operatorSession: operatorSessionWith(
        operatorRecordFor(operatorSessionRecord({ acr: 'password' })),
      ),
    });
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    expect(
      await codeOf(createOperatorAuthenticator(opts).authenticate(sessionCookie(cookie))),
    ).toBe('OPERATOR_MFA_REQUIRED');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'OPERATOR_MFA_REQUIRED',
      credential: 'session',
    });
  });

  it('refuses an operator-realm account that lacks the platform_operator role as NOT_OPERATOR', async () => {
    const token = await signOperatorToken(
      keys,
      operatorClaims({ roles: ['verification_reviewer'] }),
    );
    const opts = options();
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(token)))).toBe(
      'NOT_OPERATOR',
    );
    expect(opts.metrics.refused).toHaveBeenCalledWith('NOT_OPERATOR');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'NOT_OPERATOR',
      credential: 'bearer',
    });
  });

  it('refuses every operator route when no operator validator is configured (fail closed)', async () => {
    const token = await signOperatorToken(keys, operatorClaims());
    const opts = options({ operatorJwt: undefined, operatorSession: undefined });
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(token)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    expect(
      await codeOf(createOperatorAuthenticator(opts).authenticate(sessionCookie(cookie))),
    ).toBe('AUTH_INVALID_TOKEN');
    expect(opts.audit).not.toHaveBeenCalled();
  });
});

describe('operator guard: tenant credentials at an operator route (#838)', () => {
  it('refuses a live tenant JWT as NOT_OPERATOR and audits it', async () => {
    const tenantToken = await signToken(keys, keycloakClaims());
    const opts = options();
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(tenantToken)))).toBe(
      'NOT_OPERATOR',
    );
    expect(opts.metrics.refused).toHaveBeenCalledWith('NOT_OPERATOR');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'NOT_OPERATOR',
      credential: 'bearer',
    });
  });

  it('refuses an expired tenant JWT as NOT_OPERATOR too: it was a tenant credential', async () => {
    const expired = await signToken(keys, keycloakClaims({ iat: NOW_S - 900, exp: NOW_S - 600 }));
    expect(await codeOf(createOperatorAuthenticator(options()).authenticate(bearer(expired)))).toBe(
      'NOT_OPERATOR',
    );
  });

  it('refuses a tenant opaque bearer token as NOT_OPERATOR', async () => {
    const opts = options();
    expect(
      await codeOf(
        createOperatorAuthenticator(opts).authenticate(bearer(OPERATOR_BEARER_PROBE_TOKEN)),
      ),
    ).toBe('NOT_OPERATOR');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'NOT_OPERATOR',
      credential: 'bearer',
    });
  });

  it('refuses a live tenant session cookie as NOT_OPERATOR (a tenant session never acts as an operator)', async () => {
    const tenantCookie = sealedSessionCookie(TENANT_KEY, SID);
    const opts = options({ operatorSession: undefined });
    expect(
      await codeOf(
        createOperatorAuthenticator(opts).authenticate({
          cookie: `__Host-bw_session=${tenantCookie}`,
        }),
      ),
    ).toBe('NOT_OPERATOR');
    expect(opts.audit).toHaveBeenCalledWith({
      action: 'authz.denied',
      reason: 'NOT_OPERATOR',
      credential: 'session',
    });
  });

  it('answers a tenant JWT with plain 401 when no tenant probe exists to classify it, and audits nothing', async () => {
    const tenantToken = await signToken(keys, keycloakClaims());
    const opts = options({ tenant: undefined });
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(tenantToken)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    expect(opts.audit).not.toHaveBeenCalled();
  });

  it('never serves a request that presents a tenant credential alongside a valid operator session', async () => {
    // Authorization wins over the cookie (as in the tenant guard): the tenant bearer is refused, no fall-through.
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    const headers = {
      authorization: `Bearer ${await signToken(keys, keycloakClaims())}`,
      cookie: `${OPERATOR_SESSION_COOKIE}=${cookie}`,
    };
    expect(await codeOf(createOperatorAuthenticator(options()).authenticate(headers))).toBe(
      'NOT_OPERATOR',
    );
  });
});

describe('operator guard: malformed or missing credentials (#838)', () => {
  it('answers a request with no credentials as unauthenticated', async () => {
    expect(await codeOf(createOperatorAuthenticator(options()).authenticate({}))).toBe(
      'AUTH_NO_CREDENTIALS',
    );
  });

  it('refuses a malformed Authorization header and never falls through to the operator cookie', async () => {
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    const headers = {
      authorization: 'Basic Zm9vOmJhcg==',
      cookie: `${OPERATOR_SESSION_COOKIE}=${cookie}`,
    };
    expect(await codeOf(createOperatorAuthenticator(options()).authenticate(headers))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses two operator cookies of one name as ambiguous', async () => {
    const cookie = sealedOperatorCookie(OPERATOR_KEY, SID);
    const headers = {
      cookie: `${OPERATOR_SESSION_COOKIE}=${cookie}; ${OPERATOR_SESSION_COOKIE}=${cookie}`,
    };
    expect(await codeOf(createOperatorAuthenticator(options()).authenticate(headers))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses an operator token that does not verify, as invalid (not as an operator, not as tenant)', async () => {
    const forged = await signOperatorToken(
      keys,
      operatorClaims({ iss: 'https://evil.example/realms/x' }),
    );
    const opts = options();
    expect(await codeOf(createOperatorAuthenticator(opts).authenticate(bearer(forged)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    expect(opts.audit).not.toHaveBeenCalled();
  });
});
