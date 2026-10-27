import { problemSchema } from '@blackwing/contracts';

/** Client-side codes (the server's registry codes are snake_case; these are never sent on the wire). */
export const CLIENT_ERROR_CODES = {
  /** The response did not match its Zod contract (or was not JSON). Never coerced. */
  contractMismatch: 'CONTRACT_MISMATCH',
  /** No response: offline, DNS, connection reset or timeout. */
  network: 'NETWORK',
  /** A non-2xx response without a usable problem+json body. */
  http: 'HTTP_ERROR',
} as const;

const HTTP_SERVER_ERROR = 500;
/** Longest `detail` kept for display; anything longer is cut. */
const MAX_DETAIL_LENGTH = 300;
/** Longest `Retry-After` honoured, so a hostile or buggy value cannot freeze the console. */
const MAX_RETRY_AFTER_MS = 60_000;
const MS_PER_SECOND = 1000;

/** Fields of an `ApiError`; `traceId` is what support uses to correlate with server logs. */
export interface ApiErrorInit {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly traceId?: string | undefined;
  /** Milliseconds to wait before retrying, from `Retry-After` (429/503). */
  readonly retryAfterMs?: number | undefined;
  /** Field-level problems of a `422`. */
  readonly fieldErrors?: readonly { path: string; message: string; code: string }[] | undefined;
  /** GraphQL operation name the error came from (no variables, no PII). */
  readonly operation?: string | undefined;
}

/**
 * The one error type every API call throws (RFC 9457 problem+json, CONTEXT_PACK §9). `status` is `0` for
 * errors that never reached the server (`NETWORK`). It carries only fields safe to show; response bodies
 * are never kept.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly traceId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly fieldErrors: ApiErrorInit['fieldErrors'];
  readonly operation: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.traceId = init.traceId;
    this.retryAfterMs = init.retryAfterMs;
    this.fieldErrors = init.fieldErrors;
    this.operation = init.operation;
  }
}

/** The `NETWORK` error of a request that never got a response (offline, DNS, reset or timeout). */
export function toNetworkError(timedOut: boolean): ApiError {
  return new ApiError({
    status: 0,
    code: CLIENT_ERROR_CODES.network,
    title: 'Network error',
    detail: timedOut ? 'The request timed out.' : 'The server could not be reached.',
  });
}

/** Type guard that also works across duplicated module instances. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into a bounded number of milliseconds. */
function parseRetryAfter(header: string | null, now: () => number = Date.now): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * MS_PER_SECOND;
  } else {
    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    ms = date - now();
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

const GENERIC_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Permission denied',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  422: 'Validation failed',
  429: 'Too many requests',
};

function genericTitle(status: number): string {
  return (
    GENERIC_TITLES[status] ?? (status >= HTTP_SERVER_ERROR ? 'Server error' : 'Request failed')
  );
}

function clip(text: string | undefined): string | undefined {
  return text === undefined ? undefined : text.slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Builds the `ApiError` of a non-2xx response. A malformed, empty or non-problem body never throws: it
 * yields a generic problem carrying only the HTTP status. `5xx` details are dropped (server internals are
 * never shown); the raw body is never retained.
 */
export function apiErrorFromResponse(
  status: number,
  bodyText: string,
  retryAfter: string | null,
): ApiError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  let json: unknown;
  try {
    json = bodyText === '' ? undefined : JSON.parse(bodyText);
  } catch {
    json = undefined;
  }
  const problem = problemSchema.safeParse(json);
  if (!problem.success) {
    return new ApiError({
      status,
      code: CLIENT_ERROR_CODES.http,
      title: genericTitle(status),
      retryAfterMs,
    });
  }
  const { title, code, traceId, detail, errors } = problem.data;
  return new ApiError({
    status,
    code,
    title,
    detail: status >= HTTP_SERVER_ERROR ? undefined : clip(detail),
    traceId,
    retryAfterMs,
    fieldErrors: errors,
  });
}
