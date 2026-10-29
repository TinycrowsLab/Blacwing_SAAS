import { describe, expect, it } from 'vitest';

import { isIntrusivenessError } from '@blackwing/contracts';
import { isAppError, ValidationError } from '@blackwing/errors';

import { assertSaDraft, InvalidSaWindowError, type SaDraftFields } from './validate.js';

const ASSET = '0190f6a2-7b1c-7d2e-8f3a-0000000000aa';
const VALID_FROM = new Date('2026-11-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-12-01T00:00:00.000Z');

function draft(overrides: Partial<SaDraftFields> = {}): SaDraftFields {
  return {
    assetIds: [ASSET],
    maxIntrusiveness: 'active_safe',
    validFrom: VALID_FROM,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assertSaDraft: accepted drafts', () => {
  it.each(['passive', 'active_safe', 'state_changing'] as const)(
    'accepts a %s ceiling and returns the parsed class',
    (ceiling) => {
      expect(assertSaDraft(draft({ maxIntrusiveness: ceiling }))).toBe(ceiling);
    },
  );

  it('accepts several assets', () => {
    expect(
      assertSaDraft(draft({ assetIds: [ASSET, '0190f6a2-7b1c-7d2e-8f3a-0000000000bb'] })),
    ).toBe('active_safe');
  });
});

describe('assertSaDraft: edge cases and security negatives', () => {
  it('rejects an empty asset list with VALIDATION_FAILED (422)', () => {
    const error = thrownBy(() => assertSaDraft(draft({ assetIds: [] })));
    expect(error).toBeInstanceOf(ValidationError);
    expect(isAppError(error) && error.httpStatus).toBe(422);
  });

  it('rejects destructive as a ceiling (§8.3) with SCOPE_DESTRUCTIVE_FORBIDDEN', () => {
    const error = thrownBy(() => assertSaDraft(draft({ maxIntrusiveness: 'destructive' })));
    expect(isIntrusivenessError(error)).toBe(true);
    expect((error as { code?: string }).code).toBe('SCOPE_DESTRUCTIVE_FORBIDDEN');
  });

  it.each(['Destructive', 'DESTRUCTIVE', ' passive', 'unknown', '', null, undefined, 0])(
    'rejects a non-canonical class %j with SCOPE_INVALID_CLASS',
    (value) => {
      const error = thrownBy(() => assertSaDraft(draft({ maxIntrusiveness: value })));
      expect(isIntrusivenessError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('SCOPE_INVALID_CLASS');
    },
  );

  it('rejects valid_from equal to expires_at (empty window) with AUTHZ_INVALID_WINDOW', () => {
    const error = thrownBy(() =>
      assertSaDraft(draft({ validFrom: EXPIRES_AT, expiresAt: EXPIRES_AT })),
    );
    expect(error).toBeInstanceOf(InvalidSaWindowError);
    expect(isAppError(error) && error.code).toBe('AUTHZ_INVALID_WINDOW');
    expect(isAppError(error) && error.httpStatus).toBe(422);
  });

  it('rejects an inverted window', () => {
    expect(() => assertSaDraft(draft({ validFrom: EXPIRES_AT, expiresAt: VALID_FROM }))).toThrow(
      InvalidSaWindowError,
    );
  });

  it('fails closed on an invalid date (NaN is not a window)', () => {
    expect(() => assertSaDraft(draft({ validFrom: new Date('nope') }))).toThrow(
      InvalidSaWindowError,
    );
    expect(() => assertSaDraft(draft({ expiresAt: new Date('nope') }))).toThrow(
      InvalidSaWindowError,
    );
  });
});
