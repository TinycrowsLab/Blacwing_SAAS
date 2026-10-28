import { trace, type Tracer } from '@opentelemetry/api';

import {
  PLATFORM_OPERATOR,
  PLATFORM_OPERATOR_PERMISSIONS,
  type OperatorPrincipal,
  type Principal,
} from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';

import { type CredentialHeaders, cookieValueOf, credentialOf } from '../credentials.js';
import { AuthExpiredError, AuthInvalidTokenError, AuthNoCredentialsError } from '../errors.js';
import { NotOperatorError, OperatorMfaRequiredError } from './errors.js';
import { OPERATOR_SESSION_COOKIE, type OperatorSessionValidator } from './operator-session.js';

import type { OperatorAuthMetrics, OperatorRefusal } from './metrics.js';
import type { BearerTokenValidator } from '../bearer.js';
import type { OperatorJwtValidator } from './operator-jwt.js';
import type { KeycloakJwtValidator } from '../keycloak-jwt.js';
import type { SessionCookieValidator } from '../session-cookie.js';
import type { Logger } from '@blackwing/logger';

/*
 * The platform-operator guard (#838, CONTEXT_PACK §1.2, §8.6). It authenticates `/operator/v1/*` requests against the
 * operator realm only. A tenant credential there is classified, refused as `NOT_OPERATOR` and audited. Nothing a
 * tenant holds can ever become an operator principal, and an operator principal never carries a tenant.
 */

const SPAN_NAME = 'auth.operator.validate';
const TRACER_NAME = '@blackwing/api/auth';
const PLATFORM_OPERATOR_ROLE = PLATFORM_OPERATOR;

/** An operator-route refusal the audit ledger records. Ids and codes only: no token, cookie or tenant value. */
interface OperatorAuthEvent {
  readonly action: 'authz.denied';
  readonly reason: OperatorRefusal;
  readonly credential: 'bearer' | 'session';
}
export type OperatorAuthAuditSink = (event: OperatorAuthEvent) => void;

/** The tenant validators, probed only to classify a tenant credential presented at an operator route. */
interface TenantProbes {
  readonly bearer?: BearerTokenValidator | undefined;
  readonly keycloak?: KeycloakJwtValidator | undefined;
  readonly session?: SessionCookieValidator | undefined;
}

export interface OperatorAuthOptions {
  readonly operatorJwt?: OperatorJwtValidator | undefined;
  readonly operatorSession?: OperatorSessionValidator | undefined;
  readonly tenant?: TenantProbes | undefined;
  readonly metrics: OperatorAuthMetrics;
  readonly audit?: OperatorAuthAuditSink | undefined;
  readonly logger: Pick<Logger, 'warn'>;
  readonly tracer?: Tracer | undefined;
}

/** The operator kill service's principal shape (operator-kill/ports.ts), derived from the operator principal. */
export interface KillOperatorPrincipal {
  readonly id: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly tokenId?: string;
}

export interface OperatorAuthenticator {
  /** The operator principal of a request, or a thrown `AppError`. Never returns a principal for a refused request. */
  authenticate(headers: CredentialHeaders): Promise<OperatorPrincipal>;
}

export function createOperatorAuthenticator(options: OperatorAuthOptions): OperatorAuthenticator {
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  return {
    authenticate: (headers) =>
      tracer.startActiveSpan(SPAN_NAME, async (span) => {
        try {
          return await decide(headers, options);
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          span.end();
        }
      }),
  };
}

/**
 * The guard in the shape `registerOperatorKillRoutes` takes: it authenticates the request and returns the kill
 * service's principal. Only a platform operator with the platform role and the second factor gets through.
 */
export function requireOperator(
  options: OperatorAuthOptions,
): (request: { readonly headers: CredentialHeaders }) => Promise<KillOperatorPrincipal> {
  const authenticator = createOperatorAuthenticator(options);
  return async (request) => {
    const principal = await authenticator.authenticate(request.headers);
    return {
      id: principal.operatorId,
      role: PLATFORM_OPERATOR_ROLE,
      permissions: [...PLATFORM_OPERATOR_PERMISSIONS],
      ...(principal.tokenId === undefined ? {} : { tokenId: principal.tokenId }),
    };
  };
}

