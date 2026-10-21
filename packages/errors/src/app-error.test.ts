import { describe, expect, it } from 'vitest';

import {
  AppError,
  type AppErrorOptions,
  AuthError,
  ConflictError,
  ForbiddenError,
  IllegalRunTransitionError,
  InternalError,
  isAppError,
  KillSwitchActiveError,
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
  RateLimitedError,
  ScopeViolationError,
  TenantContextMissingError,
  ValidationError,
} from './app-error.js';
import { ERROR_CODE_LIST, ERROR_CODES, type ErrorCode } from './codes.js';

type Factory = (options?: AppErrorOptions) => AppError;

/** One subclass per registered code, with how to build it. */
const SUBCLASSES: readonly (readonly [
  string,
  ErrorCode,
  Factory,
  new (...args: never[]) => AppError,
])[] = [
  [
    'ValidationError',
    'VALIDATION_FAILED',
    (o) => new ValidationError('bad input', o),
    ValidationError,
  ],
  ['AuthError', 'UNAUTHENTICATED', (o) => new AuthError('no session', o), AuthError],
  ['ForbiddenError', 'FORBIDDEN', (o) => new ForbiddenError('denied', o), ForbiddenError],
  ['NotFoundError', 'NOT_FOUND', (o) => new NotFoundError('missing', o), NotFoundError],
  ['ConflictError', 'CONFLICT', (o) => new ConflictError('duplicate', o), ConflictError],
  [
    'PreconditionFailedError',
    'PRECONDITION_FAILED',
    (o) => new PreconditionFailedError('etag', o),
    PreconditionFailedError,
  ],
  [
    'PreconditionRequiredError',
    'PRECONDITION_REQUIRED',
    (o) => new PreconditionRequiredError('if-match', o),
    PreconditionRequiredError,
  ],
  [
    'RateLimitedError',
    'RATE_LIMITED',
    (o) => new RateLimitedError('slow down', o),
    RateLimitedError,
  ],
  [
    'IllegalRunTransitionError',
    'ILLEGAL_RUN_TRANSITION',
    (o) => new IllegalRunTransitionError('completed', 'running', o),
    IllegalRunTransitionError,
  ],
  [
    'TenantContextMissingError',
    'TENANT_CONTEXT_MISSING',
    (o) => new TenantContextMissingError('no tenant', o),
    TenantContextMissingError,
  ],
  [
    'KillSwitchActiveError',
    'KILL_SWITCH_ACTIVE',
    (o) => new KillSwitchActiveError('killed', o),
    KillSwitchActiveError,
  ],
  [
    'ScopeViolationError',
    'SCOPE_VIOLATION',
    (o) => new ScopeViolationError('out of scope', o),
    ScopeViolationError,
  ],
  ['InternalError', 'INTERNAL', (o) => new InternalError('boom', o), InternalError],
];

