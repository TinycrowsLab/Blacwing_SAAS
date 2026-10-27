import { describe, expect, it } from 'vitest';

import { outboxBackoffMs } from './backoff.js';

describe('outboxBackoffMs', () => {
  it('doubles from one second, with the jitter at its top (random = 1)', () => {
    expect([1, 2, 3, 4, 5].map((n) => outboxBackoffMs(n, () => 1))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('keeps at least half of the delay (random = 0)', () => {
    expect(outboxBackoffMs(1, () => 0)).toBe(500);
    expect(outboxBackoffMs(4, () => 0)).toBe(4_000);
  });

  it('is capped at five minutes however many attempts failed', () => {
    expect(outboxBackoffMs(12, () => 1)).toBe(300_000);
    expect(outboxBackoffMs(1_000, () => 1)).toBe(300_000);
  });

  it('treats a nonsensical attempt count as the first retry', () => {
    expect(outboxBackoffMs(0, () => 1)).toBe(1_000);
    expect(outboxBackoffMs(-3, () => 1)).toBe(1_000);
  });

  it('never leaves [50%, 100%] of the exponential ceiling', () => {
    for (let n = 1; n <= 20; n += 1) {
      const ceiling = Math.min(300_000, 1_000 * 2 ** (n - 1));
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const delay = outboxBackoffMs(n, () => r);
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});
