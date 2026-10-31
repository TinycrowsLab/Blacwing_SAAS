// Per-session virtual model keys (GATEWAY-002, #405, CONTEXT_PACK §4.1, §8.6, §8.7). A `bwk_` key is what a
// sandbox presents to the model gateway; it is never the provider credential. Only its SHA-256 and a short
// non-secret prefix are persisted, so a database read cannot replay a key.

import { createHash, randomBytes } from 'node:crypto';

/** Visible key prefix; the gateway rejects anything else before it hashes. */
export const VIRTUAL_KEY_PREFIX = 'bwk_';
/** A 256-bit value fits in 43 base62 digits (62^43 > 2^256), so every key body is exactly this long. */
export const VIRTUAL_KEY_BODY_LENGTH = 43;
/** Body characters kept in the stored, non-secret lookup prefix. */
const LOOKUP_BODY_CHARS = 8;
/** Stored, non-secret lookup prefix: the key prefix plus a few body characters. */
const VIRTUAL_KEY_LOOKUP_PREFIX_LENGTH = VIRTUAL_KEY_PREFIX.length + LOOKUP_BODY_CHARS;
/** Random bytes behind each key (256 bits). */
const VIRTUAL_KEY_ENTROPY_BYTES = 32;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62_RADIX = BigInt(BASE62.length);
const ZERO = BigInt(0);

/** Generates a new `bwk_<base62>` key from 256 bits of CSPRNG output. */
export function generateVirtualKey(): string {
  let value = BigInt(`0x${randomBytes(VIRTUAL_KEY_ENTROPY_BYTES).toString('hex')}`);
  let body = '';
  while (value > ZERO) {
    body = `${BASE62.charAt(Number(value % BASE62_RADIX))}${body}`;
    value /= BASE62_RADIX;
  }
  return `${VIRTUAL_KEY_PREFIX}${body.padStart(VIRTUAL_KEY_BODY_LENGTH, '0')}`;
}

/** SHA-256 of the full key text: the only form of a key that is ever persisted or compared. */
export function hashVirtualKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** The non-secret prefix stored next to the hash (for operators and logs; never a lookup credential alone). */
export function virtualKeyLookupPrefix(key: string): string {
  return key.slice(0, VIRTUAL_KEY_LOOKUP_PREFIX_LENGTH);
}