/** Codes whose subclass lives in the package that owns the failure, not here. */
const SUBCLASSED_ELSEWHERE: readonly ErrorCode[] = [
  'CONFIG_INVALID', // ConfigValidationError, @blackwing/config
  // TxRetryExhaustedError and TenantContextMismatchError, @blackwing/db (DB-004).
  'TX_RETRY_EXHAUSTED',
  'TENANT_CONTEXT_CONFLICT',
  // PersonaError, @blackwing/agents (REGISTRY-001).
  'PERSONA_UNKNOWN',
  'PERSONA_NOT_DEFINED',
  'PERSONA_FORBIDDEN_TOOL',
  'PERSONA_INVALID',
  // PromptError, @blackwing/agents (REGISTRY-002).
  'PROMPT_INVALID',
  'PROMPT_HASH_MISMATCH',
  'PROMPT_NO_RELEASED_VERSION',
  'PROMPT_DRAFT_FORBIDDEN',
  // IntrusivenessError, @blackwing/contracts (SCOPE-003): contracts is the root of the dependency
  // graph and cannot import this package, so its error carries the registered code instead.
  'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING',
  'SCOPE_DESTRUCTIVE_FORBIDDEN',
  'SCOPE_INVALID_CLASS',
  // BudgetError, @blackwing/contracts (SCOPE-004), for the same reason.
  'SCOPE_INVALID_BUDGET',
  'SCOPE_BUDGET_EXCEEDS_SA',
  // ScopeRuleError, @blackwing/contracts (SCOPE-002), for the same reason.
  'SCOPE_INVALID_RULE',
  // Raised by @blackwing/workflow-shared as plain AppErrors (WORKFLOW-001).
  'TEMPORAL_CONFIG_INVALID',
  'TEMPORAL_TLS_MISCONFIGURED',
  'TEMPORAL_NAMESPACE_NOT_FOUND',
  'TEMPORAL_UNAVAILABLE',
  // DbUnavailableError, @blackwing/db (DB-001).
  'DB_UNAVAILABLE',
  // Raised by apps/worker as a plain AppError (WORKFLOW-002).
  'WORKER_QUEUE_UNKNOWN',
  // Subclassed by apps/sandbox-controller (SANDBOX-001).
  'SBX_UNAUTHENTICATED',
  'SBX_BAD_REQUEST',
  'SBX_CONFIG_INVALID',
  'SBX_DRIVER_UNAVAILABLE',
  'SBX_RUNTIME_MISSING',
  'SBX_IMAGE_MISSING',
  // Raised by apps/api's kill module (KILL-003) as KillApiError / IdempotencyError.
  'KILL_SCOPE_INVALID',
  'KILL_REF_REQUIRED',
  'KILL_FORBIDDEN',
  'KILL_GLOBAL_NOT_ALLOWED_HERE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_MISMATCH',
  // Raised by apps/api's Run Broker (API-014) as plain AppErrors.
  'NOT_IMPLEMENTED',
  'RUN_NOT_ACTIVE',
];

describe('AppError subclasses', () => {
  it('cover every registered code (except those subclassed by their owning package)', () => {
    expect([...SUBCLASSES.map(([, code]) => code), ...SUBCLASSED_ELSEWHERE].sort()).toEqual(
      [...ERROR_CODE_LIST].sort(),
    );
  });

  it.each(SUBCLASSES)('%s carries code %s and the registry status', (name, code, make, ctor) => {
    const error = make();
    expect(error).toBeInstanceOf(ctor);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(ERROR_CODES[code].status);
    expect(error.retryable).toBe(ERROR_CODES[code].retryable);
    expect(typeof error.stack).toBe('string');
  });

  it.each(SUBCLASSES)(
    '%s keeps its cause internal: non-enumerable and absent from JSON',
    (_name, _code, make) => {
      const cause = new Error('db password=hunter2');
      const error = make({ cause, detail: 'client detail' });
      expect(error.cause).toBe(cause);
      expect(Object.keys(error)).not.toContain('cause');
      const json = JSON.stringify(error);
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('client detail');
      expect(json).not.toContain('stack');
      expect(JSON.parse(json)).toEqual({
        name: error.name,
        code: error.code,
        httpStatus: error.httpStatus,
        retryable: error.retryable,
      });
      expect(Object.fromEntries(Object.entries(error))).not.toHaveProperty('cause');
    },
  );

  it('uses the registry title as the default message', () => {
    expect(new NotFoundError().message).toBe('Resource not found');
    expect(new AppError('FORBIDDEN').message).toBe('Forbidden');
  });

  it('only sets detail when given, and keeps an explicit undefined cause', () => {
    const plain = new ConflictError('dup');
    expect(plain.detail).toBeUndefined();
    expect(Object.hasOwn(plain, 'detail')).toBe(false);
    expect(Object.hasOwn(plain, 'cause')).toBe(false);
    const withDetail = new ConflictError('dup', {
      detail: 'That name is taken.',
      cause: undefined,
    });
    expect(withDetail.detail).toBe('That name is taken.');
    expect(Object.hasOwn(withDetail, 'cause')).toBe(true);
  });

  it('allows retryable to be overridden per occurrence', () => {
    expect(new ConflictError('lock', { retryable: true }).retryable).toBe(true);
    expect(new RateLimitedError('cap', { retryable: false }).retryable).toBe(false);
  });

  it('degrades an unregistered code from untyped callers to INTERNAL instead of throwing', () => {
    const error = new AppError('NOT_A_CODE' as ErrorCode, 'x');
    expect(error.code).toBe('INTERNAL');
    expect(error.httpStatus).toBe(500);
  });

  it('supports subclassing for per-domain errors, with the subclass name', () => {
    class AssetNotVerifiedError extends ForbiddenError {}
    const error = new AssetNotVerifiedError('asset not verified');
    expect(error.name).toBe('AssetNotVerifiedError');
    expect(error.code).toBe('FORBIDDEN');
    expect(isAppError(error)).toBe(true);
  });
});

