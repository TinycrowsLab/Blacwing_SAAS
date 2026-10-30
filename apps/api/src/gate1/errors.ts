import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** The stable codes the Gate 1 decision API answers with on top of the shared registry (#877). */
export type Gate1ApiErrorCode =
  | 'SOD_VIOLATION'
  | 'GATE1_NOT_PENDING'
  | 'GATE1_PLAN_STALE'
  | 'GATE1_EXPIRED'
  | 'GATE1_PLAN_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_MISMATCH';

/** A refusal of the Gate 1 API, mapped to RFC 9457 problem+json by the route's error handler. */
export class Gate1Error extends AppError {
  declare readonly code: Gate1ApiErrorCode;

  constructor(code: Gate1ApiErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { ...options, detail });
  }
}
