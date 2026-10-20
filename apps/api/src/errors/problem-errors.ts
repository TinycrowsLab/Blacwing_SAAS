import { type AppErrorOptions, ValidationError } from '@blackwing/errors';

import type { ProblemFieldError } from '@blackwing/contracts';

/** Options of {@link FieldValidationError}. */
export interface FieldValidationErrorOptions extends AppErrorOptions {
  /** Field-level problems rendered as `errors[]` in the problem body. */
  readonly errors: readonly ProblemFieldError[];
}

/** A `ValidationError` (422 `validation_failed`) that carries per-field problems (API-002/003). */
export class FieldValidationError extends ValidationError {
  readonly errors: readonly ProblemFieldError[];

  constructor(message: string | undefined, options: FieldValidationErrorOptions) {
    super(message, options);
    this.errors = options.errors;
  }
}

/** Options of {@link ApiProblemError}. */
export interface ApiProblemErrorOptions {
  readonly detail?: string;
  readonly cause?: unknown;
  /** Whole seconds, sent as `Retry-After` (meaningful for 429/503). */
  readonly retryAfterSeconds?: number;
}

/**
 * An error for a wire code that exists only at the HTTP layer (`precondition_required`,
 * `idempotency_conflict`, or a module's own registered code). The code must be registered in the
 * problem registry; an unregistered one renders as `internal_error`.
 */
export class ApiProblemError extends Error {
  readonly problemCode: string;
  readonly detail?: string;
  readonly retryAfterSeconds?: number;

  constructor(problemCode: string, message?: string, options: ApiProblemErrorOptions = {}) {
    super(message ?? problemCode, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'ApiProblemError';
    this.problemCode = problemCode;
    if (options.detail !== undefined) this.detail = options.detail;
    const seconds = options.retryAfterSeconds;
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0)
      this.retryAfterSeconds = Math.ceil(seconds);
  }
}
