const BASE_MS = 1_000;
const CAP_MS = 300_000;
const MIN_JITTER = 0.5;
/** Keeps `2 ** exponent` finite and exact long before the cap applies. */
const MAX_EXPONENT = 30;

/**
 * Delay before retry after `attempts` failed deliveries (1-based): exponential from 1 s, capped at
 * 5 min, with jitter in [50%, 100%] so a recovering destination is not hit by every row at once.
 * `random` is injectable for tests.
 */
export function outboxBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, MAX_EXPONENT);
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** exponent);
  return Math.floor(ceiling * (MIN_JITTER + (1 - MIN_JITTER) * random()));
}
