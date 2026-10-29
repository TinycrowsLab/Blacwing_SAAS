import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CanonicalJsonError, saEnvelopeSchema } from '@blackwing/contracts';

import {
  CanonicalisationError,
  canonicalHash,
  canonicalise,
  canonicaliseValue,
  CRYPTO_NONFINITE_NUMBER,
} from './jcs.js';

interface Vector {
  id: string;
  input: unknown;
  canonical: string;
  sha256: string;
}

const vectorFile = JSON.parse(
  readFileSync(new URL('../testdata/jcs-vectors.json', import.meta.url), 'utf8'),
) as { version: number; vectors: Vector[] };

const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (bytes: Uint8Array): string => decoder.decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Rebuilds a JSON value with every object's keys in the order `order` returns. */
function reorder(value: unknown, order: (keys: string[]) => string[]): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => reorder(item, order));
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

const SA_ID = '01900000-0000-7000-8000-000000000001';
const envelopeVector = vectorFile.vectors.find((v) => v.id === 'sa-envelope-pre-approval');
if (envelopeVector === undefined) throw new Error('missing sa-envelope vector');
const envelope = saEnvelopeSchema.parse(envelopeVector.input);

describe('RFC 8785 vectors (testdata/jcs-vectors.json)', () => {
  it('ships at least 15 vectors in a versioned file', () => {
    expect(vectorFile.version).toBe(1);
    expect(vectorFile.vectors.length).toBeGreaterThanOrEqual(15);
  });

  it.each(vectorFile.vectors.map((v) => [v.id, v] as const))(
    '%s: canonical bytes and SHA-256 match the expected values',
    (_id, vector) => {
      const bytes = canonicaliseValue(vector.input);
      expect(text(bytes)).toBe(vector.canonical);
      expect(sha256(bytes)).toBe(vector.sha256);
    },
  );

  it('canonicalise and canonicalHash agree with the SA envelope vector', () => {
    expect(text(canonicalise(envelope))).toBe(envelopeVector.canonical);
    expect(canonicalHash(envelope)).toBe(envelopeVector.sha256);
  });
});

describe('canonicalise and canonicalHash (#375)', () => {
  it('is idempotent: re-parsing the canonical text yields the same bytes', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicaliseValue(value);
        const twice = canonicaliseValue(JSON.parse(text(once)));
        expect(text(twice)).toBe(text(once));
      }),
    );
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const reversed = reorder(value, (keys) => [...keys].reverse());
        expect(text(canonicaliseValue(reversed))).toBe(text(canonicaliseValue(value)));
      }),
    );
  });

  it('round-trips finite doubles through ECMAScript number serialisation', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (n) => {
        const parsed = JSON.parse(text(canonicaliseValue([n]))) as number[];
        expect(Object.is(parsed[0], n === 0 ? 0 : n)).toBe(true);
      }),
    );
  });

  it('changes the hash when any signed field changes', () => {
    const base = canonicalHash(envelope);
    expect(canonicalHash({ ...envelope, maxIntrusiveness: 'state_changing' })).not.toBe(base);
    expect(canonicalHash({ ...envelope, expiresAt: '2026-03-01T00:00:00.000Z' })).not.toBe(base);
    expect(canonicalHash({ ...envelope, assetIds: [SA_ID] })).not.toBe(base);
  });

  it('canonicalises a null approver explicitly, different from a dropped key', () => {
    const withNull = canonicaliseValue({ ...envelope, approverId: null });
    const withoutKey: Record<string, unknown> = { ...envelope };
    delete withoutKey.approverId;
    expect(text(withNull)).toContain('"approverId":null');
    expect(text(canonicaliseValue(withoutKey))).not.toBe(text(withNull));
  });

  it('returns UTF-8 bytes, not JS string units', () => {
    expect(text(canonicaliseValue(['😀']))).toBe('["😀"]');
    expect(canonicaliseValue(['😀']).byteLength).toBe(Buffer.byteLength('["😀"]', 'utf8'));
  });

  it.each([Number.NaN, Infinity, -Infinity])(
    'rejects non-finite numbers (%s) with CRYPTO_NONFINITE_NUMBER',
    (bad) => {
      const badBody = {
        ...envelope,
        testWindows: [{ cron: '* * * * *', timezone: 'UTC', durationMs: bad }],
      };
      let thrown: unknown;
      try {
        canonicalise(badBody);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CanonicalisationError);
      expect((thrown as CanonicalisationError).code).toBe(CRYPTO_NONFINITE_NUMBER);
    },
  );

  it('rejects lone surrogates instead of signing unrepresentable bytes', () => {
    expect(() => canonicaliseValue({ name: '\uD800' })).toThrow(CanonicalJsonError);
  });

  it('rejects non-plain objects such as Date', () => {
    expect(() => canonicaliseValue({ at: new Date(0) })).toThrow(CanonicalJsonError);
  });
});
