/**
 * Robust statistics for timing verdicts (VALIDATE-010). Medians and the median absolute deviation resist a single
 * outlier sample, so one slow response never decides a timing finding on its own.
 */

/** Median of a non-empty sample. Even-length samples take the mean of the two middle values. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
}

/** Arithmetic mean of a non-empty sample. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Median absolute deviation: the median distance from the sample median. A measure of jitter. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}
