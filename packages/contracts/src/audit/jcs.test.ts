// JCS (RFC 8785) canonicalisation used for the audit hash chain (AUDIT-001).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson, CanonicalJsonError } from '../index.js';

/** Rebuilds a JSON value with every object's keys in a shuffled order. */
function reorder(value: unknown, order: (keys: string[]) => string[]): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => reorder(item, order));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of order(Object.keys(record))) {
      Object.defineProperty(output, key, {
        value: reorder(record[key], order),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }
  return value;
}

/** `value` with every -0 replaced by 0, which is all a JSON round trip can preserve. */
function withoutNegativeZero(value: unknown): unknown {
  if (Object.is(value, -0)) {
    return 0;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => withoutNegativeZero(item));
  }
  if (typeof value === 'object' && value !== null) {
    return reorder(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, withoutNegativeZero(item)]),
      ),
      (keys) => keys,
    );
  }
  return value;
}

const json = fc.jsonValue({ maxDepth: 4 });

describe('canonicalJson', () => {
  it('matches the RFC 8785 §3.2.3 sorting example (UTF-16 code-unit order)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(Object.keys(JSON.parse(canonicalJson(input)) as object)).toEqual([
      '1',
      '\r',
      '\u0080',
      'ö',
      '€',
      '😀',
      'דּ',
    ]);
    expect(canonicalJson(input).startsWith('{"\\r":"Carriage Return","1":"One"')).toBe(true);
  });

  it('matches the RFC 8785 §3.2.2 serialisation example', () => {
    const input = {
      numbers: [333_333_333.333_333_3, 1e30, 4.5, 2e-3, 0.000_000_000_000_000_000_000_000_001],
      // \u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/ in the RFC's JSON source.
      string: ['\u20ac$\u000f\nA', "'", 'B"', '\\', '\\', '"/'].join(''),
      literals: [null, true, false],
    };
    expect(canonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('serialises numbers per ECMAScript, with -0 as 0', () => {
    expect(canonicalJson([-0, 0, 1, -1, 1e21, 1e-7, 0.1, 5e-324, Number.MAX_SAFE_INTEGER])).toBe(
      '[0,0,1,-1,1e+21,1e-7,0.1,5e-324,9007199254740991]',
    );
  });

  it('is deterministic across key orderings (property)', () => {
    fc.assert(
      fc.property(json, fc.integer(), (value, seed) => {
        const shuffled = reorder(value, (keys) =>
          [...keys].sort((a, b) => ((a.length * 31 + seed) % 7) - ((b.length * 17 + seed) % 7)),
        );
        const reversed = reorder(value, (keys) => [...keys].reverse());
        const canonical = canonicalJson(value);
        expect(canonicalJson(shuffled)).toBe(canonical);
        expect(canonicalJson(reversed)).toBe(canonical);
      }),
    );
  });

  it('round-trips and is idempotent (property)', () => {
    fc.assert(
      fc.property(json, (value) => {
        const canonical = canonicalJson(value);
        // JSON itself has no -0, so compare with a plain JSON round trip.
        expect(JSON.parse(canonical)).toEqual(withoutNegativeZero(value));
        expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
      }),
    );
  });

  it('omits undefined object members but rejects every other non-I-JSON value', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      [undefined],
      new Date(0),
      new Map(),
      1n,
      Symbol('s'),
      () => 1,
      'x\uD800',
      { '\uDFFF': 1 },
      circular,
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });

  it('allows shared (non-circular) references', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('names the offending path', () => {
    expect(() => canonicalJson({ a: [1, { b: Number.NaN }] })).toThrow(
      'non-finite number at $.a[1].b',
    );
  });
});
