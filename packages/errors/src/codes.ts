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
  PRECONDITION_REQUIRED: { status: 428, title: 'Precondition required', retryable: false },
  RATE_LIMITED: { status: 429, title: 'Too many requests', retryable: true },
  ILLEGAL_RUN_TRANSITION: { status: 409, title: 'Illegal run state transition', retryable: false },
  // A request that reaches a tenant-scoped path without a resolvable tenant context is refused outright
  // (§7/§8.6 fail closed, TENANT-003): 403, never retried, never served without isolation. A caller with no
  // principal at all is `UNAUTHENTICATED` (401) before this can happen.
  TENANT_CONTEXT_MISSING: { status: 403, title: 'Tenant context missing', retryable: false },
  // A resource whose tenant differs from the context tenant (TENANT-003, §8.6): denied and audited.
  CROSS_TENANT_DENIED: { status: 403, title: 'Cross tenant access denied', retryable: false },
  // withTenant/withSystem (DB-004). Nesting a different tenant context is a programming defect (500,
  // never retried: no silent re-scoping). A transaction that keeps hitting serialization failures or
  // deadlocks is a transient overload (503, retryable).
  TENANT_CONTEXT_CONFLICT: { status: 500, title: 'Tenant context conflict', retryable: false },
  TX_RETRY_EXHAUSTED: { status: 503, title: 'Transaction retries exhausted', retryable: true },
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
  // Persona-definition validation (REGISTRY-001, §4.5/§8.11). Malformed or forbidden definitions are
  // rejected at load/CI time: invalid input (422); a persona that is not registered yet is 404.
  PERSONA_UNKNOWN: { status: 422, title: 'Unknown persona', retryable: false },
  PERSONA_NOT_DEFINED: { status: 404, title: 'Persona not defined', retryable: false },
  PERSONA_FORBIDDEN_TOOL: { status: 422, title: 'Forbidden tool in persona', retryable: false },
  PERSONA_INVALID: { status: 422, title: 'Invalid persona definition', retryable: false },
  // `@blackwing/config` (FOUND-007) refuses to start on an invalid environment: a server fault.
  // Envelope encryption (SECRETS-002, §8.6/§8.7). Every failure fails closed: a tenant/purpose mismatch
  // is a refusal (403); a shredded KEK version is permanent (409).
  AAD_MISMATCH: { status: 403, title: 'Secret context mismatch', retryable: false },
  SECRET_TOO_LARGE: { status: 413, title: 'Secret too large', retryable: false },
  KEK_DISABLED: { status: 409, title: 'Key version disabled', retryable: false },
  ENVELOPE_INVALID: { status: 422, title: 'Invalid secret envelope', retryable: false },
  SECRET_DECRYPT_FAILED: { status: 500, title: 'Secret decryption failed', retryable: false },
  // Prompt registry (REGISTRY-002, §8.9): a prompt that fails its pinned hash is never served.
  PROMPT_INVALID: { status: 422, title: 'Invalid prompt file', retryable: false },
  PROMPT_HASH_MISMATCH: { status: 500, title: 'Prompt hash mismatch', retryable: false },
  PROMPT_NO_RELEASED_VERSION: {
    status: 404,
    title: 'No released prompt version',
    retryable: false,
  },
  PROMPT_DRAFT_FORBIDDEN: {
    status: 403,
    title: 'Draft prompt forbidden in production',
    retryable: false,
  },
  // `secret_ref` URI grammar (SECRETS-003, §8.7): a malformed reference is invalid input, rejected at parse time.
  INVALID_SECRET_REF: { status: 422, title: 'Invalid secret reference', retryable: false },
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
  // PostgreSQL connection (DB-001): no pooled connection within the acquire timeout, or the server is
  // unreachable. A dependency outage (503, retryable); query errors keep their own codes.
  DB_UNAVAILABLE: { status: 503, title: 'Database unavailable', retryable: true },
  // Worker bootstrap (WORKFLOW-002): a misconfigured process refuses to start rather than polling a guess.
  WORKER_QUEUE_UNKNOWN: { status: 500, title: 'Unknown worker task queue', retryable: false },
  // Temporal search attributes (WORKFLOW-003). A registered attribute of another type is never dropped or
  // retyped: the namespace is misconfigured, a server fault (500, never retried until an operator fixes it).
  SEARCH_ATTR_TYPE_CONFLICT: {
    status: 500,
    title: 'Search attribute type conflict',
    retryable: false,
  },
  // Sandbox controller (SANDBOX-001, #448). Its internal API refuses callers without a valid
  // run-scoped token (401, fail closed); a bad body is refused before any processing (400); a bad
  // environment stops the process (500); an unreachable driver or Valkey is an outage (503).
  SBX_UNAUTHENTICATED: { status: 401, title: 'Run token required', retryable: false },
  SBX_BAD_REQUEST: { status: 400, title: 'Malformed request', retryable: false },
  SBX_CONFIG_INVALID: {
    status: 500,
    title: 'Invalid sandbox controller configuration',
    retryable: false,
  },
  SBX_DRIVER_UNAVAILABLE: { status: 503, title: 'Sandbox driver unavailable', retryable: true },
  // DockerDriver (SANDBOX-004): no registered runsc runtime (never fall back to runc); pinned image absent.
  SBX_RUNTIME_MISSING: { status: 500, title: 'Sandbox runtime missing', retryable: false },
  SBX_IMAGE_MISSING: { status: 422, title: 'Sandbox image missing', retryable: false },
  // Kill trigger API (KILL-003, F33/§8.5). Malformed scope input is 422; refusing the caller is 403;
  // `global` is an operator-only path (KILL-013), so the tenant endpoint refuses it with its own code.
  KILL_SCOPE_INVALID: { status: 422, title: 'Invalid kill scope', retryable: false },
  KILL_REF_REQUIRED: { status: 422, title: 'Kill scope reference required', retryable: false },
  KILL_FORBIDDEN: { status: 403, title: 'Kill not permitted', retryable: false },
  KILL_GLOBAL_NOT_ALLOWED_HERE: {
    status: 403,
    title: 'Global kill is not allowed on this endpoint',
    retryable: false,
  },
  // Idempotency-Key handling (§9): a missing key on a creating POST is a malformed request (400);
  // reusing a key with a different body is refused (422) instead of replaying the wrong result.
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency key required', retryable: false },
  IDEMPOTENCY_KEY_MISMATCH: {
    status: 422,
    title: 'Idempotency key reused with a different request',
    retryable: false,
  },
  // Run Broker API (API-014, #66). A stub endpoint owned by a later epic answers 501; a broker write for
  // a run that is no longer active is refused with 409 (the run is terminal, §3.3).
  NOT_IMPLEMENTED: { status: 501, title: 'Not implemented', retryable: false },
  RUN_NOT_ACTIVE: { status: 409, title: 'Run is not active', retryable: false },
  // Audit emission (AUDIT-003, #82): an event that fails AuditEventSchema is refused at the helper's
  // boundary. The producer is at fault, so it is never retried unchanged.
  AUDIT_EVENT_INVALID: { status: 422, title: 'Invalid audit event', retryable: false },
  // Per-tenant KEK (SECRETS-001): OpenBao sealed, unreachable or the AppRole login failed. Fail closed:
  // no shared-key fallback; the caller retries later.
  KEK_UNAVAILABLE: { status: 503, title: 'Tenant key unavailable', retryable: true },
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
