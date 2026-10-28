import { describe, expect, it } from 'vitest';

import { canonicalQueryText, PERSISTED_HASH_PATTERN } from './graphql-persisted.js';

describe('canonicalQueryText', () => {
  it('gives the same text for whitespace, line-break and comment variants of one document', () => {
    const compact = 'query Runs($limit: Int!) { runs(limit: $limit) { id state } }';
    const spread = `
      # the dashboard list
      query Runs( $limit: Int! ) {
        runs(limit: $limit) {
          id
          state
        }
      }
    `;
    expect(canonicalQueryText(spread)).toBe(canonicalQueryText(compact));
  });

  it('is idempotent, so a manifest entry re-canonicalised at boot keeps its hash', () => {
    const once = canonicalQueryText('query Runs { runs { id } }');
    expect(canonicalQueryText(once)).toBe(once);
  });

  it('keeps field order, which changes the response shape', () => {
    expect(canonicalQueryText('query Q { a b }')).not.toBe(canonicalQueryText('query Q { b a }'));
  });

  it('keeps variables and their values, so a different document never collides', () => {
    expect(canonicalQueryText('query Q($l: Int) { runs(limit: $l) { id } }')).not.toBe(
      canonicalQueryText('query Q($l: Int) { runs(limit: 5) { id } }'),
    );
  });

  it('throws on a document that does not parse', () => {
    expect(() => canonicalQueryText('query Q { runs ')).toThrow();
  });
});

describe('PERSISTED_HASH_PATTERN', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(PERSISTED_HASH_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(PERSISTED_HASH_PATTERN.test('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['surrounding whitespace', ` ${'a'.repeat(64)}`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(PERSISTED_HASH_PATTERN.test(value)).toBe(false);
  });
});
