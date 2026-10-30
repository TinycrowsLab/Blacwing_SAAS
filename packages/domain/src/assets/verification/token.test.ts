import { describe, expect, it } from 'vitest';

import { VERIFICATION_TOKEN_MIN_LENGTH, VERIFICATION_TOKEN_PREFIX } from '@blackwing/contracts';

import { base32Encode, newVerificationToken } from './token.js';

describe('base32Encode', () => {
  it('matches the RFC 4648 test vectors (no padding)', () => {
    const enc = (text: string) => base32Encode(new TextEncoder().encode(text));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('MY');
    expect(enc('fo')).toBe('MZXQ');
    expect(enc('foo')).toBe('MZXW6');
    expect(enc('foob')).toBe('MZXW6YQ');
    expect(enc('fooba')).toBe('MZXW6YTB');
    expect(enc('foobar')).toBe('MZXW6YTBOI');
  });

  it('encodes 32 bytes to 52 characters from the base32 alphabet', () => {
    const encoded = base32Encode(new Uint8Array(32).fill(0xff));
    expect(encoded).toHaveLength(52);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('newVerificationToken', () => {
  it('is the prefix followed by base32 of the random bytes it was given', () => {
    const token = newVerificationToken(() => new Uint8Array(32).fill(0));
    expect(token).toBe(`${VERIFICATION_TOKEN_PREFIX}${'A'.repeat(52)}`);
  });

  it('meets the table length floor and never repeats with the real CSPRNG', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const token = newVerificationToken();
      expect(token.startsWith(VERIFICATION_TOKEN_PREFIX)).toBe(true);
      expect(token.length).toBeGreaterThanOrEqual(VERIFICATION_TOKEN_MIN_LENGTH);
      seen.add(token);
    }
    expect(seen.size).toBe(500);
  });

  it('draws exactly 32 bytes from the entropy source', () => {
    let requested = -1;
    newVerificationToken((size) => {
      requested = size;
      return new Uint8Array(size);
    });
    expect(requested).toBe(32);
  });
});
