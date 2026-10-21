import { ERROR_CODES, type ErrorCode, isErrorCode } from './codes.js';

/**
 * Brand shared by every copy of this package that might end up in one process (two installed
 * versions, a bundled worker): `isAppError` recognises an `AppError` even when `instanceof` cannot.
 */
const APP_ERROR_BRAND: unique symbol = Symbol.for('@blackwing/errors.AppError');

/** Options every `AppError` accepts. */
export interface AppErrorOptions {
  /**
   * Client-facing explanation of this occurrence (RFC 9457 `detail`). Write it for the API caller:
   * no secrets, no internals, no stack traces. It is still redacted before it is serialised, and it is
   * withheld for 5xx errors outside development/test.
   */
  readonly detail?: string;
  /** The underlying failure. Kept for server-side logs; never serialised to a client. */
  readonly cause?: unknown;
  /** Overrides the registry default for this occurrence. */
  readonly retryable?: boolean;
}

/** The JSON form of an `AppError` when someone calls `JSON.stringify(err)`: no stack, cause or detail. */
export interface AppErrorJson {
  readonly name: string;
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
}

/**
 * Base of every error Blackwing throws on purpose. `message` is for logs; `detail` is for the client;
 * `code` is the stable machine key; `httpStatus` always equals the registry status for `code`.
 */
export class AppError extends Error {
  /** Stable machine-readable code from the registry. */
  readonly code: ErrorCode;
  /** HTTP status mapped to `code` (never set independently, so the two cannot disagree). */
  readonly httpStatus: number;
  /** Client-facing detail, if any (see {@link AppErrorOptions.detail}). */
  declare readonly detail?: string;
  /** Whether repeating the same request unchanged may succeed. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    // Constructing an error must never throw: an unregistered code (possible only from untyped JS)
    // degrades to INTERNAL instead of crashing the code path that is already failing.
    const safeCode: ErrorCode = isErrorCode(code) ? code : 'INTERNAL';
    const spec = ERROR_CODES[safeCode];
    // `cause` goes through the standard ES2022 option: a non-enumerable own property, so a plain
    // JSON.stringify or object spread never carries it.
    super(message ?? spec.title, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = safeCode;
    this.httpStatus = spec.status;
    this.retryable = options.retryable ?? spec.retryable;
    if (options.detail !== undefined) this.detail = options.detail;
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true, enumerable: false });
  }

  /** Never let a stray `JSON.stringify(err)` put the stack, cause or unredacted detail on the wire. */
  toJSON(): AppErrorJson {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
    };
  }
}

/**
 * Type guard for `AppError`, including instances created by another copy of this package. It also
 * requires `code` to be a registered code, so an instance whose `code` was overwritten at runtime with
 * something unknown is not trusted (the mapper then treats it as `INTERNAL`).
 */
export function isAppError(value: unknown): value is AppError {
  if (!(value instanceof Error)) return false;
  const branded =
    value instanceof AppError ||
    (value as Error & { [APP_ERROR_BRAND]?: unknown })[APP_ERROR_BRAND] === true;
  return branded && isErrorCode((value as { code?: unknown }).code);
}

/** `VALIDATION_FAILED` (422): the input is malformed or breaks a rule. Never retryable unchanged. */
export class ValidationError extends AppError {
  declare readonly code: 'VALIDATION_FAILED';
  constructor(message?: string, options?: AppErrorOptions) {
    super('VALIDATION_FAILED', message, options);
  }
}

/** `UNAUTHENTICATED` (401): no valid credentials (session cookie, PAT or CI token). */
export class AuthError extends AppError {
  declare readonly code: 'UNAUTHENTICATED';
  constructor(message?: string, options?: AppErrorOptions) {
    super('UNAUTHENTICATED', message, options);
  }
}

/** `FORBIDDEN` (403): authenticated, but RBAC or Cedar denies the action. */
export class ForbiddenError extends AppError {
  declare readonly code: 'FORBIDDEN';
  constructor(message?: string, options?: AppErrorOptions) {
    super('FORBIDDEN', message, options);
  }
}

/**
 * `NOT_FOUND` (404): the resource does not exist, or exists in another tenant. The two cases must be
 * indistinguishable to the caller (§8.6), so never put tenant information in `detail`.
 */
export class NotFoundError extends AppError {
  declare readonly code: 'NOT_FOUND';
  constructor(message?: string, options?: AppErrorOptions) {
    super('NOT_FOUND', message, options);
  }
}

