import type { Problem, ProblemFieldError } from '@blackwing/contracts';

/**
 * A non-2xx answer with an RFC 9457 problem body (or a synthesised one when the body is not a problem).
 * Carries no request headers, so a token can never end up in an error message or a log line.
 */
export class ApiProblemError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly code: string;
  readonly traceId: string;
  readonly errors: readonly ProblemFieldError[];

  constructor(problem: Problem) {
    super(`${problem.code}: ${problem.title} (HTTP ${String(problem.status)})`);
    this.name = 'ApiProblemError';
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.code = problem.code;
    this.traceId = problem.traceId;
    this.errors = problem.errors ?? [];
  }
}

/** The request never produced an HTTP answer: DNS, connection, TLS, timeout, or the caller aborted. */
export class ApiNetworkError extends Error {
  readonly kind: 'network' | 'timeout' | 'aborted';

  constructor(kind: 'network' | 'timeout' | 'aborted', cause?: unknown) {
    super(`API request failed: ${kind}`, { cause });
    this.name = 'ApiNetworkError';
    this.kind = kind;
  }
}

/** A 2xx answer whose body is not JSON or does not match the contract (non-prod validation only). */
export class ApiResponseError extends Error {
  readonly operationId: string;
  readonly status: number;
  /** Paths of the failing fields only. Values are never copied into the error. */
  readonly issuePaths: readonly string[];

  constructor(operationId: string, status: number, issuePaths: readonly string[]) {
    super(`${operationId}: response for HTTP ${String(status)} does not match the contract`);
    this.name = 'ApiResponseError';
    this.operationId = operationId;
    this.status = status;
    this.issuePaths = issuePaths;
  }
}
