import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IdValidationError } from './errors.js';
import {
  createUuidV7Generator,
  createUuidV7GeneratorWithCounterLimit,
  formatUuidBytes,
  isUuidV7,
  newId,
  parseUuid,
  UUIDV7_COUNTER,
  uuidTimestamp,
  writeUuidBytes,
} from './uuid.js';

/** The value `fn` throws; fails the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The 42-bit counter: 12 bits after the version nibble, then 30 bits after the variant bits. */
function counterOf(uuid: string): number {
  const bytes = new Uint8Array(16);
  writeUuidBytes(uuid, bytes);
  const high = (((bytes[6] ?? 0) & 0x0f) << 8) | (bytes[7] ?? 0);
  const low =
    ((((bytes[8] ?? 0) & 0x3f) << 24) |
      ((bytes[9] ?? 0) << 16) |
      ((bytes[10] ?? 0) << 8) |
      (bytes[11] ?? 0)) >>>
    0;
  return high * 2 ** 30 + low;
}

/** A deterministic, non-cryptographic byte source for tests that need reproducible counters. */
function fixedRandom(value: number): (buffer: Uint8Array) => void {
  return (buffer) => buffer.fill(value);
}

function expectStrictlyIncreasing(ids: readonly string[]): void {
  for (let i = 1; i < ids.length; i += 1) {
    const previous = ids[i - 1] ?? '';
    const current = ids[i] ?? '';
    if (!(previous < current)) {
      throw new Error(`not increasing at ${i}: ${previous} >= ${current}`);
    }
  }
}

describe('newId', () => {
  it('returns canonical lowercase UUIDv7 strings', () => {
    for (let i = 0; i < 1000; i += 1) expect(newId()).toMatch(V7);
  });

  it('is monotonically increasing when generated in sequence', () => {
    const ids = Array.from({ length: 50_000 }, () => newId());
    expectStrictlyIncreasing(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embeds the current Unix millisecond timestamp', () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    // The generator may run ahead of the wall clock (counter rollover) but never behind the last id.
    expect(uuidTimestamp(id)).toBeGreaterThanOrEqual(before);
    expect(uuidTimestamp(id)).toBeLessThanOrEqual(after + 1);
  });
});

describe('createUuidV7Generator monotonic guard', () => {
  it('keeps increasing when the clock goes backwards', () => {
    const times = [10_000, 10_000, 9_000, 5, 10_000, 10_001, 9_999];
    let i = 0;
    const next = createUuidV7Generator({ now: () => times[i++] ?? 0 });
    const ids = times.map(() => next());
    expectStrictlyIncreasing(ids);
    // The timestamp never moves below the highest value already used.
    expect(ids.map((id) => uuidTimestamp(id))).toEqual([
      10_000, 10_000, 10_000, 10_000, 10_000, 10_001, 10_001,
    ]);
  });

  it('increments the counter within one millisecond and reseeds on a new millisecond', () => {
    let ms = 1_700_000_000_000;
    const next = createUuidV7Generator({ now: () => ms, randomFill: fixedRandom(0) });
    const a = next();
    const b = next();
    const c = next();
    expect(counterOf(a)).toBe(0);
    expect(counterOf(b)).toBe(1);
    expect(counterOf(c)).toBe(2);
    ms += 1;
    const d = next();
    expect(uuidTimestamp(d)).toBe(ms);
    expect(counterOf(d)).toBe(0);
  });

  it('seeds the counter with its leftmost bit clear to leave room for increments', () => {
    const next = createUuidV7Generator({ now: () => 1, randomFill: fixedRandom(0xff) });
    expect(counterOf(next())).toBe(UUIDV7_COUNTER.seedSpace - 1);
  });

  it('generates strictly increasing ids under a frozen clock across many calls', () => {
    const next = createUuidV7Generator({ now: () => 1_000 });
    const ids = Array.from({ length: 20_000 }, () => next());
    expectStrictlyIncreasing(ids);
    expect(ids.every((id) => uuidTimestamp(id) === 1_000)).toBe(true);
  });

  it('property: any clock sequence yields strictly increasing ids', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 48 - 1 }), { minLength: 2, maxLength: 200 }),
        (times) => {
          let i = 0;
          const next = createUuidV7Generator({ now: () => times[i++] ?? 0 });
          const ids = times.map(() => next());
          expectStrictlyIncreasing(ids);
          expect(ids.every((id) => V7.test(id))).toBe(true);
        },
      ),
    );
  });

  it('rejects a clock that returns NaN, Infinity or a negative value', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const next = createUuidV7Generator({ now: () => bad });
      expect(() => next()).toThrow(RangeError);
    }
  });

  it('rejects timestamps beyond the 48-bit range', () => {
    const next = createUuidV7Generator({ now: () => 2 ** 48 });
    expect(() => next()).toThrow(RangeError);
  });

  it('rejects an undersized random pool', () => {
    expect(() => createUuidV7Generator({ poolSize: 8 })).toThrow(RangeError);
    expect(() => createUuidV7Generator({ poolSize: 16.5 })).toThrow(RangeError);
  });
});

