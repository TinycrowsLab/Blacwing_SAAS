/**
 * Byte-level constants shared by the UUID, base32 and public-id code (internal; not exported from the
 * package entry point).
 */

/** Bits in one byte. */
export const BYTE_BITS = 8;
/** Mask selecting the low byte of an integer. */
export const BYTE_MASK = 0xff;
/** Distinct values of one byte (2^8). */
export const BYTE_VALUES = 256;
/** Bits in one hex digit. */
export const NIBBLE_BITS = 4;
/** Radix of hexadecimal text. */
export const HEX_RADIX = 16;

/** A UUID is 128 bits: 16 bytes. */
export const UUID_BYTES = 16;
/** Length of the canonical 8-4-4-4-12 text form. */
export const UUID_TEXT_LENGTH = 36;

/** RFC 9562 layout: the version nibble is the high half of byte 6, the variant the top bits of byte 8. */
export const UUID_VERSION_BYTE = 6;
export const UUID_VARIANT_BYTE = 8;
/** UUIDv7 version nibble (`0111`). */
export const UUID_VERSION_7 = 7;
/** Mask of the two variant bits, and their RFC 9562 value `10`. */
export const UUID_VARIANT_MASK = 0xc0;
export const UUID_VARIANT_RFC9562 = 0x80;
