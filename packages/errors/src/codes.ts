/**
 * The error-code registry: the single source of truth for every stable `code`, its HTTP status,
 * its English (v1) problem title and whether the failure is worth retrying unchanged.
 *
 * The `ErrorCode` union, the status mapper and the problem+json `type` URI are all derived from this
 * one object, so a code cannot exist without a status and a title. Codes are public API: they appear
 * in problem+json bodies, audit events and client code. Never rename or reuse one; add a new code
 * instead. Each epic adds its domain-specific `AppError` subclasses on top of these codes.
 */

/** What the registry records for one code. */
export interface ErrorCodeSpec {
  /** HTTP status the API answers with. */
  readonly status: number;
  /** Short, human-readable summary of the problem type (RFC 9457 `title`). English in v1. */
  readonly title: string;
  /** Default for `AppError.retryable`: may the same request succeed if repeated unchanged later? */
  readonly retryable: boolean;
}

const DEFINITIONS = {
  VALIDATION_FAILED: { status: 422, title: 'Validation failed', retryable: false },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required', retryable: false },
  FORBIDDEN: { status: 403, title: 'Forbidden', retryable: false },
  NOT_FOUND: { status: 404, title: 'Resource not found', retryable: false },
  CONFLICT: { status: 409, title: 'Conflict', retryable: false },
  PRECONDITION_FAILED: { status: 412, title: 'Precondition failed', retryable: false },
  RATE_LIMITED: { status: 429, title: 'Too many requests', retryable: true },
  ILLEGAL_RUN_TRANSITION: { status: 409, title: 'Illegal run state transition', retryable: false },
  // A request that reaches a tenant-scoped path without tenant context is a server defect, and it is
  // refused outright (§7/§8.6 fail closed): 500, never retried, never served without isolation.
  TENANT_CONTEXT_MISSING: { status: 500, title: 'Tenant context missing', retryable: false },
  KILL_SWITCH_ACTIVE: { status: 423, title: 'Kill switch active', retryable: false },
  SCOPE_VIOLATION: { status: 403, title: 'Out of authorised scope', retryable: false },
  // Intrusiveness-class validation (SCOPE-003, §3.5/§8.3). Exceeding a ceiling or naming
  // `destructive` as a ceiling is a refusal of an authorised-scope boundary (403); an unknown class
  // string is malformed input (422).
  SCOPE_INTRUSIVENESS_EXCEEDS_CEILING: {
    status: 403,
    title: 'Intrusiveness exceeds the authorised ceiling',
    retryable: false,
  },
  SCOPE_DESTRUCTIVE_FORBIDDEN: {
    status: 403,
    title: 'Destructive intrusiveness is forbidden',
    retryable: false,
  },
  SCOPE_INVALID_CLASS: { status: 422, title: 'Invalid intrusiveness class', retryable: false },
  // Request-budget validation (SCOPE-004, F5). A malformed or absurd budget is invalid input (422);
  // a budget above the standing authorisation's defaults is an authorised-scope refusal (403).
  SCOPE_INVALID_BUDGET: { status: 422, title: 'Invalid request budget', retryable: false },
  // Malformed scope rule (SCOPE-002, #566): invalid input, rejected at parse time.
  SCOPE_INVALID_RULE: { status: 422, title: 'Invalid scope rule', retryable: false },
  SCOPE_BUDGET_EXCEEDS_SA: {
    status: 403,
    title: 'Budget exceeds the standing authorisation',
    retryable: false,
  },
  // `@blackwing/config` (FOUND-007) refuses to start on an invalid environment: a server fault.
  CONFIG_INVALID: { status: 500, title: 'Invalid configuration', retryable: false },
  // Temporal connection (WORKFLOW-001). Misconfiguration is a server fault (500, never retried);
  // an unreachable server is a dependency outage (503, retryable).
  TEMPORAL_CONFIG_INVALID: {
    status: 500,
    title: 'Invalid Temporal configuration',
    retryable: false,
  },
  TEMPORAL_TLS_MISCONFIGURED: {
    status: 500,
    title: 'Temporal TLS misconfigured',
    retryable: false,
  },
  TEMPORAL_NAMESPACE_NOT_FOUND: {
    status: 500,
    title: 'Temporal namespace not found',
    retryable: false,
  },
  TEMPORAL_UNAVAILABLE: { status: 503, title: 'Temporal unavailable', retryable: true },
  // Worker bootstrap (WORKFLOW-002): a misconfigured process refuses to start rather than polling a guess.
  WORKER_QUEUE_UNKNOWN: { status: 500, title: 'Unknown worker task queue', retryable: false },
  INTERNAL: { status: 500, title: 'Internal server error', retryable: false },
} as const satisfies Record<string, ErrorCodeSpec>;

/** Every stable machine-readable error code. */
export type ErrorCode = keyof typeof DEFINITIONS;

/** HTTP status for a given code, as a literal type (`HttpStatusOf<"NOT_FOUND">` is `404`). */
export type HttpStatusOf<C extends ErrorCode> = (typeof DEFINITIONS)[C]['status'];

function freezeRegistry<T extends Record<string, ErrorCodeSpec>>(registry: T): Readonly<T> {
  for (const spec of Object.values(registry)) Object.freeze(spec);
  return Object.freeze(registry);
}

/** The frozen registry: `ERROR_CODES.NOT_FOUND.status === 404`. */
export const ERROR_CODES: Readonly<typeof DEFINITIONS> = freezeRegistry(DEFINITIONS);

/** Every code, in registry order. */
export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_CODES) as ErrorCode[],
);

/** Base of every problem `type` URI. The code is appended verbatim. */
export const PROBLEM_TYPE_BASE = 'https://errors.blackwing.dev/';

/** Type guard: is `value` a registered code? Uses own properties only (never the prototype chain). */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

/** The HTTP status mapped to `code`. */
export function httpStatusFor<C extends ErrorCode>(code: C): HttpStatusOf<C> {
  return ERROR_CODES[code].status;
}

/** The problem+json `type` URI for `code`: `https://errors.blackwing.dev/<code>`. */
export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}
