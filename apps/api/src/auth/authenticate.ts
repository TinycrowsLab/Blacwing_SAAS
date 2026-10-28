import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { isAppError } from '@blackwing/errors';

import { type CredentialHeaders, type Credential, credentialOf } from './credentials.js';
import { AuthInvalidTokenError, AuthNoCredentialsError, JwksUnavailableError } from './errors.js';

import type { BearerTokenValidator } from './bearer.js';
import type { KeycloakJwtValidator } from './keycloak-jwt.js';
import type { AuthMetrics, AuthPath, AuthResult } from './metrics.js';
import type { SessionCookieValidator } from './session-cookie.js';
import type { Principal } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

/** What an auth decision feeds to audit (IAM-012 attaches its writer here). Carries ids and codes only. */
export interface AuthEvent {
  readonly path: AuthPath;
  readonly result: AuthResult;
  readonly subjectId?: string;
  readonly tenantId?: string;
}
export type AuthEventSink = (event: AuthEvent) => void;

export interface AuthenticatorOptions {
  readonly keycloak?: KeycloakJwtValidator | undefined;
  readonly session?: SessionCookieValidator | undefined;
  readonly bearer: BearerTokenValidator;
  readonly metrics: AuthMetrics;
  readonly logger: Pick<Logger, 'warn'>;
  readonly events?: AuthEventSink | undefined;
  readonly tracer?: Tracer | undefined;
}

/** The span every authentication decision runs in (`path` and `result` attributes). */
const AUTH_VALIDATE_SPAN = 'auth.validate';
const TRACER_NAME = '@blackwing/api/auth';

export interface Authenticator {
  /** The principal of a request, or a thrown `AppError` (401). Never returns a principal for a refused request. */
  authenticate(headers: CredentialHeaders): Promise<Principal>;
}

/**
 * Selects exactly one validator by credential shape and attaches its principal (#335). Whichever validator
 * runs, the principal has the same shape. Every refusal is counted, logged with ids and codes only, and
 * reported to the audit sink. Tokens and cookies are never logged.
 */
export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  return {
    authenticate: (headers) =>
      tracer.startActiveSpan(AUTH_VALIDATE_SPAN, async (span) => {
        try {
          return await decide(headers, options, span);
        } finally {
          span.end();
        }
      }),
  };
}

async function decide(
  headers: CredentialHeaders,
  options: AuthenticatorOptions,
  span: Span,
): Promise<Principal> {
  let path: AuthPath = 'none';
  try {
    const credential = credentialOf(headers);
    path = pathOf(credential);
    if (credential.kind === 'none') throw new AuthNoCredentialsError();
    const principal = await validate(credential, options);
    options.metrics.validated(path, 'success');
    span.setAttributes({ 'auth.path': path, 'auth.result': 'success' });
    options.events?.({
      path,
      result: 'success',
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
    });
    return principal;
  } catch (error) {
    const result = resultOf(error);
    options.metrics.validated(path, result);
    span.setAttributes({ 'auth.path': path, 'auth.result': result });
    span.setStatus({ code: SpanStatusCode.ERROR });
    options.events?.({ path, result });
    options.logger.warn(
      { event: 'auth.rejected', path, result, code: isAppError(error) ? error.code : 'UNKNOWN' },
      'request authentication refused',
    );
    throw error;
  }
}

function pathOf(credential: Credential): AuthPath {
  switch (credential.kind) {
    case 'none':
      return 'none';
    case 'opaque-bearer':
      return 'bearer';
    case 'jwt':
      return 'keycloak';
    case 'session-cookie':
      return 'session';
  }
}

async function validate(credential: Credential, options: AuthenticatorOptions): Promise<Principal> {
  switch (credential.kind) {
    case 'none':
      throw new AuthNoCredentialsError();
    case 'opaque-bearer':
      return options.bearer.validate(credential.token);
    case 'jwt':
      if (options.keycloak === undefined) {
        throw new AuthInvalidTokenError('Keycloak tokens are not accepted by this deployment');
      }
      return options.keycloak.validate(credential.token);
    case 'session-cookie':
      if (options.session === undefined) {
        throw new AuthInvalidTokenError('session cookies are not accepted by this deployment');
      }
      return options.session.validate(credential.cookie);
  }
}

function resultOf(error: unknown): AuthResult {
  if (isAppError(error)) {
    switch (error.code) {
      case 'AUTH_NO_CREDENTIALS':
        return 'no_credentials';
      case 'AUTH_EXPIRED':
        return 'expired';
      case 'EXTERNAL_BACKEND_UNAVAILABLE':
        return 'unavailable';
      default:
        break;
    }
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof JwksUnavailableError ? 'unavailable' : 'invalid';
}