async function decide(
  headers: CredentialHeaders,
  options: OperatorAuthOptions,
): Promise<OperatorPrincipal> {
  const bearer =
    headers.authorization === undefined
      ? undefined
      : credentialOf({ authorization: headers.authorization });
  if (bearer !== undefined && (bearer.kind === 'jwt' || bearer.kind === 'opaque-bearer')) {
    const principal = await fromBearer(bearer.kind, bearer.token, options);
    return requireOperatorRole(principal, 'bearer', options);
  }
  const operatorCookie = cookieValueOf(headers.cookie, OPERATOR_SESSION_COOKIE);
  if (operatorCookie !== undefined) {
    const principal = await fromSession(operatorCookie, options);
    return requireOperatorRole(principal, 'session', options);
  }
  // A tenant session cookie alone is classified (NOT_OPERATOR) rather than silently ignored.
  const tenantCookie = credentialOf({ cookie: headers.cookie });
  if (
    tenantCookie.kind === 'session-cookie' &&
    (await isTenant(() => options.tenant?.session?.validate(tenantCookie.cookie)))
  ) {
    throw refuse(options, new NotOperatorError(), 'session');
  }
  throw new AuthNoCredentialsError();
}

async function fromBearer(
  kind: 'jwt' | 'opaque-bearer',
  token: string,
  options: OperatorAuthOptions,
): Promise<OperatorPrincipal> {
  try {
    if (kind === 'jwt') {
      if (options.operatorJwt === undefined) {
        throw new AuthInvalidTokenError('operator tokens are not accepted by this deployment');
      }
      return await options.operatorJwt.validate(token);
    }
    throw new AuthInvalidTokenError('opaque tokens are not operator credentials');
  } catch (error) {
    if (error instanceof OperatorMfaRequiredError) throw refuse(options, error, 'bearer');
    // Not an operator credential, but a tenant one (live or expired): refused as NOT_OPERATOR and audited, never served.
    if (await isTenantBearer(kind, token, options)) {
      throw refuse(options, new NotOperatorError(), 'bearer');
    }
    throw error;
  }
}

async function fromSession(
  cookie: string,
  options: OperatorAuthOptions,
): Promise<OperatorPrincipal> {
  if (options.operatorSession === undefined) {
    throw new AuthInvalidTokenError('operator sessions are not accepted by this deployment');
  }
  try {
    return await options.operatorSession.validate(cookie);
  } catch (error) {
    if (error instanceof OperatorMfaRequiredError) throw refuse(options, error, 'session');
    throw error;
  }
}

/** A verified operator credential whose holder lacks the platform role is not an operator (RBAC-001). */
function requireOperatorRole(
  principal: OperatorPrincipal,
  credential: 'bearer' | 'session',
  options: OperatorAuthOptions,
): OperatorPrincipal {
  if (principal.roles.includes(PLATFORM_OPERATOR_ROLE)) return principal;
  throw refuse(options, new NotOperatorError(), credential);
}

/** Counts, logs and audits one refusal, then returns the error for the caller to throw. */
function refuse(
  options: OperatorAuthOptions,
  error: NotOperatorError | OperatorMfaRequiredError,
  credential: 'bearer' | 'session',
): NotOperatorError | OperatorMfaRequiredError {
  const reason: OperatorRefusal =
    error instanceof NotOperatorError ? 'NOT_OPERATOR' : 'OPERATOR_MFA_REQUIRED';
  if (reason === 'OPERATOR_MFA_REQUIRED') options.metrics.mfaRequired();
  options.metrics.refused(reason);
  options.logger.warn(
    { event: 'auth.operator_refused', reason, credential },
    'operator request refused',
  );
  options.audit?.({ action: 'authz.denied', reason, credential });
  return error;
}

/**
 * True when a tenant validator accepts the credential, or only reports it expired (it was a tenant credential). Any
 * other outcome (refused, unknown, outage) is not a tenant credential, so the original refusal stands.
 */
async function isTenant(
  probe: () => Promise<Principal | undefined> | Principal | undefined,
): Promise<boolean> {
  try {
    return (await probe()) !== undefined;
  } catch (error) {
    return (
      error instanceof AuthExpiredError || (isAppError(error) && error.code === 'AUTH_EXPIRED')
    );
  }
}

function isTenantBearer(
  kind: 'jwt' | 'opaque-bearer',
  token: string,
  options: OperatorAuthOptions,
): Promise<boolean> {
  return isTenant(() =>
    kind === 'jwt'
      ? options.tenant?.keycloak?.validate(token)
      : options.tenant?.bearer?.validate(token),
  );
}
