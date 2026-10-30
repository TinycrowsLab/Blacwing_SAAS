import { describe, expect, it } from 'vitest';

import { runSaExpiry } from './sequence.js';
import {
  DEFAULT_SA_EXPIRY_SWEEP_S,
  SA_EXPIRY_MAX_TIMER_MS,
  type SaExpiryActivities,
  type SaExpiryInput,
  type SaExpiryOutcome,
} from './types.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';
const SA = '0190a000-0000-7000-8000-0000000000c1';
const INPUT: SaExpiryInput = { tenantId: TENANT, saId: SA };

/** Scripted activity: returns the queued outcomes in order, then keeps returning the last one. */
function scripted(outcomes: readonly SaExpiryOutcome[]): {
  acts: SaExpiryActivities;
  calls: number;
} {
  const state = { calls: 0 };
  const acts: SaExpiryActivities = {
    checkAndExpire: () => {
      const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)];
      state.calls += 1;
      if (outcome === undefined) throw new Error('no scripted outcome');
      return Promise.resolve(outcome);
    },
  };
  return {
    acts,
    get calls() {
      return state.calls;
    },
  };
}

describe('runSaExpiry (AUTHZ-010)', () => {
  it('expires an SA that is already due in one check without sleeping', async () => {
    const script = scripted([{ kind: 'expired' }]);
    const sleeps: number[] = [];
    const result = await runSaExpiry(INPUT, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toBe('expired');
    expect(script.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('ends at once when the SA is no longer active (idempotent re-run)', async () => {
    const script = scripted([{ kind: 'terminal' }]);
    const result = await runSaExpiry(INPUT, script.acts, { sleep: () => Promise.resolve() });
    expect(result).toBe('terminal');
    expect(script.calls).toBe(1);
  });

  it('waits the database-reported remaining time when it is shorter than the sweep interval', async () => {
    const script = scripted([{ kind: 'not_due', remainingMs: 5_000 }, { kind: 'expired' }]);
    const sleeps: number[] = [];
    await runSaExpiry(INPUT, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([5_000]);
    expect(script.calls).toBe(2);
  });

  it('never waits longer than one sweep interval, so a lost timer is caught within one interval', async () => {
    const script = scripted([
      { kind: 'not_due', remainingMs: 10 * 60_000 },
      { kind: 'not_due', remainingMs: 10 * 60_000 },
      { kind: 'expired' },
    ]);
    const sleeps: number[] = [];
    await runSaExpiry(INPUT, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([DEFAULT_SA_EXPIRY_SWEEP_S * 1_000, DEFAULT_SA_EXPIRY_SWEEP_S * 1_000]);
  });

  it('honours a configured sweep interval', async () => {
    const script = scripted([{ kind: 'not_due', remainingMs: 600_000 }, { kind: 'expired' }]);
    const sleeps: number[] = [];
    await runSaExpiry({ ...INPUT, sweepIntervalS: 15 }, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([15_000]);
  });

  it('caps any single wait at the Temporal timer bound, even for a huge sweep interval', async () => {
    const script = scripted([
      { kind: 'not_due', remainingMs: Number.MAX_SAFE_INTEGER },
      { kind: 'expired' },
    ]);
    const sleeps: number[] = [];
    await runSaExpiry({ ...INPUT, sweepIntervalS: 10 * 365 * 86_400 }, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([SA_EXPIRY_MAX_TIMER_MS]);
  });

  it('never sleeps for zero or negative remaining time (no busy loop)', async () => {
    const script = scripted([{ kind: 'not_due', remainingMs: 0 }, { kind: 'expired' }]);
    const sleeps: number[] = [];
    await runSaExpiry(INPUT, script.acts, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([1]);
  });

  it('propagates an activity failure so Temporal retries it instead of silently ending', async () => {
    const acts: SaExpiryActivities = {
      checkAndExpire: () => Promise.reject(new Error('database unavailable')),
    };
    await expect(runSaExpiry(INPUT, acts, { sleep: () => Promise.resolve() })).rejects.toThrow(
      'database unavailable',
    );
  });
});
