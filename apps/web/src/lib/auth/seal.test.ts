import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveKey, KEY_BYTES, open, seal } from './seal.js';

const key = randomBytes(KEY_BYTES);
const NOW = 1_700_000_000_000;

describe('deriveKey', () => {
  it('derives a stable 32-byte key per secret', () => {
    expect(deriveKey('s'.repeat(32))).toHaveLength(KEY_BYTES);
    expect(deriveKey('s'.repeat(32)).equals(deriveKey('s'.repeat(32)))).toBe(true);
    expect(deriveKey('s'.repeat(32)).equals(deriveKey('t'.repeat(32)))).toBe(false);
  });
});

describe('seal / open', () => {
  it('round-trips a payload until it expires', () => {
    const sealed = seal(key, 'p', { sid: 'abc' }, 1000, NOW);
    expect(open([key], 'p', sealed, NOW + 999)).toEqual({ sid: 'abc' });
    expect(open([key], 'p', sealed, NOW + 1000)).toBeNull();
  });

  it('does not contain the payload in clear and is different every time', () => {
    const a = seal(key, 'p', { sid: 'plain-marker' }, 1000, NOW);
    const b = seal(key, 'p', { sid: 'plain-marker' }, 1000, NOW);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').toString('utf8')).not.toContain('plain-marker');
  });

  it('refuses another purpose, another key, tampering and garbage', () => {
    const sealed = seal(key, 'login', { x: 1 }, 1000, NOW);
    expect(open([key], 'session', sealed, NOW)).toBeNull();
    expect(open([randomBytes(KEY_BYTES)], 'login', sealed, NOW)).toBeNull();
    const raw = Buffer.from(sealed, 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(open([key], 'login', raw.toString('base64url'), NOW)).toBeNull();
    for (const junk of ['', 'abc', 'not base64 !!', 'A'.repeat(10)]) {
      expect(open([key], 'login', junk, NOW)).toBeNull();
    }
  });

  it('opens with a previous key but always seals with the first', () => {
    const previous = randomBytes(KEY_BYTES);
    const oldSealed = seal(previous, 'p', { n: 1 }, 1000, NOW);
    expect(open([key, previous], 'p', oldSealed, NOW)).toEqual({ n: 1 });
    expect(open([key], 'p', oldSealed, NOW)).toBeNull();
  });
});
