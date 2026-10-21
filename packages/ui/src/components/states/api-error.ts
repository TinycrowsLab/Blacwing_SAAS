/**
 * Display model for a failed API call. Structural on purpose: it matches the RFC 9457 problem+json
 * fields the console data layer (CONSOLE-005) raises (`status`, `code`, `traceId`, `detail`) without
 * importing it, so the UI kit stays a leaf package. Only these fields are ever rendered.
 */
export interface ApiErrorLike {
  /** HTTP status of the failed response (0 or absent for a network failure). */
  readonly status?: number | undefined;
  /** Stable machine code such as `RUN_NOT_ACTIVE`. */
  readonly code?: string | undefined;
  /** Correlation id for support flows. */
  readonly traceId?: string | undefined;
  /** Server detail; sanitised and truncated before it is shown. */
  readonly detail?: string | undefined;
}

export type ApiErrorKind =
  | 'permission-denied'
  | 'not-found'
  | 'unauthenticated'
  | 'rate-limited'
  | 'server'
  | 'client'
  | 'network';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;

/** Classifies an error so empty, error and permission-denied are never confused (never "no data" for a 403 or 500). */
export function classifyApiError(error: ApiErrorLike): ApiErrorKind {
  const status = error.status ?? 0;
  if (status === HTTP_FORBIDDEN) return 'permission-denied';
  if (status === HTTP_NOT_FOUND) return 'not-found';
  if (status === HTTP_UNAUTHORIZED) return 'unauthenticated';
  if (status === HTTP_TOO_MANY_REQUESTS) return 'rate-limited';
  if (status >= HTTP_SERVER_ERROR) return 'server';
  if (status >= HTTP_CLIENT_ERROR) return 'client';
  return 'network';
}

const COPY: Record<ApiErrorKind, { title: string; description: string }> = {
  'permission-denied': {
    title: 'You do not have access',
    description: 'Your role does not include the permission this view needs.',
  },
  'not-found': {
    title: 'We could not find that',
    description: 'It may have been removed, or you may not have access to it.',
  },
  unauthenticated: {
    title: 'Your session has ended',
    description: 'Sign in again to continue.',
  },
  'rate-limited': {
    title: 'Too many requests',
    description: 'Wait a moment before trying again.',
  },
  server: {
    title: 'Something went wrong on our side',
    description: 'The request failed. Try again, and share the trace ID if it keeps happening.',
  },
  client: {
    title: 'The request could not be completed',
    description: 'Check the details and try again.',
  },
  network: {
    title: 'We could not reach the server',
    description: 'Check your connection and try again.',
  },
};

/** Friendly, fixed copy per error kind. Never derived from server text. */
export function errorCopy(kind: ApiErrorKind): { title: string; description: string } {
  return COPY[kind];
}

const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const TRACE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Returns `code` only when it is a short machine token; anything else is dropped. */
export function safeCode(code: string | undefined): string | undefined {
  return code !== undefined && CODE_PATTERN.test(code) ? code : undefined;
}

/** Returns `traceId` only when it is a short id token; anything else is dropped. */
export function safeTraceId(traceId: string | undefined): string | undefined {
  return traceId !== undefined && TRACE_ID_PATTERN.test(traceId) ? traceId : undefined;
}

/** Maximum characters of `detail` ever rendered, even when expanded. */
export const MAX_DETAIL_CHARS = 1000;
/** Input is cut to this many multiples of the cap before line filtering, bounding work on huge payloads. */
const INPUT_SLACK_FACTOR = 4;

const STACK_FRAME = /^\s*at\s+\S|\S@\S+:\d+:\d+\s*$|:\d+:\d+\)?\s*$/;
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    '[REDACTED]',
  ],
  [/\b(?:bwk|bw_pat|bw_ci|bw_run)_[A-Za-z0-9_.-]+/g, '[REDACTED]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@'],
  [/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, '[REDACTED]'],
];

/**
 * Prepares server `detail` for display: drops stack-trace lines, redacts credentials and email
 * addresses, and caps the length. Returns `undefined` when nothing safe remains.
 */
export function sanitizeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const kept = detail
    .slice(0, MAX_DETAIL_CHARS * INPUT_SLACK_FACTOR)
    .split(/\r?\n/)
    .filter((line) => !STACK_FRAME.test(line))
    .join('\n');
  let result = kept;
  for (const [pattern, replacement] of SECRET_RULES) result = result.replace(pattern, replacement);
  result = result.trim();
  if (result.length === 0) return undefined;
  return result.length > MAX_DETAIL_CHARS ? `${result.slice(0, MAX_DETAIL_CHARS)}…` : result;
}
