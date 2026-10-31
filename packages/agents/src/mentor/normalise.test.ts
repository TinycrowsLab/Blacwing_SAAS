// MENTOR-001 (#420): argument normalisation for loop detection is robust to volatile noise and to Unicode
// compatibility variation, and secrets never reach the digest input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hashToolArgs, REDACTED_ARG } from './normalise.js';

describe('hashToolArgs', () => {
  it('ignores volatile fields (timestamps, nonces, request ids) in any key case or separator', () => {
    const base = hashToolArgs({ target: 'lab.local', port: 8080 });
    expect(
      hashToolArgs({
        target: 'lab.local',
        port: 8080,
        timestamp: '2026-10-31T05:00:00.000Z',
        Request_ID: 'r-1',
        nonce: 'abc',
        createdAt: 1,
        traceId: 'x',
      }),
    ).toBe(base);
  });

  it('keeps meaningful keys: different targets or ports hash apart', () => {
    expect(hashToolArgs({ target: 'lab.local' })).not.toBe(hashToolArgs({ target: 'lab2.local' }));
    expect(hashToolArgs({ port: 80 })).not.toBe(hashToolArgs({ port: 81 }));
    expect(hashToolArgs({ format: 'json' })).not.toBe(hashToolArgs({ format: 'xml' }));
  });

  it('is independent of object key order', () => {
    expect(hashToolArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashToolArgs({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('NFKC-normalises text, so fullwidth and compatibility forms hash alike', () => {
    expect(hashToolArgs({ path: 'ＡＢＣ' })).toBe(hashToolArgs({ path: 'ABC' }));
    expect(hashToolArgs({ q: 'ﬁle' })).toBe(hashToolArgs({ q: 'file' }));
    expect(hashToolArgs({ q: 'a  b\n c' })).toBe(hashToolArgs({ q: 'a b c' }));
  });

  it('redacts secret-looking keys before hashing: two secrets hash alike and differ from a plain value', () => {
    const one = hashToolArgs({ api_key: 'sk-live-111', host: 'h' });
    const two = hashToolArgs({ apiKey: 'sk-live-222', host: 'h' });
    expect(one).toBe(two);
    expect(one).not.toBe(hashToolArgs({ host: 'h' }));
  });

  it('never leaves a raw secret in the canonical form it hashes', () => {
    // The digest is one-way, so check the rule through its effect: changing only the secret never changes it,
    // and the redaction marker itself is a fixed value.
    expect(REDACTED_ARG).toBe('[REDACTED]');
    expect(hashToolArgs({ password: 'p1' })).toBe(hashToolArgs({ Password: 'p2' }));
    expect(hashToolArgs({ authorization: 'Bearer x' })).toBe(
      hashToolArgs({ authorization: 'Bearer y' }),
    );
  });

  it('handles nested and self-referencing structures without exhausting the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => hashToolArgs(cyclic)).not.toThrow();
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i++) deep = { child: deep };
    expect(hashToolArgs(deep)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats undefined and missing arguments consistently', () => {
    expect(hashToolArgs(undefined)).toBe(hashToolArgs(null));
  });

  it('property: adding volatile noise never changes the digest', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc
            .string({ minLength: 1, maxLength: 8 })
            .filter(
              (k) =>
                !/^(timestamp|nonce|at|time|ts|now|date)$/i.test(k) &&
                !/password|token|secret|key|cookie|authorization|credential|apikey/i.test(k),
            ),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        ),
        fc.integer(),
        (args, n) => {
          const noisy = {
            ...args,
            timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
            nonce: n,
          };
          return hashToolArgs(noisy) === hashToolArgs(args);
        },
      ),
    );
  });
});
