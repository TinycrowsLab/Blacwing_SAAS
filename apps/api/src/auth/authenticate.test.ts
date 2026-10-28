import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { principalSchema, type Principal } from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';

import { createAuthenticator, type AuthEvent } from './authenticate.js';
import { type BearerTokenValidator, UNCONFIGURED_BEARER_VALIDATOR } from './bearer.js';
import {
  AuthExpiredError,
  AuthInvalidTokenError,
  AuthSessionStoreUnavailableError,
  JwksUnavailableError,
} from './errors.js';
import { OTHER_TENANT, TENANT } from './fixtures.test-helpers.js';

import type { KeycloakJwtValidator } from './keycloak-jwt.js';
import type { AuthMetrics } from './metrics.js';
import type { SessionCookieValidator } from './session-cookie.js';

const BEARER_TOKEN = 'bw_pat_SECRET-TOKEN-VALUE';
const CI_TOKEN = 'bw_ci_SECRET-CI-VALUE';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln-SECRET-JWT';
const COOKIE_VALUE = 'SEALED-COOKIE-SECRET';

function principal(authMethod: Principal['authMethod'], tenantId = TENANT): Principal {
  return principalSchema.parse({
    subjectId: 'usr_01',
    kind: 'user',
    tenantId,
    roles: ['viewer'],
    scopes: [],
    authMethod,
  });
}

