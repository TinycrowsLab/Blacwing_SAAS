import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CROCKFORD_ALPHABET, decodeBase32, ENCODED_LENGTH, encodeBase32 } from './base32.js';

/** Independent oracle: big-integer base32 of a 16-byte value, 26 digits, most significant first. */
function oracleEncode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < ENCODED_LENGTH; i += 1) {
    out = CROCKFORD_ALPHABET.charAt(Number(n & 31n)) + out;
    n >>= 5n;
  }
  return out;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });

describe('Crockford base32', () => {
  it('uses the lowercase Crockford alphabet without i, l, o, u', () => {
    expect(CROCKFORD_ALPHABET).toBe('0123456789abcdefghjkmnpqrstvwxyz');
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const ambiguous of ['i', 'l', 'o', 'u'])
      expect(CROCKFORD_ALPHABET).not.toContain(ambiguous);
    expect(CROCKFORD_ALPHABET).toBe(CROCKFORD_ALPHABET.toLowerCase());
  });

  it.each([
    // RFC 9562 Appendix A.6 example UUIDv7.
    ['017f22e279b07cc398c4dc0c0c07398f', '01fwhe4ydgfk1shh6w1g60eecf'],
    ['00000000000000000000000000000000', '00000000000000000000000000'],
    ['ffffffffffffffffffffffffffffffff', '7zzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['ffffffffffff7fffbfffffffffffffff', '7zzzzzzzzzfzzvzzzzzzzzzzzz'],
  ])('encodes known vector %s', (hex, encoded) => {
    const bytes = hexBytes(hex);
    expect(encodeBase32(bytes)).toBe(encoded);
    const out = new Uint8Array(16);
    expect(decodeBase32(encoded, out)).toBeNull();
    expect(out).toEqual(bytes);
  });

  it('property: matches a big-integer oracle and has no padding', () => {
    fc.assert(
      fc.property(bytes16, (bytes) => {
        const encoded = encodeBase32(bytes);
        expect(encoded).toBe(oracleEncode(bytes));
        expect(encoded).toHaveLength(ENCODED_LENGTH);
        expect(encoded).not.toContain('=');
        expect(encoded.charAt(0) <= '7').toBe(true);
      }),
    );
  });

  it('property: decode(encode(b)) === b', () => {
    fc.assert(
      fc.property(bytes16, (bytes) => {
        const out = new Uint8Array(16);
        expect(decodeBase32(encodeBase32(bytes), out)).toBeNull();
        expect(out).toEqual(bytes);
      }),
    );
  });

  it('property: preserves byte order (sorting encodings sorts values)', () => {
    fc.assert(
      fc.property(bytes16, bytes16, (a, b) => {
        const byteOrder = Buffer.compare(Buffer.from(a), Buffer.from(b));
        const ea = encodeBase32(a);
        const eb = encodeBase32(b);
        const textOrder = ea < eb ? -1 : ea > eb ? 1 : 0;
        expect(textOrder).toBe(byteOrder);
      }),
    );
  });

  describe('strict decoding', () => {
    const valid = '01fwhe4ydgfk1shh6w1g60eecf';
    const out = new Uint8Array(16);

    it.each(['i', 'l', 'o', 'u'])('rejects the ambiguous letter %s', (letter) => {
      expect(decodeBase32(`${valid.slice(0, 10)}${letter}${valid.slice(11)}`, out)).toBe(
        'invalid_base32',
      );
    });

    it('rejects uppercase and mixed case', () => {
      expect(decodeBase32(valid.toUpperCase(), out)).toBe('invalid_base32');
      expect(decodeBase32(`${valid.slice(0, 5)}W${valid.slice(6)}`, out)).toBe('invalid_base32');
    });

    it.each([
      ['padding', `${valid.slice(0, 25)}=`],
      ['hyphen', `${valid.slice(0, 25)}-`],
      ['space', `${valid.slice(0, 25)} `],
      ['non-ASCII', `${valid.slice(0, 25)}é`],
      ['fullwidth digit', `${valid.slice(0, 25)}０`],
    ])('rejects %s characters', (_label, text) => {
      expect(decodeBase32(text, out)).toBe('invalid_base32');
    });

    it.each([
      ['empty', ''],
      ['too short', valid.slice(1)],
      ['too long', `${valid}0`],
    ])('rejects a %s body', (_label, text) => {
      expect(decodeBase32(text, out)).toBe('invalid_length');
    });

    it('rejects a first character above 7 (value would exceed 128 bits)', () => {
      for (const first of '89abcdefghjkmnpqrstvwxyz') {
        expect(decodeBase32(`${first}${valid.slice(1)}`, out)).toBe('non_canonical');
      }
      expect(decodeBase32(`7${valid.slice(1)}`, out)).toBeNull();
    });

    it('property: every accepted 26-char string re-encodes to itself (one textual form per value)', () => {
      const char = fc.constantFrom(...CROCKFORD_ALPHABET.split(''));
      const head = fc.constantFrom(...'01234567'.split(''));
      fc.assert(
        fc.property(head, fc.array(char, { minLength: 25, maxLength: 25 }), (first, rest) => {
          const text = first + rest.join('');
          const decoded = new Uint8Array(16);
          expect(decodeBase32(text, decoded)).toBeNull();
          expect(encodeBase32(decoded)).toBe(text);
        }),
      );
    });
  });
});
