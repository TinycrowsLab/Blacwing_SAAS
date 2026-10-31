import { describe, expect, it } from 'vitest';

import {
  generateVirtualKey,
  hashVirtualKey,
  VIRTUAL_KEY_BODY_LENGTH,
  VIRTUAL_KEY_PREFIX,
  virtualKeyLookupPrefix,
} from './virtual-key.js';

const KEY_SHAPE = /^bwk_[0-9A-Za-z]{43}$/;

describe('generateVirtualKey', () => {
  it('produces bwk_ followed by a 43-character base62 body (256 bits)', () => {
    for (let i = 0; i < 200; i += 1) {
      const key = generateVirtualKey();
      expect(key).toMatch(KEY_SHAPE);
      expect(key.startsWith(VIRTUAL_KEY_PREFIX)).toBe(true);
      expect(key.length - VIRTUAL_KEY_PREFIX.length).toBe(VIRTUAL_KEY_BODY_LENGTH);
    }
  });

  it('never repeats across a large sample', () => {
    const keys = new Set(Array.from({ length: 2_000 }, () => generateVirtualKey()));
    expect(keys.size).toBe(2_000);
  });
});

describe('hashVirtualKey', () => {
  it('is a 32-byte SHA-256 of the full key text, deterministic and key-specific', () => {
    const key = generateVirtualKey();
    expect(hashVirtualKey(key)).toHaveLength(32);
    expect(hashVirtualKey(key).equals(hashVirtualKey(key))).toBe(true);
    expect(hashVirtualKey(key).equals(hashVirtualKey(generateVirtualKey()))).toBe(false);
  });

  it('matches the published SHA-256 test vector for a fixed key', () => {
    const fixed = 'bwk_0000000000000000000000000000000000000000000';
    expect(hashVirtualKey(fixed).toString('hex')).toBe(
      '66e4202491a1d8436c5ee6cf51926e215dfe6da49eeccfaa91d4f06bea52eddb',
    );
  });
});

describe('virtualKeyLookupPrefix', () => {
  it('is the bwk_ prefix plus 8 body characters, never the whole key', () => {
    const key = generateVirtualKey();
    const prefix = virtualKeyLookupPrefix(key);
    expect(prefix).toHaveLength(12);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix).not.toBe(key);
  });
});
