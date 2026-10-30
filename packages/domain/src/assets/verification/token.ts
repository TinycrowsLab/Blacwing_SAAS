import { randomBytes } from 'node:crypto';

import { VERIFICATION_TOKEN_BYTES, VERIFICATION_TOKEN_PREFIX } from '@blackwing/contracts';

/**
 * Verification tokens (ASSET-003, CONTEXT_PACK §8.10). A token is the only proof a probe accepts, so it comes from a
 * CSPRNG and is never guessable: the owner must place it where only the domain owner can write.
 */

/** RFC 4648 base32 alphabet (no padding). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_BYTE = 8;
const BITS_PER_CHARACTER = 5;
/** Leftover bits of the previous byte (at most 4) plus one byte: the widest the buffer gets is 12 bits. */
const BUFFER_MASK = (1 << (BITS_PER_BYTE + BITS_PER_CHARACTER - 1)) - 1;
const CHARACTER_MASK = (1 << BITS_PER_CHARACTER) - 1;

/** RFC 4648 base32 encoding without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let buffer = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = ((buffer << BITS_PER_BYTE) | byte) & BUFFER_MASK;
    bitCount += BITS_PER_BYTE;
    while (bitCount >= BITS_PER_CHARACTER) {
      bitCount -= BITS_PER_CHARACTER;
      out += BASE32_ALPHABET.charAt((buffer >> bitCount) & CHARACTER_MASK);
    }
  }
  if (bitCount > 0)
    out += BASE32_ALPHABET.charAt((buffer << (BITS_PER_CHARACTER - bitCount)) & CHARACTER_MASK);
  return out;
}

/**
 * A new token: `blackwing-site-verification=<base32 of 32 random bytes>`. `random` is the entropy source; the
 * default is `crypto.randomBytes`, injectable so tests can pin the output.
 */
export function newVerificationToken(random: (size: number) => Uint8Array = randomBytes): string {
  return `${VERIFICATION_TOKEN_PREFIX}${base32Encode(random(VERIFICATION_TOKEN_BYTES))}`;
}
