/**
 * Crockford base32 for 128-bit values, as used in public-id bodies.
 *
 * - Alphabet `0123456789abcdefghjkmnpqrstvwxyz`: lowercase only, no padding. The ambiguous letters
 *   `i`, `l`, `o` and `u` are not part of it.
 * - 128 bits are encoded as 26 characters. The value is treated as a 130-bit big-endian number with
 *   two leading zero bits (the ULID convention), so the first character is always `0`-`7` and the
 *   encoding preserves byte order: sorting encoded strings sorts the underlying UUIDs.
 * - Decoding is strict. Crockford's lenient aliases (`i`/`l` for `1`, `o` for `0`) and uppercase are
 *   rejected so that every value has exactly one textual form.
 */

import { BYTE_BITS, BYTE_MASK, UUID_BYTES } from './layout.js';

/** The lowercase Crockford base32 alphabet. */
export const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Encoded length of 16 bytes. */
export const ENCODED_LENGTH = 26;

/** Bits per base32 symbol, and the mask selecting one symbol. */
const SYMBOL_BITS = 5;
const SYMBOL_MASK = 0x1f;
/** The first symbol carries two zero padding bits and three data bits, so it is at most 7. */
const FIRST_SYMBOL_BITS = 3;
const FIRST_SYMBOL_MAX = 0b111;
/** Every alphabet character is ASCII. */
const ASCII_LIMIT = 128;

/** Char code -> 5-bit value, or -1 for characters outside the strict lowercase alphabet. */
const DECODE = new Int8Array(ASCII_LIMIT).fill(-1);
for (let i = 0; i < CROCKFORD_ALPHABET.length; i += 1) {
  DECODE[CROCKFORD_ALPHABET.charCodeAt(i)] = i;
}

/** Outcome of {@link decodeBase32}: `null` on success, otherwise why the input was rejected. */
export type Base32DecodeError = 'invalid_length' | 'invalid_base32' | 'non_canonical';

/** Encodes exactly 16 bytes as 26 lowercase Crockford base32 characters. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 2; // two leading zero bits pad 128 to 130 = 26 * 5
  for (let i = 0; i < UUID_BYTES; i += 1) {
    acc = (acc << BYTE_BITS) | (bytes[i] ?? 0);
    bits += BYTE_BITS;
    while (bits >= SYMBOL_BITS) {
      bits -= SYMBOL_BITS;
      out += CROCKFORD_ALPHABET.charAt((acc >>> bits) & SYMBOL_MASK);
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Decodes 26 lowercase Crockford base32 characters into `out` (16 bytes).
 * Returns `null` on success or the reason the input was rejected; `out` is unspecified on failure.
 */
export function decodeBase32(text: string, out: Uint8Array): Base32DecodeError | null {
  if (text.length !== ENCODED_LENGTH) return 'invalid_length';
  let acc = 0;
  let bits = 0;
  let byte = 0;
  for (let i = 0; i < ENCODED_LENGTH; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < ASCII_LIMIT ? (DECODE[code] ?? -1) : -1;
    if (value < 0) return 'invalid_base32';
    if (i === 0) {
      // The first character carries the two padding bits, which must be zero.
      if (value > FIRST_SYMBOL_MAX) return 'non_canonical';
      acc = value;
      bits = FIRST_SYMBOL_BITS;
      continue;
    }
    acc = (acc << SYMBOL_BITS) | value;
    bits += SYMBOL_BITS;
    if (bits >= BYTE_BITS) {
      bits -= BYTE_BITS;
      out[byte] = (acc >>> bits) & BYTE_MASK;
      byte += 1;
      acc &= (1 << bits) - 1;
    }
  }
  return null;
}
