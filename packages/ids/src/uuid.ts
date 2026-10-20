import { randomFillSync } from 'node:crypto';

import { IdValidationError } from './errors.js';
import {
  BYTE_BITS,
  BYTE_MASK,
  BYTE_VALUES,
  HEX_RADIX,
  NIBBLE_BITS,
  UUID_BYTES,
  UUID_TEXT_LENGTH,
  UUID_VARIANT_BYTE,
  UUID_VARIANT_RFC9562,
  UUID_VERSION_7,
  UUID_VERSION_BYTE,
} from './layout.js';

/**
 * A canonical, lowercase UUIDv7 string (`xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`).
 *
 * This is the value stored in Postgres `uuid` columns. It is a plain `string` at runtime, so it can be
 * passed straight to the database driver; the brand only records that it was validated.
 */
export type Uuid = string & { readonly __brand: 'Uuid' };

/** Options for {@link createUuidV7Generator}. Every option exists for tests; production uses the defaults. */
export interface UuidV7GeneratorOptions {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Fills a buffer with cryptographically secure random bytes. Defaults to `crypto.randomFillSync`. */
  readonly randomFill?: (buffer: Uint8Array) => void;
  /** Size in bytes of the random pool refilled in one call. Defaults to 4096; must be at least 16. */
  readonly poolSize?: number;
}

/** Generates monotonically increasing UUIDv7 values. */
export type UuidV7Generator = () => Uuid;

/** Width of the per-millisecond counter (RFC 9562 §6.2, method 1: 12 bits of `rand_a` + 30 of `rand_b`). */
const COUNTER_BITS = 42;
const COUNTER_MAX = 2 ** COUNTER_BITS - 1;
/** The counter is reseeded below 2^41 (leftmost bit zero), leaving at least 2^41 increments per millisecond. */
const SEED_SPACE = 2 ** (COUNTER_BITS - 1);
/** Counter bits stored in `rand_b` (after the variant bits); the other 12 sit in `rand_a`. */
const COUNTER_LOW_BITS = 30;
const COUNTER_LOW_SPACE = 2 ** COUNTER_LOW_BITS;
/** Width of `unix_ts_ms`, in bits and in bytes. */
const TIMESTAMP_BITS = 48;
const TIMESTAMP_BYTES = TIMESTAMP_BITS / BYTE_BITS;
/** Largest 48-bit `unix_ts_ms` (year 10889). */
const MAX_TIMESTAMP = 2 ** TIMESTAMP_BITS - 1;
/** Bytes drawn from the random pool: 6 per counter reseed, 4 per identifier. */
const SEED_BYTES = 6;
const TAIL_BYTES = 4;
/** The random tail fills the last bytes of `rand_b`. */
const TAIL_OFFSET = UUID_BYTES - TAIL_BYTES;
const DEFAULT_POOL_SIZE = 4096;
const MIN_POOL_SIZE = 16;
/** Shifts that select the second and third byte of a 32-bit value. */
const SHIFT_2_BYTES = 16;
const SHIFT_3_BYTES = 24;

const HEX: readonly string[] = Array.from({ length: BYTE_VALUES }, (_, i) =>
  i.toString(HEX_RADIX).padStart(2, '0'),
);
const HEX_OF = (byte: number): string => HEX[byte] ?? '00';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DASH = '-';
/** Byte offsets that start the 2nd to 5th dash-separated group (8-4-4-4-12 hex digits). */
const GROUP_2 = 4;
const GROUP_3 = 6;
const GROUP_4 = 8;
const GROUP_5 = 10;
const DASH_BEFORE_BYTE: ReadonlySet<number> = new Set([GROUP_2, GROUP_3, GROUP_4, GROUP_5]);
/** Text positions of the version digit and of the digit holding the variant bits. */
const VERSION_CHAR = 14;
const VARIANT_CHAR = 19;
/** `unix_ts_ms` is the first 12 hex digits: `xxxxxxxx-xxxx` (one dash). */
const TIMESTAMP_TEXT_END = 13;
/** Char codes of `0` and `9`. */
const CHAR_0 = 0x30;
const CHAR_9 = 0x39;
/** ASCII letters differ from their lowercase form only in this bit. */
const LOWERCASE_BIT = 0x20;
/** `'a'` minus 10, so that `a` maps to 10. */
const LETTER_OFFSET = 0x57;

