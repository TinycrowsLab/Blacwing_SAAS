import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AppError, isAppError, toProblemDetails, ValidationError } from '@blackwing/errors';

import { FindingId, RunId } from './entities.js';
import { IdValidationError, type IdValidationReason, isIdValidationError } from './errors.js';
import { ID_PREFIX_LIST, ID_PREFIXES, type IdPrefix, isIdPrefix } from './prefixes.js';
import { isPublicId, newPublicId, parsePublicId, toPublicId, toUuid } from './public-id.js';
import { createUuidV7Generator, newId, uuidTimestamp } from './uuid.js';

const BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** Arbitrary UUIDv7s: random timestamp, counter and tail, version and variant fixed. */
const uuidV7 = fc
  .tuple(fc.integer({ min: 0, max: 2 ** 48 - 1 }), fc.uint8Array({ minLength: 10, maxLength: 10 }))
  .map(([ms, rnd]) => {
    const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
    const r = (i: number): number => rnd[i] ?? 0;
    const ts = hex(ms, 12);
    return (
      `${ts.slice(0, 8)}-${ts.slice(8)}-` +
      `7${hex(r(0) & 0x0f, 1)}${hex(r(1), 2)}-` +
      `${hex(0x80 | (r(2) & 0x3f), 2)}${hex(r(3), 2)}-` +
      `${hex(r(4), 2)}${hex(r(5), 2)}${hex(r(6), 2)}${hex(r(7), 2)}${hex(r(8), 2)}${hex(r(9), 2)}`
    );
  });

const prefix = fc.constantFrom(...ID_PREFIX_LIST);

