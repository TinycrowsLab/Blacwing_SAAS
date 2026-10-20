import { ValidationError } from '@blackwing/errors';

/** Where in the request the rejected input came from. */
export type ValidationSource = 'body' | 'query' | 'params' | 'headers';

/** One machine-readable validation problem. Carries a field path and a rule, never the input value. */
export interface ValidationIssueDetail {
  /** Field path, `a.b[0].c`; empty string for the root value. */
  readonly path: string;
  /** Human-readable rule that was broken (Zod's message; it never echoes the submitted value). */
  readonly message: string;
  /** Zod issue code (`invalid_type`, `too_big`, `unrecognized_keys`, ...) or `json_depth_exceeded`. */
  readonly code: string;
}

/** Upper bound on reported issues, so a hostile payload cannot make the error response huge. */
export const MAX_REPORTED_ISSUES = 100;

/**
 * `VALIDATION_FAILED` (422) for a request that broke its Zod contract. The exception filter (API-004)
 * maps it to problem+json and exposes {@link RequestValidationError.errors} as the `errors` extension.
 */
export class RequestValidationError extends ValidationError {
  readonly source: ValidationSource;
  readonly errors: readonly ValidationIssueDetail[];

  constructor(source: ValidationSource, errors: readonly ValidationIssueDetail[], cause?: unknown) {
    super(`Request ${source} failed validation`, {
      detail: `The request ${source} is invalid (${String(errors.length)} problem${errors.length === 1 ? '' : 's'}); see errors.`,
      ...(cause === undefined ? {} : { cause }),
    });
    this.source = source;
    this.errors = errors.slice(0, MAX_REPORTED_ISSUES);
  }
}