/**
 * Creates an independent UUIDv7 generator (RFC 9562 §5.7).
 *
 * Layout: 48-bit Unix millisecond timestamp, version `0111`, 12 counter bits (`rand_a`), variant `10`,
 * 30 more counter bits and 32 random bits (`rand_b`).
 *
 * Monotonicity (RFC 9562 §6.2, method 1, fixed-length dedicated counter):
 * - a new millisecond reseeds the 42-bit counter with 41 random bits;
 * - the same millisecond, or a clock that went backwards, keeps the last timestamp and increments the
 *   counter, so values never decrease and never repeat within one generator;
 * - if the counter would overflow, the timestamp is advanced by one millisecond and the counter reseeded.
 *
 * Generation is allocation-light: randomness is drawn from a pooled buffer refilled in one call per
 * `poolSize` bytes, the identifier's bytes are assembled in one reused buffer, and the only per-call
 * allocation is the returned string.
 */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): UuidV7Generator {
  return createUuidV7GeneratorWithCounterLimit(options, COUNTER_MAX);
}

/**
 * Test hook (not exported from the package entry point): the same generator with a smaller counter
 * ceiling, so the overflow path can be exercised without 2^41 calls. `counterMax` must be an odd
 * value `2^k - 1` with `1 <= k <= 42`; the seed is drawn from the lower half `[0, (counterMax + 1) / 2)`.
 */
export function createUuidV7GeneratorWithCounterLimit(
  options: UuidV7GeneratorOptions,
  counterMax: number,
): UuidV7Generator {
  const bits = Math.log2(counterMax + 1);
  if (
    !Number.isSafeInteger(counterMax) ||
    !Number.isInteger(bits) ||
    bits < 1 ||
    bits > COUNTER_BITS
  ) {
    throw new RangeError('counterMax must be 2^k - 1 with 1 <= k <= 42');
  }
  const seedSpace = (counterMax + 1) / 2;
  const now = options.now ?? Date.now;
  const randomFill =
    options.randomFill ?? ((buffer: Uint8Array): void => void randomFillSync(buffer));
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  if (!Number.isSafeInteger(poolSize) || poolSize < MIN_POOL_SIZE) {
    throw new RangeError(`poolSize must be an integer >= ${MIN_POOL_SIZE}`);
  }

  const pool = new Uint8Array(poolSize);
  /** Bytes of the identifier being built; reused across calls. */
  const bytes = new Uint8Array(UUID_BYTES);
  let offset = poolSize;
  let lastMs = -1;
  let counter = 0;

  const take = (count: number): number => {
    if (offset + count > poolSize) {
      randomFill(pool);
      offset = 0;
    }
    const start = offset;
    offset += count;
    return start;
  };
  const byteAt = (index: number): number => pool[index] ?? 0;

  const reseed = (): void => {
    const o = take(SEED_BYTES);
    // 41 bits, big-endian: the low bit of the first byte, then 40 bits. Below 2^53, so exact.
    let seed = byteAt(o) & 1;
    for (let i = 1; i < SEED_BYTES; i += 1) seed = seed * BYTE_VALUES + byteAt(o + i);
    counter = seed % seedSpace;
  };

  return (): Uuid => {
    const raw = now();
    if (!Number.isFinite(raw) || raw < 0) {
      throw new RangeError('clock returned a non-finite or negative timestamp');
    }
    const ms = Math.trunc(raw);
    if (ms > lastMs) {
      lastMs = ms;
      reseed();
    } else {
      // Same millisecond or the clock went backwards: never go below the last timestamp.
      counter += 1;
      if (counter > counterMax) {
        lastMs += 1;
        reseed();
      }
    }
    if (lastMs > MAX_TIMESTAMP) {
      throw new RangeError('timestamp exceeds the 48-bit UUIDv7 range');
    }

    // Bytes 0-5: unix_ts_ms, big-endian.
    let ts = lastMs;
    for (let i = TIMESTAMP_BYTES - 1; i >= 0; i -= 1) {
      bytes[i] = ts % BYTE_VALUES;
      ts = Math.floor(ts / BYTE_VALUES);
    }
    // Bytes 6-7: version nibble, then the 12 high counter bits (rand_a).
    const counterHigh = Math.floor(counter / COUNTER_LOW_SPACE);
    bytes[UUID_VERSION_BYTE] = (UUID_VERSION_7 << NIBBLE_BITS) | (counterHigh >>> BYTE_BITS);
    bytes[UUID_VERSION_BYTE + 1] = counterHigh & BYTE_MASK;
    // Bytes 8-11: variant bits, then the 30 low counter bits (rand_b).
    const counterLow = counter % COUNTER_LOW_SPACE;
    bytes[UUID_VARIANT_BYTE] = UUID_VARIANT_RFC9562 | (counterLow >>> SHIFT_3_BYTES);
    bytes[UUID_VARIANT_BYTE + 1] = (counterLow >>> SHIFT_2_BYTES) & BYTE_MASK;
    bytes[UUID_VARIANT_BYTE + 2] = (counterLow >>> BYTE_BITS) & BYTE_MASK;
    bytes[TAIL_OFFSET - 1] = counterLow & BYTE_MASK;
    // Bytes 12-15: random tail (rand_b).
    const t = take(TAIL_BYTES);
    for (let i = 0; i < TAIL_BYTES; i += 1) bytes[TAIL_OFFSET + i] = byteAt(t + i);

    return formatUuidBytes(bytes) as Uuid;
  };
}