describe('counter rollover', () => {
  it('uses the full RFC 9562 method-1 width: a 42-bit counter seeded below 2^41', () => {
    expect(UUIDV7_COUNTER).toEqual({ bits: 42, max: 2 ** 42 - 1, seedSpace: 2 ** 41 });
  });

  it('advances the timestamp by one millisecond and reseeds when the counter is exhausted', () => {
    // A 3-bit counter (max 7) seeded at its highest allowed value (3) overflows after 4 more ids.
    const next = createUuidV7GeneratorWithCounterLimit(
      { now: () => 500, randomFill: fixedRandom(0xff) },
      7,
    );
    const ids = Array.from({ length: 6 }, () => next());
    expectStrictlyIncreasing(ids);
    expect(ids.map((id) => counterOf(id))).toEqual([3, 4, 5, 6, 7, 3]);
    expect(ids.map((id) => uuidTimestamp(id))).toEqual([500, 500, 500, 500, 500, 501]);
  });

  it('stays ahead of a wall clock that has not caught up after a rollover', () => {
    let ms = 900;
    const next = createUuidV7GeneratorWithCounterLimit(
      { now: () => ms, randomFill: fixedRandom(0) },
      1,
    );
    // Counter max 1, seed 0: two ids per millisecond, then the generator runs ahead of the clock.
    const ids = Array.from({ length: 5 }, () => next());
    expect(ids.map((id) => uuidTimestamp(id))).toEqual([900, 900, 901, 901, 902]);
    ms = 901; // the real clock is still behind the generator
    ids.push(next());
    ms = 905; // the real clock overtakes it: back to wall-clock time with a fresh seed
    ids.push(next());
    expectStrictlyIncreasing(ids);
    expect(ids.slice(5).map((id) => uuidTimestamp(id))).toEqual([902, 905]);
  });

  it('rejects a counter limit that is not 2^k - 1 within 42 bits', () => {
    for (const bad of [0, 2, 6, 2 ** 43 - 1, 1.5]) {
      expect(() => createUuidV7GeneratorWithCounterLimit({}, bad)).toThrow(RangeError);
    }
  });
});

describe('allocation-light generation', () => {
  it('draws randomness from a pooled buffer, not once per id', () => {
    let fills = 0;
    let poolLength = 0;
    const next = createUuidV7Generator({
      now: () => 1,
      randomFill: (buffer) => {
        fills += 1;
        poolLength = buffer.length;
        buffer.fill(1);
      },
    });
    const count = 100_000;
    for (let i = 0; i < count; i += 1) next();
    // 4 random bytes per id (+6 once for the single millisecond seed) from a 4096-byte pool.
    expect(poolLength).toBe(4096);
    expect(fills).toBe(Math.ceil((count * 4 + 6) / 4096));
  });

  it('reuses the same pool buffer on every refill', () => {
    const seen = new Set<Uint8Array>();
    const next = createUuidV7Generator({
      poolSize: 16,
      randomFill: (buffer) => void seen.add(buffer.fill(3)),
    });
    for (let i = 0; i < 100; i += 1) next();
    expect(seen.size).toBe(1);
  });
});

describe('isUuidV7 / parseUuid', () => {
  it('accepts generated ids and uppercase input, normalising to lowercase', () => {
    const id = newId();
    expect(isUuidV7(id)).toBe(true);
    expect(parseUuid(id.toUpperCase())).toBe(id);
  });

  it.each([
    ['not a string', 42, 'not_a_string'],
    ['empty', '', 'invalid_uuid'],
    ['missing dashes', '0190a1b2c3d47e8f9a0b1c2d3e4f5a6b', 'invalid_uuid'],
    ['non-hex', '0190a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6g', 'invalid_uuid'],
    ['trailing newline', '0190a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b\n', 'invalid_uuid'],
    ['braced', '{0190a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b}', 'invalid_uuid'],
    ['version 4', '0190a1b2-c3d4-4e8f-9a0b-1c2d3e4f5a6b', 'not_uuidv7'],
    ['nil', '00000000-0000-0000-0000-000000000000', 'not_uuidv7'],
    ['wrong variant', '0190a1b2-c3d4-7e8f-ca0b-1c2d3e4f5a6b', 'not_uuidv7'],
  ])('rejects %s', (_label, input, reason) => {
    expect(isUuidV7(input)).toBe(false);
    expect(() => parseUuid(input)).toThrow(IdValidationError);
    const error = thrownBy(() => parseUuid(input));
    expect(error).toBeInstanceOf(IdValidationError);
    expect((error as IdValidationError).reason).toBe(reason);
  });

  it('writeUuidBytes / formatUuidBytes round-trip', () => {
    fc.assert(
      fc.property(fc.uuid(), (uuid) => {
        const bytes = new Uint8Array(16);
        writeUuidBytes(uuid, bytes);
        expect(formatUuidBytes(bytes)).toBe(uuid.toLowerCase());
        writeUuidBytes(uuid.toUpperCase(), bytes);
        expect(formatUuidBytes(bytes)).toBe(uuid.toLowerCase());
      }),
    );
  });
});
