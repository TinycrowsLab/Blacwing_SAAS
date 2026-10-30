import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** Stable codes the session manager answers with (registered in `@blackwing/errors`). */
export const SM_ERROR_CODES = [
  'SM_UNAUTHENTICATED',
  'SM_TENANT_MISMATCH',
  'SM_BAD_REQUEST',
  'SM_CONFIG_INVALID',
  'SM_RECIPE_INVALID',
  'SM_LOGIN_FAILED',
  'SM_LOCKED_OUT',
  'SM_SESSION_EXPIRED',
] as const;
export type SmErrorCode = (typeof SM_ERROR_CODES)[number];

/**
 * Why a bearer token was refused. Bounded and value-free: it is logged and counted, but never sent to the
 * caller (the 401 body is identical for every reason, so it cannot be used as an oracle).
 */
export type AuthFailureReason =
  | 'missing'
  | 'not_bearer'
  | 'wrong_prefix'
  | 'too_long'
  | 'malformed'
  | 'bad_signature'
  | 'bad_claims'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid';

/** 401: no valid session-manager token. Fail closed: nothing behind the hook runs. */
export class SmUnauthenticatedError extends AppError {
  readonly reason: AuthFailureReason;

  constructor(reason: AuthFailureReason, options: AppErrorOptions = {}) {
    super('SM_UNAUTHENTICATED', `service token rejected: ${reason}`, {
      detail: 'A valid run-scoped or control-plane bearer token is required.',
      ...options,
    });
    this.reason = reason;
  }
}

/** 403: the token is valid but names another tenant or run than the route it calls. */
export class SmTenantMismatchError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super('SM_TENANT_MISMATCH', 'token scope does not match the requested tenant or run', {
      detail: 'The token is not valid for this tenant or run.',
      ...options,
    });
  }
}

/** 400: the body is malformed or too large; it is refused before any handler runs. */
export class SmBadRequestError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super('SM_BAD_REQUEST', detail, { detail, ...options });
  }
}

/** Invalid environment at boot. The process exits non-zero before binding any socket. */
export class SmConfigInvalidError extends AppError {
  /** Offending environment keys (names only, never values). */
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[], options: AppErrorOptions = {}) {
    super('SM_CONFIG_INVALID', message, options);
    this.keys = Object.freeze([...keys]);
  }
}

/** 422: a login recipe fails validation (SESSION-005..008 wire the engine; declared here for stable codes). */
export class SmRecipeInvalidError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SM_RECIPE_INVALID', message, options);
  }
}

/** 422: the target rejected the login. */
export class SmLoginFailedError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SM_LOGIN_FAILED', message, options);
  }
}

/** 423: the role is locked out by the lockout guard; retry after the lock window. */
export class SmLockedOutError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SM_LOCKED_OUT', message, { retryable: true, ...options });
  }
}

/** 401: the stored session is past its validity window and must be re-established. */
export class SmSessionExpiredError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SM_SESSION_EXPIRED', message, options);
  }
}