describe('specialised subclasses', () => {
  it('IllegalRunTransitionError records both states and a safe default detail', () => {
    const error = new IllegalRunTransitionError('completed', 'running');
    expect(error.from).toBe('completed');
    expect(error.to).toBe('running');
    expect(error.message).toBe('Illegal run transition: completed -> running');
    expect(error.detail).toBe('A run cannot move from "completed" to "running".');
    expect(error.httpStatus).toBe(409);
    expect(new IllegalRunTransitionError('a', 'b', { detail: 'custom' }).detail).toBe('custom');
  });

  it('RateLimitedError rounds retryAfterSeconds up and drops nonsense values', () => {
    expect(new RateLimitedError('x', { retryAfterSeconds: 1.2 }).retryAfterSeconds).toBe(2);
    expect(new RateLimitedError('x', { retryAfterSeconds: 0 }).retryAfterSeconds).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = new RateLimitedError('x', { retryAfterSeconds: bad });
      expect(error.retryAfterSeconds).toBeUndefined();
      expect(Object.hasOwn(error, 'retryAfterSeconds')).toBe(false);
    }
    expect(new RateLimitedError().retryable).toBe(true);
  });

  it('KillSwitchActiveError records the kill scope when known', () => {
    expect(new KillSwitchActiveError('x', { scope: 'tenant' }).scope).toBe('tenant');
    expect(new KillSwitchActiveError('x').scope).toBeUndefined();
    expect(new KillSwitchActiveError().httpStatus).toBe(423);
  });

  it('TenantContextMissingError fails closed: 500 and never retryable', () => {
    const error = new TenantContextMissingError();
    expect(error.httpStatus).toBe(500);
    expect(error.retryable).toBe(false);
  });

  it('TenantContextMissingError carries a frozen meta.reason (default "missing")', () => {
    expect(new TenantContextMissingError().meta).toEqual({ reason: 'missing' });
    const invalid = new TenantContextMissingError('bad id', { reason: 'invalid_uuid' });
    expect(invalid.meta).toEqual({ reason: 'invalid_uuid' });
    expect(Object.isFrozen(invalid.meta)).toBe(true);
    expect(invalid.code).toBe('TENANT_CONTEXT_MISSING');
  });
});

describe('isAppError', () => {
  it('rejects plain errors and non-errors', () => {
    for (const value of [
      new Error('x'),
      new TypeError('x'),
      'NOT_FOUND',
      null,
      undefined,
      42,
      {},
      { code: 'NOT_FOUND', httpStatus: 404 },
    ]) {
      expect(isAppError(value)).toBe(false);
    }
  });

  it('accepts an instance from another copy of the package (shared global brand)', () => {
    const foreign = Object.assign(new Error('other copy'), {
      code: 'NOT_FOUND',
      httpStatus: 404,
      retryable: false,
    });
    Object.defineProperty(foreign, Symbol.for('@blackwing/errors.AppError'), { value: true });
    expect(isAppError(foreign)).toBe(true);
  });

  it('rejects a branded error or an instance whose code is not registered', () => {
    const foreign = Object.assign(new Error('other copy'), { code: 'toString' });
    Object.defineProperty(foreign, Symbol.for('@blackwing/errors.AppError'), { value: true });
    expect(isAppError(foreign)).toBe(false);

    const tampered = new NotFoundError('x');
    Object.defineProperty(tampered, 'code', { value: 'BOGUS' });
    expect(isAppError(tampered)).toBe(false);
  });
});