/** The value `fn` throws; fails the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function reasonOf(fn: () => unknown): IdValidationReason | 'no error' {
  try {
    fn();
  } catch (error) {
    if (isIdValidationError(error)) return error.reason;
    throw error;
  }
  return 'no error';
}

describe('prefix registry', () => {
  it("holds exactly the issue's prefixes", () => {
    expect([...ID_PREFIX_LIST].sort()).toEqual(
      [
        'areq',
        'asset',
        'evd',
        'fnd',
        'kill',
        'oob',
        'rpa',
        'run',
        'rvj',
        'sa',
        'sched',
        'sess',
        'sub',
        'tc',
        'ten',
        'tok',
        'tp',
        'usr',
      ].sort(),
    );
  });

  it('uses lowercase a-z prefixes and unique brand names', () => {
    for (const p of ID_PREFIX_LIST) expect(p).toMatch(/^[a-z]+$/);
    const brands = Object.values(ID_PREFIXES);
    expect(new Set(brands).size).toBe(brands.length);
    for (const brand of brands) expect(brand).toMatch(/^[A-Z][A-Za-z]*Id$/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ID_PREFIXES)).toBe(true);
    expect(Object.isFrozen(ID_PREFIX_LIST)).toBe(true);
  });

  it('isIdPrefix ignores inherited keys', () => {
    expect(isIdPrefix('run')).toBe(true);
    expect(isIdPrefix('toString')).toBe(false);
    expect(isIdPrefix('__proto__')).toBe(false);
    expect(isIdPrefix(1)).toBe(false);
  });
});

describe('toPublicId / toUuid', () => {
  it("property: toUuid(toPublicId(u, 'run')) equals u for 10k random UUIDv7s", () => {
    fc.assert(
      fc.property(uuidV7, (u) => {
        expect(toUuid(toPublicId(u, 'run'))).toBe(u);
      }),
      { numRuns: 10_000 },
    );
  }, 60_000);

  it('property: round-trips for every prefix, and uppercase UUID input normalises', () => {
    fc.assert(
      fc.property(uuidV7, prefix, (u, p) => {
        const id = toPublicId(u.toUpperCase(), p);
        expect(id.startsWith(`${p}_`)).toBe(true);
        expect(id.slice(p.length + 1)).toMatch(BODY);
        expect(parsePublicId(id)).toEqual({ prefix: p, uuid: u, id });
        expect(toPublicId(toUuid(id), p)).toBe(id);
      }),
      { numRuns: 2_000 },
    );
  }, 60_000);

  it('round-trips 10k ids from the real generator', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const u = newId();
      expect(toUuid(toPublicId(u, 'run'))).toBe(u);
    }
  }, 60_000);

  it('encodes the RFC 9562 example UUIDv7 to a known public id', () => {
    expect(toPublicId('017f22e2-79b0-7cc3-98c4-dc0c0c07398f', 'run')).toBe(
      'run_01fwhe4ydgfk1shh6w1g60eecf',
    );
    expect(toPublicId('017F22E2-79B0-7CC3-98C4-DC0C0C07398F', 'fnd')).toBe(
      'fnd_01fwhe4ydgfk1shh6w1g60eecf',
    );
  });

  it('the same UUID under two prefixes differs only in the prefix', () => {
    const u = newId();
    expect(toPublicId(u, 'run').slice(4)).toBe(toPublicId(u, 'fnd').slice(4));
  });

  it('rejects an unregistered prefix at runtime', () => {
    expect(reasonOf(() => toPublicId(newId(), 'xyz' as IdPrefix))).toBe('unknown_prefix');
    expect(reasonOf(() => newPublicId('' as IdPrefix))).toBe('unknown_prefix');
  });

  it('rejects non-v7 or malformed UUIDs', () => {
    expect(reasonOf(() => toPublicId('0190a1b2-c3d4-4e8f-9a0b-1c2d3e4f5a6b', 'run'))).toBe(
      'not_uuidv7',
    );
    expect(reasonOf(() => toPublicId('not-a-uuid', 'run'))).toBe('invalid_uuid');
    expect(reasonOf(() => toPublicId(undefined, 'run'))).toBe('not_a_string');
  });

  it('toUuid with an expected prefix rejects other entities', () => {
    const id = newPublicId('run');
    expect(toUuid(id, 'run')).toBe(parsePublicId(id).uuid);
    expect(reasonOf(() => toUuid(id, 'fnd'))).toBe('prefix_mismatch');
  });
});

describe('newPublicId', () => {
  it('produces valid, unique ids whose order follows creation order', () => {
    const ids = Array.from({ length: 5_000 }, () => newPublicId('fnd'));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i += 1) expect((ids[i - 1] ?? '') < (ids[i] ?? '')).toBe(true);
    for (const id of ids) expect(isPublicId(id, 'fnd')).toBe(true);
  });

  it('embeds a UUIDv7 carrying the creation time', () => {
    const before = Date.now();
    const { uuid } = parsePublicId(newPublicId('run'));
    expect(uuidTimestamp(uuid)).toBeGreaterThanOrEqual(before);
  });
});

describe('parsePublicId validation', () => {
  const good = toPublicId('017f22e2-79b0-7cc3-98c4-dc0c0c07398f', 'run');
  const body = good.slice(4);

  it('returns prefix and canonical uuid', () => {
    expect(parsePublicId(good)).toEqual({
      prefix: 'run',
      uuid: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      id: good,
    });
    expect(parsePublicId(good, 'run').prefix).toBe('run');
  });

  it.each<[string, unknown, IdValidationReason]>([
    ['a number', 42, 'not_a_string'],
    ['null', null, 'not_a_string'],
    ['an empty string', '', 'malformed'],
    ['no separator', `run${body}`, 'malformed'],
    ['an empty prefix', `_${body}`, 'malformed'],
    ['an empty body', 'run_', 'malformed'],
    ['an uppercase prefix', `RUN_${body}`, 'malformed'],
    ['a mixed-case prefix', `Run_${body}`, 'malformed'],
    ['a prefix with digits', `run2_${body}`, 'malformed'],
    ['a prefix with whitespace', ` run_${body}`, 'malformed'],
    ['an unregistered prefix', `job_${body}`, 'unknown_prefix'],
    ['an inherited-property prefix', `constructor_${body}`, 'unknown_prefix'],
    ['a short body', `run_${body.slice(1)}`, 'invalid_length'],
    ['a long body', `run_${body}0`, 'invalid_length'],
    ['a trailing newline', `run_${body.slice(0, 25)}\n`, 'invalid_base32'],
    ['an uppercase body', `run_${body.toUpperCase()}`, 'invalid_base32'],
    ['a mixed-case body', `run_${body.slice(0, 3)}W${body.slice(4)}`, 'invalid_base32'],
    ['ambiguous i', `run_${body.slice(0, 25)}i`, 'invalid_base32'],
    ['ambiguous l', `run_${body.slice(0, 25)}l`, 'invalid_base32'],
    ['ambiguous o', `run_${body.slice(0, 25)}o`, 'invalid_base32'],
    ['ambiguous u', `run_${body.slice(0, 25)}u`, 'invalid_base32'],
    ['a second separator', `run_${body.slice(0, 25)}_`, 'invalid_base32'],
    ['a non-canonical first char', `run_8${body.slice(1)}`, 'non_canonical'],
    ['a non-v7 payload (all zero)', 'run_00000000000000000000000000', 'not_uuidv7'],
    ['a v4 payload', toPublicIdUnchecked('0190a1b2c3d44e8f9a0b1c2d3e4f5a6b'), 'not_uuidv7'],
    [
      'a wrong-variant payload',
      toPublicIdUnchecked('0190a1b2c3d47e8fca0b1c2d3e4f5a6b'),
      'not_uuidv7',
    ],
  ])('rejects %s with ValidationError', (_label, input, reason) => {
    expect(reasonOf(() => parsePublicId(input))).toBe(reason);
    expect(isPublicId(input)).toBe(false);
  });

  it('throws an IdValidationError carrying the VALIDATION_FAILED code', () => {
    let caught: unknown;
    try {
      parsePublicId('run_bogus');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      name: 'ValidationError',
      code: 'VALIDATION_FAILED',
      httpStatus: 422,
      retryable: false,
    });
  });

  it('is a ValidationError from @blackwing/errors, so the problem+json mapper answers 422', () => {
    let caught: unknown;
    try {
      parsePublicId('bw_pat_SUPERSECRETVALUE1234567890');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(AppError);
    expect(isAppError(caught)).toBe(true);
    // Wired as the API boundary wires it: production, with the registry redactor injected.
    const body = toProblemDetails(caught, 'trace-1', {
      environment: 'production',
      redact: (text) => text,
    });
    expect(body).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      type: 'https://errors.blackwing.dev/VALIDATION_FAILED',
    });
    expect(body.detail).toBe(caught instanceof IdValidationError ? caught.message : undefined);
    expect(JSON.stringify(body)).not.toContain('SUPERSECRET');
  });

  it('never echoes the rejected input in the error message', () => {
    const secretLooking = 'bw_pat_SUPERSECRETVALUE1234567890';
    expect(String(thrownBy(() => parsePublicId(secretLooking)))).not.toContain('SUPERSECRET');
  });

  it('rejects a wrong prefix when an expected prefix is given', () => {
    const run = newPublicId('run');
    expect(reasonOf(() => parsePublicId(run, 'fnd'))).toBe('prefix_mismatch');
    expect(() => parsePublicId(run, 'fnd')).toThrow(/expected "fnd", got "run"/);
    expect(isPublicId(run, 'fnd')).toBe(false);
    expect(isPublicId(run, 'run')).toBe(true);
  });

  it('rejects an unregistered expected prefix', () => {
    expect(reasonOf(() => parsePublicId(newPublicId('run'), 'nope' as IdPrefix))).toBe(
      'unknown_prefix',
    );
    expect(isPublicId(newPublicId('run'), 'nope' as IdPrefix)).toBe(false);
  });

  it("parsePublicId('run_…') with a wrong prefix for a FindingId constructor throws", () => {
    const run = RunId.generate();
    expect(() => FindingId.parse(run)).toThrow(IdValidationError);
    expect(reasonOf(() => FindingId.parse(run))).toBe('prefix_mismatch');
    expect(reasonOf(() => FindingId.parse(parsePublicId(run).id))).toBe('prefix_mismatch');
  });

  it('property: arbitrary strings never crash the parser and are only accepted in canonical form', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (input) => {
        if (!isPublicId(input)) return reasonOf(() => parsePublicId(input)) !== 'no error';
        const { prefix: p, uuid } = parsePublicId(input);
        return toPublicId(uuid, p) === input;
      }),
    );
  });

  it('does not depend on generator state (pure decode)', () => {
    const next = createUuidV7Generator({ now: () => 1 });
    const u = next();
    const id = toPublicId(u, 'evd');
    newPublicId('evd');
    expect(parsePublicId(id).uuid).toBe(u);
  });
});

/** Builds `run_<body>` for raw 32-hex bytes without the UUIDv7 check, to test decode-side rejection. */
function toPublicIdUnchecked(hex: string): string {
  let n = BigInt(`0x${hex}`);
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = alphabet.charAt(Number(n & 31n)) + out;
    n >>= 5n;
  }
  return `run_${out}`;
}
