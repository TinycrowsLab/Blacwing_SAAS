// Typed errors for Postgres query failures (DB-007) and the mapping from SQLSTATE codes to them.
//
// The raw `pg.DatabaseError` stays the `cause`, so server-side logs keep the SQLSTATE, and
// `unwrapQueryError` still finds it through Drizzle's wrapper. Callers see the typed error. Only the
// codes below are mapped; any other failure passes through unchanged. Messages are fixed strings: a
// Postgres `detail` can carry row values, so it never reaches a message or a log field.

import { AppError, ConflictError, isAppError, ValidationError } from '@blackwing/errors';

/** Bound on the cause chain walked to find a SQLSTATE (Drizzle wraps once; this allows a little more). */
const CAUSE_DEPTH = 5;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The Postgres error under a query-error wrapper, or the input when there is none. Walks `cause`
 * until it reaches an object carrying a SQLSTATE, so typed errors that wrap a pg error still resolve
 * to the pg error.
 */
export function unwrapQueryError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    const code = (current as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return current;
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) return error;
    current = cause;
  }
  return error;
}

/** `DB_QUERY_TIMEOUT` (504): Postgres cancelled a statement past `DB_STATEMENT_TIMEOUT_MS` (SQLSTATE 57014). */
export class QueryTimeoutError extends AppError {
  declare readonly code: 'DB_QUERY_TIMEOUT';
  constructor(options: { cause?: unknown } = {}) {
    super('DB_QUERY_TIMEOUT', 'database statement exceeded its timeout', {
      detail: 'The request took too long to complete. Try again with a narrower request.',
      ...options,
    });
  }
}

/** `DB_SERIALIZATION_CONFLICT` (409, retryable): a serialization failure or deadlock (40001 / 40P01). */
export class SerializationConflictError extends AppError {
  declare readonly code: 'DB_SERIALIZATION_CONFLICT';
  constructor(options: { cause?: unknown } = {}) {
    super('DB_SERIALIZATION_CONFLICT', 'database serialization conflict', {
      detail: 'A concurrent change conflicted with this request. Try again.',
      ...options,
    });
  }
}

/** `CONFLICT` (409): a unique constraint rejected the row (SQLSTATE 23505). */
export class UniqueViolationError extends ConflictError {
  /** Name of the violated constraint (a schema identifier, safe to expose). */
  readonly constraint: string | undefined;
  constructor(constraint: string | undefined, options: { cause?: unknown } = {}) {
    super('a unique constraint was violated', {
      detail: 'A record with the same unique value already exists.',
      ...options,
    });
    this.name = 'UniqueViolationError';
    this.constraint = constraint;
  }
}

/** A foreign key blocked the operation (deleting a referenced row, or referencing a missing one). */
export class ForeignKeyError extends ConflictError {
  /** Name of the violated constraint (a schema identifier, safe to expose). */
  readonly constraint: string | undefined;
  constructor(entity: string, constraint: string | undefined, options: { cause?: unknown } = {}) {
    super(`${entity} violates a foreign key`, {
      detail: 'The resource is referenced by, or references, another resource.',
      ...options,
    });
    this.name = 'ForeignKeyError';
    this.constraint = constraint;
  }
}

/** `VALIDATION_FAILED` (422): a CHECK constraint rejected the row (SQLSTATE 23514). */
export class CheckViolationError extends ValidationError {
  /** Name of the violated constraint (a schema identifier, safe to expose). */
  readonly constraint: string | undefined;
  constructor(constraint: string | undefined, options: { cause?: unknown } = {}) {
    super('a check constraint was violated', {
      detail: 'The submitted values are outside the allowed range.',
      ...options,
    });
    this.name = 'CheckViolationError';
    this.constraint = constraint;
  }
}

/**
 * Maps a failed query to its typed error, keeping the original as `cause`. Returns `error` unchanged
 * when it is already an `AppError` or its SQLSTATE is not one of the mapped codes.
 */
export function mapDbError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const driver = unwrapQueryError(error) as { code?: unknown; constraint?: unknown } | null;
  const constraint = typeof driver?.constraint === 'string' ? driver.constraint : undefined;
  switch (driver?.code) {
    case '57014':
      return new QueryTimeoutError({ cause: error });
    case '40001':
    case '40P01':
      return new SerializationConflictError({ cause: error });
    case '23505':
      return new UniqueViolationError(constraint, { cause: error });
    case '23503':
      return new ForeignKeyError('record', constraint, { cause: error });
    case '23514':
      return new CheckViolationError(constraint, { cause: error });
    default:
      return error;
  }
}
