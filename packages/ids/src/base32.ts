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

/** The lowercase Crockford base32 alphabet. */
export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Encoded length of 16 bytes. */
export const ENCODED_LENGTH = 26;

/** Char code -> 5-bit value, or -1 for characters outside the strict lowercase alphabet. */
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < CROCKFORD_ALPHABET.length; i += 1) {
  DECODE[CROCKFORD_ALPHABET.charCodeAt(i)] = i;
}

/** Outcome of {@link decodeBase32}: `null` on success, otherwise why the input was rejected. */
export type Base32DecodeError = "invalid_length" | "invalid_base32" | "non_canonical";

/** Encodes exactly 16 bytes as 26 lowercase Crockford base32 characters. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 2; // two leading zero bits pad 128 to 130 = 26 * 5
  for (let i = 0; i < 16; i += 1) {
    acc = (acc << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET.charAt((acc >>> bits) & 31);
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
  if (text.length !== ENCODED_LENGTH) return "invalid_length";
  let acc = 0;
  let bits = 0;
  let byte = 0;
  for (let i = 0; i < ENCODED_LENGTH; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (DECODE[code] ?? -1) : -1;
    if (value < 0) return "invalid_base32";
    if (i === 0) {
      // The first character carries the two padding bits, which must be zero.
      if (value > 7) return "non_canonical";
      acc = value;
      bits = 3;
      continue;
    }
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[byte] = (acc >>> bits) & 0xff;
      byte += 1;
      acc &= (1 << bits) - 1;
    }
  }
  return null;
}