function fixture(
  overrides: {
    withKeycloak?: boolean;
    withSession?: boolean;
    bearer?: BearerTokenValidator;
    tracer?: Tracer;
  } = {},
) {
  const keycloakValidate = vi.fn(() => Promise.resolve(principal('keycloak_jwt')));
  const sessionValidate = vi.fn(() => Promise.resolve(principal('bff_session')));
  const bearerValidate = vi.fn(() => Promise.resolve(principal('keycloak_jwt')));
  const validated = vi.fn();
  const warn = vi.fn();
  const keycloak: KeycloakJwtValidator = { validate: keycloakValidate };
  const session: SessionCookieValidator = { validate: sessionValidate };
  const bearer: BearerTokenValidator = overrides.bearer ?? { validate: bearerValidate };
  const metrics: AuthMetrics = { validated, jwksFetch: vi.fn() };
  const events: AuthEvent[] = [];
  const authenticator = createAuthenticator({
    keycloak: overrides.withKeycloak === false ? undefined : keycloak,
    session: overrides.withSession === false ? undefined : session,
    bearer,
    metrics,
    logger: { warn },
    events: (event) => {
      events.push(event);
    },
    ...(overrides.tracer === undefined ? {} : { tracer: overrides.tracer }),
  });
  return {
    authenticator,
    keycloakValidate,
    sessionValidate,
    bearerValidate,
    validated,
    warn,
    events,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the request was accepted');
}

describe('createAuthenticator: credential dispatch', () => {
  it('routes a bw_pat_ bearer to the opaque-token validator only', async () => {
    const f = fixture();
    const result = await f.authenticator.authenticate({ authorization: `Bearer ${BEARER_TOKEN}` });
    expect(f.bearerValidate).toHaveBeenCalledWith(BEARER_TOKEN);
    expect(f.keycloakValidate).not.toHaveBeenCalled();
    expect(f.sessionValidate).not.toHaveBeenCalled();
    expect(result.authMethod).toBe('keycloak_jwt');
  });

  it('routes a bw_ci_ bearer to the opaque-token validator', async () => {
    const f = fixture();
    await f.authenticator.authenticate({ authorization: `Bearer ${CI_TOKEN}` });
    expect(f.bearerValidate).toHaveBeenCalledWith(CI_TOKEN);
    expect(f.keycloakValidate).not.toHaveBeenCalled();
  });

  it('routes a JWT bearer to the Keycloak validator only', async () => {
    const f = fixture();
    await f.authenticator.authenticate({ authorization: `Bearer ${JWT}` });
    expect(f.keycloakValidate).toHaveBeenCalledWith(JWT);
    expect(f.bearerValidate).not.toHaveBeenCalled();
    expect(f.sessionValidate).not.toHaveBeenCalled();
  });

  it('routes a session cookie (with no Authorization header) to the session validator only', async () => {
    const f = fixture();
    const result = await f.authenticator.authenticate({
      cookie: `__Host-bw_session=${COOKIE_VALUE}`,
    });
    expect(f.sessionValidate).toHaveBeenCalledWith(COOKIE_VALUE);
    expect(f.keycloakValidate).not.toHaveBeenCalled();
    expect(f.bearerValidate).not.toHaveBeenCalled();
    expect(result.authMethod).toBe('bff_session');
  });

  it('a bw_ bearer wins over a session cookie and never reaches the session path', async () => {
    const f = fixture();
    await f.authenticator.authenticate({
      authorization: `Bearer ${BEARER_TOKEN}`,
      cookie: `__Host-bw_session=${COOKIE_VALUE}`,
    });
    expect(f.bearerValidate).toHaveBeenCalledTimes(1);
    expect(f.sessionValidate).not.toHaveBeenCalled();
  });

  it('refuses a malformed Authorization header even when a valid cookie is present', async () => {
    const f = fixture();
    const error = await errorOf(
      f.authenticator.authenticate({
        authorization: 'Basic dXNlcjpwYXNz',
        cookie: `__Host-bw_session=${COOKIE_VALUE}`,
      }),
    );
    expect(isAppError(error) && error.code).toBe('AUTH_INVALID_TOKEN');
    expect(f.sessionValidate).not.toHaveBeenCalled();
  });

  it('refuses a request with no credential as AUTH_NO_CREDENTIALS and calls no validator', async () => {
    const f = fixture();
    const error = await errorOf(f.authenticator.authenticate({}));
    expect(isAppError(error) && error.code).toBe('AUTH_NO_CREDENTIALS');
    expect(f.keycloakValidate).not.toHaveBeenCalled();
    expect(f.sessionValidate).not.toHaveBeenCalled();
    expect(f.bearerValidate).not.toHaveBeenCalled();
  });

  it('refuses a JWT when Keycloak is not configured (fail closed)', async () => {
    const f = fixture({ withKeycloak: false });
    const error = await errorOf(f.authenticator.authenticate({ authorization: `Bearer ${JWT}` }));
    expect(isAppError(error) && error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a session cookie when the session store is not configured (fail closed)', async () => {
    const f = fixture({ withSession: false });
    const error = await errorOf(
      f.authenticator.authenticate({ cookie: `__Host-bw_session=${COOKIE_VALUE}` }),
    );
    expect(isAppError(error) && error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses opaque tokens until RBAC-007 wires a validator (the default is unconfigured)', async () => {
    const f = fixture({ bearer: UNCONFIGURED_BEARER_VALIDATOR });
    const error = await errorOf(
      f.authenticator.authenticate({ authorization: `Bearer ${BEARER_TOKEN}` }),
    );
    expect(isAppError(error) && error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('propagates an unexpected validator failure as a refusal, never a pass', async () => {
    const f = fixture();
    vi.mocked(f.keycloakValidate).mockRejectedValueOnce(new TypeError('boom'));
    await expect(
      f.authenticator.authenticate({ authorization: `Bearer ${JWT}` }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('createAuthenticator: metrics, events and logs', () => {
  it('counts a success with its path and result, and reports the ids to audit', async () => {
    const f = fixture();
    await f.authenticator.authenticate({ authorization: `Bearer ${JWT}` });
    expect(f.validated).toHaveBeenCalledWith('keycloak', 'success');
    expect(f.events).toEqual([
      { path: 'keycloak', result: 'success', subjectId: 'usr_01', tenantId: TENANT },
    ]);
  });

  it.each([
    ['no credentials', {}, 'none', 'no_credentials'],
    ['a malformed header', { authorization: 'Basic x' }, 'none', 'invalid'],
  ] as const)('counts %s with the right path and result', async (_name, headers, path, result) => {
    const f = fixture();
    await expect(f.authenticator.authenticate(headers)).rejects.toThrow();
    expect(f.validated).toHaveBeenCalledWith(path, result);
  });

  it('maps an expired token to the expired result', async () => {
    const f = fixture();
    vi.mocked(f.keycloakValidate).mockRejectedValueOnce(new AuthExpiredError());
    await expect(
      f.authenticator.authenticate({ authorization: `Bearer ${JWT}` }),
    ).rejects.toThrow();
    expect(f.validated).toHaveBeenCalledWith('keycloak', 'expired');
  });

  it('maps a JWKS outage (cold cache) to the unavailable result while refusing with 401', async () => {
    const f = fixture();
    vi.mocked(f.keycloakValidate).mockRejectedValueOnce(
      new AuthInvalidTokenError('signing keys unavailable', {
        cause: new JwksUnavailableError(new Error('x')),
      }),
    );
    const error = await errorOf(f.authenticator.authenticate({ authorization: `Bearer ${JWT}` }));
    expect(isAppError(error) && error.code).toBe('AUTH_INVALID_TOKEN');
    expect(f.validated).toHaveBeenCalledWith('keycloak', 'unavailable');
  });

  it('maps a session-store outage to the unavailable result (503 to the caller)', async () => {
    const f = fixture();
    vi.mocked(f.sessionValidate).mockRejectedValueOnce(new AuthSessionStoreUnavailableError());
    const error = await errorOf(
      f.authenticator.authenticate({ cookie: `__Host-bw_session=${COOKIE_VALUE}` }),
    );
    expect(isAppError(error) && error.code).toBe('EXTERNAL_BACKEND_UNAVAILABLE');
    expect(f.validated).toHaveBeenCalledWith('session', 'unavailable');
  });

  it('logs refusals with ids and codes only, never the token or cookie', async () => {
    const f = fixture();
    vi.mocked(f.bearerValidate).mockRejectedValueOnce(new AuthInvalidTokenError());
    await expect(
      f.authenticator.authenticate({ authorization: `Bearer ${BEARER_TOKEN}` }),
    ).rejects.toThrow();
    expect(f.warn).toHaveBeenCalledWith(
      { event: 'auth.rejected', path: 'bearer', result: 'invalid', code: 'AUTH_INVALID_TOKEN' },
      'request authentication refused',
    );
    const logged = JSON.stringify(f.warn.mock.calls);
    expect(logged).not.toContain(BEARER_TOKEN);
    expect(logged).not.toContain(COOKIE_VALUE);
  });

  it('keeps the tenant of a success distinct from any other tenant', async () => {
    const f = fixture();
    vi.mocked(f.keycloakValidate).mockResolvedValueOnce(principal('keycloak_jwt', OTHER_TENANT));
    await f.authenticator.authenticate({ authorization: `Bearer ${JWT}` });
    expect(f.events[0]).toMatchObject({ tenantId: OTHER_TENANT });
  });
});

describe('createAuthenticator: tracing', () => {
  it('runs each decision in an auth.validate span carrying the path and result', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const f = fixture({ tracer: provider.getTracer('test') });
    await f.authenticator.authenticate({ authorization: `Bearer ${JWT}` });
    await expect(f.authenticator.authenticate({})).rejects.toThrow();
    const [success, refusal] = exporter.getFinishedSpans();
    expect(success).toMatchObject({ name: 'auth.validate' });
    expect(success?.attributes).toEqual({ 'auth.path': 'keycloak', 'auth.result': 'success' });
    expect(refusal?.attributes).toEqual({ 'auth.path': 'none', 'auth.result': 'no_credentials' });
    expect(refusal?.status.code).toBe(SpanStatusCode.ERROR);
    const exported = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes })),
    );
    expect(exported).not.toContain(JWT);
  });
});
