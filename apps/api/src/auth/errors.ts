import { AppError, type AppErrorOptions } from '@blackwing/errors';

/**
 * Errors of the global auth guard (#335). Each carries a stable registry code and a generic client detail:
 * nothing about why a signature, claim or session failed reaches the caller (no internal detail leakage).
 */

/** No credential is presented: no `Authorization` bearer and no session cookie. */
export class AuthNoCredentialsError extends AppError {
  declare readonly code: 'AUTH_NO_CREDENTIALS';
  constructor(options: AppErrorOptions = {}) {
    super('AUTH_NO_CREDENTIALS', 'no credentials presented', {
      detail: 'Authentication is required.',
      ...options,
    });
  }
}

/** A credential that does not verify: bad signature, issuer, audience, algorithm, claims or shape. */
export class AuthInvalidTokenError extends AppError {
  declare readonly code: 'AUTH_INVALID_TOKEN';
  constructor(message = 'credentials could not be verified', options: AppErrorOptions = {}) {
    super('AUTH_INVALID_TOKEN', message, {
      detail: 'The credentials could not be verified.',
      ...options,
    });
  }
}

/** A credential or session that existed and has expired (or was ended). */
export class AuthExpiredError extends AppError {
  declare readonly code: 'AUTH_EXPIRED';
  constructor(message = 'credentials have expired', options: AppErrorOptions = {}) {
    super('AUTH_EXPIRED', message, {
      detail: 'The credentials have expired. Sign in again.',
      ...options,
    });
  }
}

/** The session store (Valkey) could not be reached: an outage, not a rejection (503, retryable). */
export class AuthSessionStoreUnavailableError extends AppError {
  declare readonly code: 'EXTERNAL_BACKEND_UNAVAILABLE';
  constructor(options: AppErrorOptions = {}) {
    super('EXTERNAL_BACKEND_UNAVAILABLE', 'session store unavailable', {
      detail: 'Session validation is temporarily unavailable. Retry shortly.',
      ...options,
    });
  }
}

/** The IdP's JWKS could not be loaded and nothing is cached. Surfaces as a 401 (fail closed). */
export class JwksUnavailableError extends Error {
  override readonly name = 'JwksUnavailableError';
  constructor(cause: unknown) {
    super('no signing keys are available for the issuer', { cause });
  }
}
