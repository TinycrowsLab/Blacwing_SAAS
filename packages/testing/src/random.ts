/**
 * Seeded, deterministic pseudo-random numbers for test data (sfc32, seeded through splitmix32).
 *
 * Not cryptographically secure, and never used for anything but fixtures: production randomness comes
 * from `node:crypto` (`@blackwing/ids`, `@blackwing/crypto`).
 */
export interface SeededRandom {
  /** The seed this generator started from. */
  readonly seed: number;
  /** Next unsigned 32-bit integer. */
  uint32(): number;
  /** Integer in `[min, max]` (inclusive). */
  int(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(values: readonly [T, ...T[]]): T;
  /** Fills `buffer` with pseudo-random bytes (the shape `createUuidV7Generator` expects). */
  fill(buffer: Uint8Array): void;
  /** `length` lowercase hex characters. */
  hex(length: number): string;
}

/** splitmix32 constants (golden-ratio increment and the murmur3 finaliser). */
const SPLITMIX = Object.freeze({
  increment: 0x9e_37_79_b9,
  mul1: 0x85_eb_ca_6b,
  mul2: 0xc2_b2_ae_35,
  shift1: 16,
  shift2: 13,
});
/** sfc32 rotation and shift amounts (reference implementation). */
const SFC32 = Object.freeze({ rshift: 9, lshift: 3, rotate: 21, rotateBack: 11, warmup: 12 });
const UINT32_RANGE = 4_294_967_296; // 2^32
const BYTE_MASK = 0xff;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_UINT32 = 8;

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + SPLITMIX.increment) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> SPLITMIX.shift1), SPLITMIX.mul1);
    z = Math.imul(z ^ (z >>> SPLITMIX.shift2), SPLITMIX.mul2);
    return (z ^ (z >>> SPLITMIX.shift1)) >>> 0;
  };
}

/** Creates a generator; equal seeds always yield equal sequences. */
export function createSeededRandom(seed: number): SeededRandom {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError('seed must be a safe integer');
  }
  const init = splitmix32((seed >>> 0) ^ Math.floor(seed / UINT32_RANGE));
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  const uint32 = (): number => {
    // sfc32 (Chris Doty-Humphrey's Small Fast Counting RNG).
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> SFC32.rshift);
    b = (c + (c << SFC32.lshift)) >>> 0;
    c = (c << SFC32.rotate) | (c >>> SFC32.rotateBack);
    c = (c + t) >>> 0;
    return t;
  };
  // Discard the first outputs, as sfc32's reference implementation recommends.
  for (let i = 0; i < SFC32.warmup; i += 1) uint32();

  const int = (min: number, max: number): number => {
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      max < min ||
      max - min >= UINT32_RANGE
    ) {
      throw new RangeError('int(min, max) needs safe integers with 0 <= max - min < 2^32');
    }
    return min + (uint32() % (max - min + 1));
  };

  return {
    seed,
    uint32,
    int,
    pick: <T>(values: readonly [T, ...T[]]): T => values[int(0, values.length - 1)] ?? values[0],
    fill: (buffer: Uint8Array): void => {
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = uint32() & BYTE_MASK;
    },
    hex: (length: number): string => {
      let out = '';
      while (out.length < length)
        out += uint32().toString(HEX_RADIX).padStart(HEX_DIGITS_PER_UINT32, '0');
      return out.slice(0, length);
    },
  };
}
