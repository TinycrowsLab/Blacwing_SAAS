import { describe, expect, it, vi } from 'vitest';

import { createSaExpiryActivities } from './activities.js';

import type { SaExpiryMetrics, SaExpiryStore } from './ports.js';
import type { SaExpiryOutcome } from './types.js';
import type { Logger } from '@blackwing/logger';

const REF = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  saId: '0190a000-0000-7000-8000-0000000000c1',
};

function harness(outcome: SaExpiryOutcome): {
  expired: number;
  store: SaExpiryStore;
  metrics: SaExpiryMetrics;
  log: Logger;
  checkAndExpire: ReturnType<typeof vi.fn>;
} {
  const checkAndExpire = vi.fn(() => Promise.resolve(outcome));
  const state = { expired: 0 };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return {
    get expired() {
      return state.expired;
    },
    store: { checkAndExpire },
    metrics: {
      expired: () => {
        state.expired += 1;
      },
    },
    log,
    checkAndExpire,
  };
}

describe('createSaExpiryActivities', () => {
  it('counts and logs exactly once when the SA is expired', async () => {
    const h = harness({ kind: 'expired' });
    const acts = createSaExpiryActivities({ store: h.store, metrics: h.metrics, log: h.log });
    await expect(acts.checkAndExpire(REF)).resolves.toEqual({ kind: 'expired' });
    expect(h.expired).toBe(1);
  });

  it('does not count a not-due or terminal check (the metric counts expiries only)', async () => {
    for (const outcome of [
      { kind: 'not_due', remainingMs: 1_000 },
      { kind: 'terminal' },
    ] as const) {
      const h = harness(outcome);
      const acts = createSaExpiryActivities({ store: h.store, metrics: h.metrics, log: h.log });
      await expect(acts.checkAndExpire(REF)).resolves.toEqual(outcome);
      expect(h.expired).toBe(0);
    }
  });

  it('passes only the tenant and SA ids to the store (no other input is trusted)', async () => {
    const h = harness({ kind: 'terminal' });
    const acts = createSaExpiryActivities({ store: h.store, metrics: h.metrics, log: h.log });
    await acts.checkAndExpire(REF);
    expect(h.checkAndExpire).toHaveBeenCalledWith(REF);
  });

  it('propagates a store failure so Temporal retries', async () => {
    const store: SaExpiryStore = { checkAndExpire: () => Promise.reject(new Error('db down')) };
    const h = harness({ kind: 'terminal' });
    const acts = createSaExpiryActivities({ store, metrics: h.metrics, log: h.log });
    await expect(acts.checkAndExpire(REF)).rejects.toThrow('db down');
    expect(h.expired).toBe(0);
  });
});
