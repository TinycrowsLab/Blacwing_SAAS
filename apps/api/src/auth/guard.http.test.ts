import { Controller, Get, Module } from '@nestjs/common';
import { createLocalJWKSet } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deriveKey } from '@blackwing/crypto';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { createLogger } from '@blackwing/logger';

import {
  AUDIENCE,
  createSigningKeys,
  ISSUER,
  keycloakClaims,
  NOW_MS,
  OTHER_TENANT,
  sealedSessionCookie,
  sealedSessionRecord,
  sessionRecord,
  signToken,
  TENANT,
  type SigningKeys,
} from './fixtures.test-helpers.js';
import { createKeycloakJwtValidator } from './keycloak-jwt.js';
import { createAuthMetrics } from './metrics.js';
import { createSessionCookieValidator, SESSION_RECORD_KEY_PREFIX } from './session-cookie.js';
import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { AuthenticatedOnly } from '../rbac/require-permission.decorator.js';
import { PublicRoute } from '../tenant/public-route.js';

import type { AuthOptions } from './module.js';
import type { Problem } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const SID = 'sid_http_01';
const SESSION_KEY = deriveKey('h'.repeat(32));

@Controller('probe')
class AuthProbeController {
  @AuthenticatedOnly()
  @Get('tenant')
  tenant(): { tenantId: string; actorType: string } {
    const { tenantId, actor } = getTenantContextOrThrow();
    return { tenantId, actorType: actor.type };
  }

  @PublicRoute()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AuthProbeController] })
class AuthProbeModule {}

let keys: SigningKeys;

beforeAll(async () => {
  keys = await createSigningKeys();
});

let app: NestFastifyApplication;
let registryText: () => Promise<string>;
let sessionRecords: Map<string, string>;

beforeEach(async () => {
  const metrics = createHttpMetrics();
  const authMetrics = createAuthMetrics(metrics.registry);
  sessionRecords = new Map();
  const auth: AuthOptions = {
    keycloak: createKeycloakJwtValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      leewaySeconds: 60,
      resolveKey: createLocalJWKSet(keys.jwks),
      now: () => NOW_MS,
    }),
    session: createSessionCookieValidator({
      keys: [SESSION_KEY],
      valkey: { get: (key) => Promise.resolve(sessionRecords.get(key) ?? null) },
      now: () => NOW_MS,
    }),
    metrics: authMetrics,
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
  };
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    auth,
    imports: [AuthProbeModule],
  });
  app = created.app;
  registryText = () => metrics.registry.metrics();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const tenantProbe = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/v1/probe/tenant', headers });

describe('global auth guard over HTTP', () => {
  it('answers 401 AUTH_NO_CREDENTIALS as problem+json, before tenant resolution', async () => {
    const res = await tenantProbe();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('auth_no_credentials');
  });

  it('answers 401 AUTH_INVALID_TOKEN with a generic detail and no internals', async () => {
    const token = await signToken(keys, keycloakClaims({ aud: 'some-other-api' }));
    const res = await tenantProbe({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
    const problem = res.json<Problem>();
    expect(problem.code).toBe('auth_invalid_token');
    expect(problem.detail).toBe('The credentials could not be verified.');
    expect(res.body).not.toContain('audience');
  });

  it('answers 401 AUTH_EXPIRED for an expired Keycloak token', async () => {
    const token = await signToken(keys, keycloakClaims({ iat: 1, exp: 2 }));
    const res = await tenantProbe({ authorization: `Bearer ${token}` });
    expect(res.json<Problem>().code).toBe('auth_expired');
  });

  it('serves a valid Keycloak token, with the tenant from the verified claim', async () => {
    const token = await signToken(keys, keycloakClaims());
    const res = await tenantProbe({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: TENANT, actorType: 'user' });
  });

  it('marks a service-account token as a service actor', async () => {
    const token = await signToken(
      keys,
      keycloakClaims({ preferred_username: 'service-account-bw-worker' }),
    );
    const res = await tenantProbe({ authorization: `Bearer ${token}` });
    expect(res.json()).toEqual({ tenantId: TENANT, actorType: 'service' });
  });

  it('serves a valid BFF session cookie, with the tenant from the stored record', async () => {
    sessionRecords.set(
      SESSION_RECORD_KEY_PREFIX + SID,
      sealedSessionRecord(SESSION_KEY, SID, sessionRecord({ tenantId: OTHER_TENANT })),
    );
    const cookie = sealedSessionCookie(SESSION_KEY, SID);
    const res = await tenantProbe({ cookie: `__Host-bw_session=${cookie}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: OTHER_TENANT, actorType: 'user' });
  });

  it('refuses an opaque bw_pat_ token while RBAC-007 is not wired', async () => {
    const res = await tenantProbe({ authorization: 'Bearer bw_pat_SOMETHING' });
    expect(res.statusCode).toBe(401);
    expect(res.json<Problem>().code).toBe('auth_invalid_token');
  });

  it('never falls through to the cookie when the Authorization header is malformed', async () => {
    sessionRecords.set(
      SESSION_RECORD_KEY_PREFIX + SID,
      sealedSessionRecord(SESSION_KEY, SID, sessionRecord()),
    );
    const cookie = sealedSessionCookie(SESSION_KEY, SID);
    const res = await tenantProbe({
      authorization: 'Basic dXNlcjpwYXNz',
      cookie: `__Host-bw_session=${cookie}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<Problem>().code).toBe('auth_invalid_token');
  });

  it('never takes the tenant from a header or query that disagrees with the verified token', async () => {
    const token = await signToken(keys, keycloakClaims());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/probe/tenant?tenantId=${OTHER_TENANT}`,
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': OTHER_TENANT },
    });
    expect(res.json()).toEqual({ tenantId: TENANT, actorType: 'user' });
  });

  it('leaves a @PublicRoute open without any credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/probe/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('counts each decision on auth_validate_total with its path and result', async () => {
    const token = await signToken(keys, keycloakClaims());
    await tenantProbe({ authorization: `Bearer ${token}` });
    await tenantProbe();
    const text = await registryText();
    expect(text).toMatch(/auth_validate_total\{path="keycloak",result="success"\} 1/);
    expect(text).toMatch(/auth_validate_total\{path="none",result="no_credentials"\} 1/);
  });

  it('would not accept a random key that was never published in the realm JWKS', async () => {
    const stranger = await createSigningKeys();
    const token = await signToken(stranger, keycloakClaims());
    const res = await tenantProbe({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json<Problem>().code).toBe('auth_invalid_token');
  });
});
