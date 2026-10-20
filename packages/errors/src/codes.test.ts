import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ERROR_CODE_LIST,
  ERROR_CODES,
  type ErrorCode,
  httpStatusFor,
  type HttpStatusOf,
  isErrorCode,
  PROBLEM_TYPE_BASE,
  problemTypeFor,
} from './codes.js';

/**
 * The registry as FOUND-009 (detailed requirement 2) specifies it. This table is written out by hand
 * on purpose: it is the contract, and the registry must match it exactly.
 */
const EXPECTED_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  ILLEGAL_RUN_TRANSITION: 409,
  TENANT_CONTEXT_MISSING: 500,
  KILL_SWITCH_ACTIVE: 423,
  SCOPE_VIOLATION: 403,
  SCOPE_INTRUSIVENESS_EXCEEDS_CEILING: 403,
  SCOPE_DESTRUCTIVE_FORBIDDEN: 403,
  SCOPE_INVALID_CLASS: 422,
  SCOPE_INVALID_BUDGET: 422,
  SCOPE_BUDGET_EXCEEDS_SA: 403,
  CONFIG_INVALID: 500,
  INTERNAL: 500,
};

describe('error-code registry', () => {
  it.each(Object.entries(EXPECTED_STATUS))('maps %s to HTTP %i', (code, status) => {
    expect(isErrorCode(code)).toBe(true);
    if (!isErrorCode(code)) return;
    expect(ERROR_CODES[code].status).toBe(status);
    expect(httpStatusFor(code)).toBe(status);
  });

  it('is exhaustive: every registered code is in the table and every table entry is registered', () => {
    expect([...ERROR_CODE_LIST].sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
    expect(ERROR_CODE_LIST).toHaveLength(18);
  });

  it('has unique codes, unique problem type URIs and stable SCREAMING_SNAKE_CASE keys', () => {
    expect(new Set(ERROR_CODE_LIST).size).toBe(ERROR_CODE_LIST.length);
    expect(new Set(ERROR_CODE_LIST.map((code) => problemTypeFor(code))).size).toBe(
      ERROR_CODE_LIST.length,
    );
    for (const code of ERROR_CODE_LIST) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  });

  it('gives every code an error status, a non-empty English title and a retry default', () => {
    for (const code of ERROR_CODE_LIST) {
      const spec = ERROR_CODES[code];
      expect(Number.isInteger(spec.status)).toBe(true);
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.status).toBeLessThanOrEqual(599);
      expect(spec.title).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(typeof spec.retryable).toBe('boolean');
    }
    expect(new Set(ERROR_CODE_LIST.map((code) => ERROR_CODES[code].title)).size).toBe(
      ERROR_CODE_LIST.length,
    );
  });

  it('marks only RATE_LIMITED as retryable by default', () => {
    expect(ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].retryable)).toEqual(['RATE_LIMITED']);
  });

  it('fails closed on a missing tenant context: 500 and not retryable', () => {
    expect(ERROR_CODES.TENANT_CONTEXT_MISSING).toEqual({
      status: 500,
      title: 'Tenant context missing',
      retryable: false,
    });
  });

  it('is frozen at every level', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODE_LIST)).toBe(true);
    for (const code of ERROR_CODE_LIST) expect(Object.isFrozen(ERROR_CODES[code])).toBe(true);
    // ES modules run in strict mode, so writes to frozen objects throw instead of failing silently.
    expect(() => {
      (ERROR_CODES as unknown as Record<string, unknown>).NEW_CODE = {
        status: 200,
        title: 'OK',
        retryable: false,
      };
    }).toThrow(TypeError);
    expect(() => {
      (ERROR_CODES.NOT_FOUND as { status: number }).status = 200;
    }).toThrow(TypeError);
    expect(() => {
      (ERROR_CODE_LIST as ErrorCode[]).push('INTERNAL');
    }).toThrow(TypeError);
    expect(ERROR_CODES.NOT_FOUND.status).toBe(404);
  });

  it('builds problem type URIs as https://errors.blackwing.dev/<code>', () => {
    expect(PROBLEM_TYPE_BASE).toBe('https://errors.blackwing.dev/');
    expect(problemTypeFor('NOT_FOUND')).toBe('https://errors.blackwing.dev/NOT_FOUND');
    for (const code of ERROR_CODE_LIST)
      expect(new URL(problemTypeFor(code)).protocol).toBe('https:');
  });

  it('recognises registered codes only, never prototype members or non-strings', () => {
    for (const value of [
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'not_found',
      '',
      ' NOT_FOUND',
    ]) {
      expect(isErrorCode(value)).toBe(false);
    }
    for (const value of [undefined, null, 404, {}, [], Symbol('NOT_FOUND')])
      expect(isErrorCode(value)).toBe(false);
  });

  it('derives the union type and literal statuses from the one registry object', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'VALIDATION_FAILED'
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'PRECONDITION_FAILED'
      | 'RATE_LIMITED'
      | 'ILLEGAL_RUN_TRANSITION'
      | 'TENANT_CONTEXT_MISSING'
      | 'KILL_SWITCH_ACTIVE'
      | 'SCOPE_VIOLATION'
      | 'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING'
      | 'SCOPE_DESTRUCTIVE_FORBIDDEN'
      | 'SCOPE_INVALID_CLASS'
      | 'SCOPE_INVALID_BUDGET'
      | 'SCOPE_BUDGET_EXCEEDS_SA'
      | 'CONFIG_INVALID'
      | 'INTERNAL'
    >();
    expectTypeOf<HttpStatusOf<'NOT_FOUND'>>().toEqualTypeOf<404>();
    expectTypeOf<HttpStatusOf<'KILL_SWITCH_ACTIVE'>>().toEqualTypeOf<423>();
    expectTypeOf(httpStatusFor('RATE_LIMITED')).toEqualTypeOf<429>();
  });
});
