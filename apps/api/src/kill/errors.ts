import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** The stable codes the kill trigger API answers with (KILL-003 requirement 6, plus §9 idempotency). */
export type KillApiErrorCode =
  | 'KILL_SCOPE_INVALID'
  | 'KILL_REF_REQUIRED'
  | 'KILL_FORBIDDEN'
  | 'KILL_GLOBAL_NOT_ALLOWED_HERE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_MISMATCH';

/** A refusal of the kill trigger API, mapped to RFC 9457 problem+json by the route's error handler. */
export class KillApiError extends AppError {
  declare readonly code: KillApiErrorCode;

  constructor(code: KillApiErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { ...options, detail });
  }
}
