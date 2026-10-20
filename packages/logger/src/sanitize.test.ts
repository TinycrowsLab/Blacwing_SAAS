import { afterEach, describe, expect, it } from 'vitest';

import { markSecret, unmarkSecret } from '@blackwing/config';

import { createLogger } from './logger.js';
import { REDACTED } from './redaction.js';
import {
  CIRCULAR,
  DEFAULT_LIMITS,
  DEFAULT_MAX_FIELD_BYTES,
  MAX_DEPTH,
  sanitize,
  sanitizeRecord,
  TRUNCATED,
  truncateUtf8,
  UNSERIALIZABLE,
} from './sanitize.js';
import { capture } from './testdata/capture.js';

const registered: string[] = [];
afterEach(() => {
  for (const value of registered.splice(0)) unmarkSecret(value);
});

describe('truncation (maxFieldBytes)', () => {
  it('defaults to 8192 bytes and appends the [truncated] marker', () => {
    expect(DEFAULT_MAX_FIELD_BYTES).toBe(8192);
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    log.info({ body: 'a'.repeat(100_000) }, 'b'.repeat(9000));
    const record = out.last();
    expect(record.body).toBe(`${'a'.repeat(8192)}${TRUNCATED}`);
    expect(record.msg).toBe(`${'b'.repeat(8192)}${TRUNCATED}`);
    expect(out.lines[0]?.length).toBeLessThan(17_000);
  });

  it('leaves a field of exactly maxFieldBytes untouched', () => {
    expect(truncateUtf8('a'.repeat(8192), 8192)).toBe('a'.repeat(8192));
  });

  it('honours a configured maxFieldBytes', () => {
    const out = capture();
    createLogger('t', { destination: out.destination, maxFieldBytes: 64 }).info({
      s: 'x'.repeat(65),
    });
    expect(out.last().s).toBe(`${'x'.repeat(64)}${TRUNCATED}`);
  });

  it('counts UTF-8 bytes and never splits a code point', () => {
    // "é" is 2 bytes, "🔑" is 4 bytes (a surrogate pair).
    expect(truncateUtf8('é'.repeat(10), 5)).toBe(`éé${TRUNCATED}`);
    expect(truncateUtf8('🔑🔑', 7)).toBe(`🔑${TRUNCATED}`);
    expect(truncateUtf8('🔑🔑', 8)).toBe('🔑🔑');
  });

  it('redacts before truncating, so a secret cut by the limit leaves no readable prefix', () => {
    const value = 'cut-secret-SHOULD-NOT-LEAK-0101';
    markSecret(value);
    registered.push(value);
    const limits = { ...DEFAULT_LIMITS, maxFieldBytes: 65 };
    // The secret starts at byte 60 and straddles the 65-byte cut: truncating first would keep "cut-s".
    const result = sanitize(`${'p'.repeat(60)}${value}`, limits) as string;
    expect(result).toBe(`${'p'.repeat(60)}[REDA${TRUNCATED}`);
    expect(result).not.toContain('cut-s');
  });

  it('matches a credential pattern that starts before the cut of a huge string in full', () => {
    // Only a window of the head is redacted for speed; the window reaches far enough past the cut.
    const huge = `${'q'.repeat(8180)}bwk_${'A'.repeat(3000)}${'r'.repeat(5_000_000)}`;
    const result = sanitize(huge) as string;
    expect(result).toBe(`${'q'.repeat(8180)}${REDACTED}${TRUNCATED}`);
    expect(result).not.toContain('AAAA');
  });

  it('stays fast on very large payloads (only the head of a string is redacted)', () => {
    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    const started = performance.now();
    log.info(
      { a: 'b'.repeat(5_000_000), list: Array.from({ length: 100_000 }, (_, i) => i) },
      'c'.repeat(1_000_000),
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.lines[0]?.length).toBeLessThan(20_000);
  });

  it('bounds collections and depth', () => {
    const limits = { maxFieldBytes: 1024, maxDepth: 3, maxCollectionItems: 2 };
    expect(sanitize([1, 2, 3, 4], limits)).toEqual([1, 2, `${TRUNCATED} 2 more items`]);
    expect(sanitize({ a: 1, b: 2, c: 3 }, limits)).toEqual({
      a: 1,
      b: 2,
      [TRUNCATED]: '1 more keys',
    });
    expect(sanitize({ l1: { l2: { l3: { l4: 1 } } } }, limits)).toEqual({
      l1: { l2: { l3: MAX_DEPTH } },
    });
  });
});

describe('circular references', () => {
  it('replaces a reference back to an ancestor with [Circular], and logs valid JSON', () => {
    const parent: Record<string, unknown> = { name: 'parent' };
    const child: Record<string, unknown> = { name: 'child', parent };
    parent.child = child;
    parent.self = parent;
    const list: unknown[] = [1];
    list.push(list);

    const out = capture();
    createLogger('t', { destination: out.destination }).info({ parent, list }, 'circular');
    expect(out.last()).toMatchObject({
      parent: { name: 'parent', child: { name: 'child', parent: CIRCULAR }, self: CIRCULAR },
      list: [1, CIRCULAR],
    });
  });

  it('keeps shared (non-circular) references', () => {
    const shared = { v: 1 };
    expect(sanitize({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('handles a circular error cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    const out = capture();
    createLogger('t', { destination: out.destination }).error(a);
    expect(out.last()).toMatchObject({
      err: { message: 'a', cause: { message: 'b', truncated: 'cycle' } },
    });
  });
});

describe('value types', () => {
  it('serialises special values without throwing', () => {
    const result = sanitize({
      big: 12n,
      sym: Symbol('s'),
      fn: () => 1,
      date: new Date(0),
      bad: new Date(Number.NaN),
      buf: Buffer.from('binary key material'),
      bytes: new Uint8Array(4),
      url: new URL('https://user:pw-url-0103@example.test/p?q=1'),
      re: /abc/g,
      nan: Number.NaN,
      undef: undefined,
      nil: null,
    });
    expect(result).toEqual({
      big: '12',
      sym: 'Symbol(s)',
      date: '1970-01-01T00:00:00.000Z',
      bad: 'Invalid Date',
      buf: '[Binary 19 bytes]',
      bytes: '[Binary 4 bytes]',
      url: `https://${REDACTED}@example.test/p?q=1`,
      re: '/abc/g',
      nan: Number.NaN,
      nil: null,
    });
  });

  it('survives throwing getters and hostile proxies', () => {
    const getter = Object.defineProperty({ ok: 1 }, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
        has() {
          throw new Error('has');
        },
      },
    );
    expect(sanitize(getter)).toEqual({ ok: 1, boom: UNSERIALIZABLE });
    expect(sanitize({ proxy })).toEqual({ proxy: UNSERIALIZABLE });
    expect(sanitizeRecord(proxy)).toEqual({ value: UNSERIALIZABLE });

    const out = capture();
    const log = createLogger('t', { destination: out.destination });
    expect(() => {
      log.info(proxy, 'hostile');
    }).not.toThrow();
    expect(() => {
      log.info({ getter }, 'getter');
    }).not.toThrow();
    expect(out.records()).toHaveLength(2);
  });

  it('uses toJSON when present', () => {
    expect(sanitize({ v: { toJSON: () => ({ shown: true }) } })).toEqual({ v: { shown: true } });
  });

  it('keeps a __proto__ key as a plain key and does not pollute prototypes', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as object;
    const result = sanitize(input) as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