/** Exposed for tests: the counter seed space and overflow bound. */
export const UUIDV7_COUNTER = Object.freeze({
  bits: COUNTER_BITS,
  max: COUNTER_MAX,
  seedSpace: SEED_SPACE,
});

const processGenerator = createUuidV7Generator();

/**
 * Returns a new UUIDv7. Values from one process (one JS realm, so one worker thread) are strictly
 * increasing, which keeps B-tree index inserts local.
 */
export function newId(): Uuid {
  return processGenerator();
}

/** True for a canonical 8-4-4-4-12 hex UUID of any version (either case). */
function isUuidShape(value: string): boolean {
  return value.length === UUID_TEXT_LENGTH && UUID_PATTERN.test(value);
}

/** True for a version-7, RFC 9562-variant UUID string, in either case. */
export function isUuidV7(value: unknown): value is string {
  if (typeof value !== 'string' || !isUuidShape(value)) return false;
  const variant = value.charAt(VARIANT_CHAR).toLowerCase();
  return (
    value.charAt(VERSION_CHAR) === String(UUID_VERSION_7) &&
    (variant === '8' || variant === '9' || variant === 'a' || variant === 'b')
  );
}

/**
 * Validates a UUIDv7 string (either case, as Postgres and RFC 9562 allow) and returns it in canonical
 * lowercase form. Throws {@link IdValidationError} for anything else, including UUIDs of other versions.
 */
export function parseUuid(value: unknown): Uuid {
  if (typeof value !== 'string') {
    throw new IdValidationError('not_a_string', 'UUID must be a string');
  }
  if (!isUuidShape(value)) {
    throw new IdValidationError('invalid_uuid', 'UUID must be a canonical 8-4-4-4-12 hex string');
  }
  if (!isUuidV7(value)) {
    throw new IdValidationError('not_uuidv7', 'UUID must be version 7 with the RFC 9562 variant');
  }
  return value.toLowerCase() as Uuid;
}

/** The creation time (Unix milliseconds) embedded in a UUIDv7. */
export function uuidTimestamp(uuid: Uuid): number {
  return Number.parseInt(uuid.slice(0, TIMESTAMP_TEXT_END).replace(DASH, ''), HEX_RADIX);
}

/** Value of one hex digit given its char code (`0-9`, `a-f`, `A-F`); callers validate first. */
function hexDigit(code: number): number {
  if (code <= CHAR_9) return code - CHAR_0;
  return (code | LOWERCASE_BIT) - LETTER_OFFSET;
}

/** Writes the 16 bytes of a canonical UUID string into `out` (no validation; callers validate first). */
export function writeUuidBytes(uuid: string, out: Uint8Array): void {
  let byte = 0;
  for (let i = 0; i < UUID_TEXT_LENGTH; i += 2) {
    if (uuid.charAt(i) === DASH) i += 1;
    out[byte] = (hexDigit(uuid.charCodeAt(i)) << NIBBLE_BITS) | hexDigit(uuid.charCodeAt(i + 1));
    byte += 1;
  }
}

/** Formats 16 bytes as a canonical lowercase UUID string. */
export function formatUuidBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < UUID_BYTES; i += 1) {
    if (DASH_BEFORE_BYTE.has(i)) out += DASH;
    out += HEX_OF(bytes[i] ?? 0);
  }
  return out;
}
