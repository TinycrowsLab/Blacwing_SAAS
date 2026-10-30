// Postgres SQLSTATE → typed AppError mapping (DB-007). Pure functions: no database.

import { describe, expect, it } from 'vitest';

import { ConflictError, isAppError, ValidationError } from '@blackwing/errors';

import {
  CheckViolationError,
  ForeignKeyError,
  mapDbError,
  MemoryEmbedDimMismatchError,
  QueryTimeoutError,
  SerializationConflictError,
  UniqueViolationError,
  unwrapQueryError,
} from './query-errors.js';

const SECRET_VALUE = 'alice-secret@example.test';

/** A pg.DatabaseError-shaped error: SQLSTATE, constraint and a detail that carries row values. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg ${code}`), {
    code,
    constraint,
    detail: `Key (email)=(${SECRET_VALUE}) already exists.`,
  });
}

/** Drizzle's wrapper: the driver error sits in `cause`. */
function drizzleWrapped(error: unknown): Error {
  return Object.assign(new Error('Failed query: insert into widgets'), { cause: error });
}

describe('unwrapQueryError', () => {
  it('finds the SQLSTATE error through typed and Drizzle wrappers', () => {
    const driver = pgError('23505', 'widgets_name_key');
    expect(unwrapQueryError(drizzleWrapped(driver))).toBe(driver);
    expect(unwrapQueryError(drizzleWrapped(mapDbError(driver)))).toBe(driver);
  });

  it('returns the input when no SQLSTATE is reachable', () => {
    const plain = new Error('boom');
    expect(unwrapQueryError(plain)).toBe(plain);
    const node = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const wrapped = drizzleWrapped(node);
    expect(unwrapQueryError(wrapped)).toBe(wrapped);
  });
});

describe('mapDbError', () => {
  it('maps 57014 to QueryTimeoutError (504, not retryable) and keeps the pg error as cause', () => {
    const driver = pgError('57014');
    const mapped = mapDbError(drizzleWrapped(driver));
    expect(mapped).toBeInstanceOf(QueryTimeoutError);
    expect(mapped).toMatchObject({ code: 'DB_QUERY_TIMEOUT', httpStatus: 504, retryable: false });
    expect(unwrapQueryError(mapped)).toBe(driver);
  });

  it.each(['40001', '40P01'])('maps %s to a retryable SerializationConflictError', (code) => {
    const mapped = mapDbError(pgError(code));
    expect(mapped).toBeInstanceOf(SerializationConflictError);
    expect(mapped).toMatchObject({
      code: 'DB_SERIALIZATION_CONFLICT',
      httpStatus: 409,
      retryable: true,
    });
  });

  it('maps 23505 to UniqueViolationError (409) with the constraint name only', () => {
    const mapped = mapDbError(pgError('23505', 'users_email_key'));
    expect(mapped).toBeInstanceOf(UniqueViolationError);
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped).toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      constraint: 'users_email_key',
    });
  });

  it('maps 23503 to the ForeignKeyError (409) with the constraint name only', () => {
    const mapped = mapDbError(pgError('23503', 'memberships_user_fk'));
    expect(mapped).toBeInstanceOf(ForeignKeyError);
    expect(mapped).toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      constraint: 'memberships_user_fk',
    });
  });

  it('maps 23514 to CheckViolationError (422, a validation failure)', () => {
    const mapped = mapDbError(pgError('23514', 'widgets_size_check'));
    expect(mapped).toBeInstanceOf(CheckViolationError);
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped).toMatchObject({
      code: 'VALIDATION_FAILED',
      httpStatus: 422,
      constraint: 'widgets_size_check',
    });
  });

  it('never puts the row values from the pg detail into a message or detail', () => {
    for (const code of ['23505', '23503', '23514', '57014', '40001']) {
      const mapped = mapDbError(pgError(code, 'c')) as Error & { detail?: string };
      expect(mapped.message).not.toContain(SECRET_VALUE);
      expect(mapped.detail ?? '').not.toContain(SECRET_VALUE);
      expect(JSON.stringify(mapped)).not.toContain(SECRET_VALUE);
    }
  });

  it('maps the pgvector length error (22000) to MEMORY_EMBED_DIM_MISMATCH (422), keeping the pg error as cause', () => {
    const cause = Object.assign(new Error('expected 384 dimensions, not 3'), { code: '22000' });
    const mapped = mapDbError(cause);
    expect(mapped).toBeInstanceOf(MemoryEmbedDimMismatchError);
    expect(mapped).toMatchObject({ code: 'MEMORY_EMBED_DIM_MISMATCH', httpStatus: 422 });
    expect((mapped as Error).cause).toBe(cause);
  });

  it('leaves other 22000 data exceptions unmapped', () => {
    const other = Object.assign(new Error('invalid input syntax'), { code: '22000' });
    expect(mapDbError(other)).toBe(other);
  });

  it('passes unmapped SQLSTATEs and non-database errors through unchanged', () => {
    const unmapped = pgError('42501');
    expect(mapDbError(unmapped)).toBe(unmapped);
    const plain = new Error('no code');
    expect(mapDbError(plain)).toBe(plain);
    expect(mapDbError('text')).toBe('text');
  });

  it('leaves an AppError alone instead of wrapping it again', () => {
    const typed = new QueryTimeoutError();
    expect(mapDbError(typed)).toBe(typed);
    expect(isAppError(mapDbError(typed))).toBe(true);
  });
});