/** `CONFLICT` (409): the request conflicts with the current state (duplicate, idempotency-key reuse). */
export class ConflictError extends AppError {
  declare readonly code: 'CONFLICT';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONFLICT', message, options);
  }
}

/** `PRECONDITION_FAILED` (412): an `If-Match` ETag no longer matches (optimistic concurrency, §9). */
export class PreconditionFailedError extends AppError {
  declare readonly code: 'PRECONDITION_FAILED';
  constructor(message?: string, options?: AppErrorOptions) {
    super('PRECONDITION_FAILED', message, options);
  }
}

/** `PRECONDITION_REQUIRED` (428): a mutation arrived without a usable `If-Match` header (§9). */
export class PreconditionRequiredError extends AppError {
  declare readonly code: 'PRECONDITION_REQUIRED';
  constructor(message?: string, options?: AppErrorOptions) {
    super('PRECONDITION_REQUIRED', message, options);
  }
}

/** Options for {@link RateLimitedError}. */
export interface RateLimitedErrorOptions extends AppErrorOptions {
  /** Seconds until the caller may retry; the API sends it as `Retry-After` (§9). */
  readonly retryAfterSeconds?: number;
}

/** `RATE_LIMITED` (429): the per-token rate limit is exhausted. Retryable after `retryAfterSeconds`. */
export class RateLimitedError extends AppError {
  declare readonly code: 'RATE_LIMITED';
  /** Whole seconds until a retry may succeed; absent when unknown. */
  declare readonly retryAfterSeconds?: number;

  constructor(message?: string, options: RateLimitedErrorOptions = {}) {
    super('RATE_LIMITED', message, options);
    const seconds = options.retryAfterSeconds;
    // Constructing an error must never throw, so a nonsensical value is dropped instead of rejected.
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0)
      this.retryAfterSeconds = Math.ceil(seconds);
  }
}

/**
 * `ILLEGAL_RUN_TRANSITION` (409): the run state machine (§3.3) refused a transition. `from` and `to`
 * are state names, which are safe to show the caller.
 */
export class IllegalRunTransitionError extends AppError {
  declare readonly code: 'ILLEGAL_RUN_TRANSITION';
  /** State the run was in. */
  readonly from: string;
  /** State that was requested. */
  readonly to: string;

  constructor(from: string, to: string, options: AppErrorOptions = {}) {
    super('ILLEGAL_RUN_TRANSITION', `Illegal run transition: ${from} -> ${to}`, {
      detail: `A run cannot move from "${from}" to "${to}".`,
      ...options,
    });
    this.from = from;
    this.to = to;
  }
}

/**
 * `TENANT_CONTEXT_MISSING` (500): a tenant-scoped path ran without tenant context. Thrown by
 * `withTenant` and friends to fail closed (§7, §8.6); the request is refused, never served unscoped.
 */
export class TenantContextMissingError extends AppError {
  declare readonly code: 'TENANT_CONTEXT_MISSING';
  constructor(message?: string, options?: AppErrorOptions) {
    super('TENANT_CONTEXT_MISSING', message, options);
  }
}

/** Kill-switch scopes (§8.5). */
export type KillScope = 'run' | 'asset' | 'tenant' | 'global';

/** Options for {@link KillSwitchActiveError}. */
export interface KillSwitchActiveErrorOptions extends AppErrorOptions {
  /** Which kill switch blocked the action. */
  readonly scope?: KillScope;
}

/** `KILL_SWITCH_ACTIVE` (423): a kill switch covers this run, asset, tenant or the whole platform. */
export class KillSwitchActiveError extends AppError {
  declare readonly code: 'KILL_SWITCH_ACTIVE';
  /** Which kill switch blocked the action, when known. */
  declare readonly scope?: KillScope;

  constructor(message?: string, options: KillSwitchActiveErrorOptions = {}) {
    super('KILL_SWITCH_ACTIVE', message, options);
    if (options.scope !== undefined) this.scope = options.scope;
  }
}

/** `SCOPE_VIOLATION` (403): the action targets something outside the authorised scope (SA/envelope). */
export class ScopeViolationError extends AppError {
  declare readonly code: 'SCOPE_VIOLATION';
  constructor(message?: string, options?: AppErrorOptions) {
    super('SCOPE_VIOLATION', message, options);
  }
}

/** `INTERNAL` (500): an unexpected server-side failure. The mapper also wraps every non-`AppError` as this. */
export class InternalError extends AppError {
  declare readonly code: 'INTERNAL';
  constructor(message?: string, options?: AppErrorOptions) {
    super('INTERNAL', message, options);
  }
}
