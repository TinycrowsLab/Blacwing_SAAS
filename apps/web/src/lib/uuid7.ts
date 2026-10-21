const UUID_BYTES = 16;
const TIME_LOW_BYTES = 4;
const TIMESTAMP_BYTES = 6;
const BYTE_RADIX = 256;
const HEX_RADIX = 16;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const LOW_NIBBLE_MASK = 0x0f;
const VERSION_7_BITS = 0x70;
const LOW_SIX_BITS_MASK = 0x3f;
const VARIANT_BITS = 0x80;
/** Bytes per dash-separated group of the canonical text form. */
const GROUP_BYTES = [TIME_LOW_BYTES, 2, 2, 2, TIMESTAMP_BYTES] as const;

/**
 * A fresh UUIDv7 (RFC 9562) from the Web Crypto CSPRNG. The browser cannot use `@blackwing/ids` (it reads
 * `node:crypto`), so this is the small client-side generator used for `Idempotency-Key` values.
 */
export function uuidV7(now: () => number = Date.now): string {
  const bytes = new Uint8Array(UUID_BYTES);
  crypto.getRandomValues(bytes);
  let timestamp = now();
  for (let index = TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = timestamp % BYTE_RADIX;
    timestamp = Math.floor(timestamp / BYTE_RADIX);
  }
  bytes[VERSION_BYTE] = ((bytes[VERSION_BYTE] ?? 0) & LOW_NIBBLE_MASK) | VERSION_7_BITS;
  bytes[VARIANT_BYTE] = ((bytes[VARIANT_BYTE] ?? 0) & LOW_SIX_BITS_MASK) | VARIANT_BITS;
  const hex = Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(2, '0')).join('');
  const groups: string[] = [];
  let offset = 0;
  for (const size of GROUP_BYTES) {
    groups.push(hex.slice(offset, offset + size * 2));
    offset += size * 2;
  }
  return groups.join('-');
}
