import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** Stable codes the sandbox controller answers with (registered in `@blackwing/errors`). */
export const SBX_ERROR_CODES = [
  'SBX_UNAUTHENTICATED',
  'SBX_BAD_REQUEST',
  'SBX_CONFIG_INVALID',
  'SBX_DRIVER_UNAVAILABLE',
  'SBX_RUNTIME_MISSING',
  'SBX_IMAGE_MISSING',
] as const;
export type SbxErrorCode = (typeof SBX_ERROR_CODES)[number];

/**
 * Why a run-scoped token was refused. Bounded and value-free: it is logged and counted, but never sent to
 * the caller (the 401 body is identical for every reason, so it cannot be used as an oracle).
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

/** 401: no valid `bw_run_` token. Fail closed: nothing behind the hook runs. */
export class SbxUnauthenticatedError extends AppError {
  readonly reason: AuthFailureReason;

  constructor(reason: AuthFailureReason, options: AppErrorOptions = {}) {
    super('SBX_UNAUTHENTICATED', `run-scoped token rejected: ${reason}`, {
      detail: 'A valid run-scoped bearer token is required.',
      ...options,
    });
    this.reason = reason;
  }
}

/** 400: the body is malformed or too large; it is refused before any handler runs. */
export class SbxBadRequestError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super('SBX_BAD_REQUEST', detail, { detail, ...options });
  }
}

/** Invalid environment at boot. The process exits non-zero before binding any socket. */
export class SbxConfigInvalidError extends AppError {
  /** Offending environment keys (names only, never values). */
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[], options: AppErrorOptions = {}) {
    super('SBX_CONFIG_INVALID', message, options);
    this.keys = Object.freeze([...keys]);
  }
}

/** 503: the sandbox driver cannot be reached (or is not available in this build). */
export class SbxDriverUnavailableError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_DRIVER_UNAVAILABLE', message, options);
  }
}

/** 500: the daemon has no `runsc` runtime. Never falls back to `runc` (§1.1); fail fast. */
export class SbxRuntimeMissingError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_RUNTIME_MISSING', message, options);
  }
}

/** 422: the digest-pinned image is not present locally and pulling is disabled. */
export class SbxImageMissingError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_IMAGE_MISSING', message, options);
  }
}
