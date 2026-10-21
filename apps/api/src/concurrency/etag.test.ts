import { describe, expect, it } from 'vitest';

import { canonicalize, computeEtag, stateVersionOf, versionFromEtag } from './etag.js';
import { assertRowUpdated, parseIfMatch, requireIfMatch } from './if-match.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const code = (error: unknown): unknown =>
  (error as { code?: string }).code ?? (error as { problemCode?: string }).problemCode;

describe('computeEtag', () => {
  it('uses the state_version as a strong "v{n}" validator', () => {
    expect(computeEtag({ id: 'a', state_version: 7 })).toBe('"v7"');
    expect(computeEtag({ id: 'a', stateVersion: 0 })).toBe('"v0"');
    expect(computeEtag({ state_version: 12n })).toBe('"v12"');
  });

  it('falls back to 16 hex chars of the canonical SHA-256 without a version', () => {
    expect(computeEtag({ id: 'a', name: 'x' })).toMatch(/^"[0-9a-f]{16}"$/);
    expect(computeEtag({ id: 'a', state_version: -1 })).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('is deterministic regardless of key order, nesting and undefined members', () => {
    const a = { name: 'x', nested: { b: 1, a: [1, { z: 1, y: 2 }] }, gone: undefined };
    const b = { nested: { a: [1, { y: 2, z: 1 }], b: 1 }, name: 'x' };
    expect(computeEtag(a)).toBe(computeEtag(b));
    expect(computeEtag({ ...b, name: 'y' })).not.toBe(computeEtag(b));
    expect(canonicalize(new Date('2026-01-01T00:00:00Z'))).toBe('"2026-01-01T00:00:00.000Z"');
  });

  it('never embeds resource content in the tag', () => {
    expect(computeEtag({ secret: 'hunter2' })).not.toContain('hunter2');
  });

  it('round-trips versions', () => {
    expect(versionFromEtag('"v42"')).toBe(42);
    expect(versionFromEtag('"abcdef0123456789"')).toBeUndefined();
    expect(stateVersionOf('x')).toBeUndefined();
  });
});

describe('parseIfMatch', () => {
  it('parses *, single, list and repeated-header forms', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' });
    expect(parseIfMatch('"v1"')).toEqual({ kind: 'tags', etags: ['"v1"'] });
    expect(parseIfMatch('"v1", "v2" ,"abc"')).toEqual({
      kind: 'tags',
      etags: ['"v1"', '"v2"', '"abc"'],
    });
    expect(parseIfMatch(['"v1"', '"v2"'])).toEqual({ kind: 'tags', etags: ['"v1"', '"v2"'] });
  });

  it('treats absent or blank as missing', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('  ')).toBeUndefined();
  });

  it.each(['W/"v1"', '"v1", W/"v2"', 'v1', '"v1" "v2"', '"unterminated'])(
    'rejects %s as 428 precondition_required',
    (header) => {
      expect(code(thrown(() => parseIfMatch(header)))).toBe('PRECONDITION_REQUIRED');
    },
  );
});

describe('requireIfMatch', () => {
  it('returns the expected version when the tag matches', () => {
    expect(requireIfMatch('"v3"', '"v3"')).toEqual({ etag: '"v3"', expectedVersion: 3 });
  });

  it('matches when any listed tag equals the current one', () => {
    expect(requireIfMatch('"v3"', '"v1", "v3"').expectedVersion).toBe(3);
  });

  it('accepts a content-hash tag with no version', () => {
    const tag = '"abcdef0123456789"';
    expect(requireIfMatch(tag, tag).expectedVersion).toBeUndefined();
  });

  it('missing header is 428', () => {
    expect(code(thrown(() => requireIfMatch('"v3"', undefined)))).toBe('PRECONDITION_REQUIRED');
  });

  it('stale tag is 412', () => {
    expect(code(thrown(() => requireIfMatch('"v3"', '"v2"')))).toBe('PRECONDITION_FAILED');
  });

  it('* passes for an existing resource and is 412 for a missing one', () => {
    expect(requireIfMatch('"v3"', '*').expectedVersion).toBeUndefined();
    expect(code(thrown(() => requireIfMatch(null, '*')))).toBe('PRECONDITION_FAILED');
    expect(code(thrown(() => requireIfMatch(undefined, '"v1"')))).toBe('PRECONDITION_FAILED');
  });

  it('a missing header on a missing resource is still 428', () => {
    expect(code(thrown(() => requireIfMatch(null, undefined)))).toBe('PRECONDITION_REQUIRED');
  });
});

describe('assertRowUpdated', () => {
  it('maps 0 rows (or no count) to 412 and passes otherwise', () => {
    expect(
      code(
        thrown(() => {
          assertRowUpdated(0);
        }),
      ),
    ).toBe('PRECONDITION_FAILED');
    expect(
      code(
        thrown(() => {
          assertRowUpdated(null);
        }),
      ),
    ).toBe('PRECONDITION_FAILED');
    expect(
      thrown(() => {
        assertRowUpdated(1);
      }),
    ).toBeUndefined();
  });
});
