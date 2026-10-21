import { describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createSaBoundsActivities, MAX_TIMER_MS } from './activities.js';
import { RUN_ID, SA_ID, TENANT } from './testing.js';

import type { RunEgressBlocker } from './ports.js';
import type { SaTimeBounds } from './types.js';

const ref = { tenantId: TENANT, runId: RUN_ID, saId: SA_ID };
const bounds: SaTimeBounds = {
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-06-01T12:00:00.000Z',
  testWindows: [],
};

function make(nowIso: string, egress?: RunEgressBlocker) {
  const latencies: number[] = [];
  const acts = createSaBoundsActivities({
    egress: egress ?? { blockRun: () => Promise.resolve('already_blocked') },
    sessions: {
      cancel: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    },
    runs: {
      expire: () => Promise.resolve(),
      windowClosed: () => Promise.resolve('ignored'),
      windowReopened: () => Promise.resolve('ignored'),
    },
    audit: { emit: () => Promise.resolve() },
    metrics: {
      saExpiry: () => undefined,
      windowTransition: () => undefined,
      egressBlockLatency: (s) => latencies.push(s),
    },
    log: createLogger('sa-bounds-activities-test', { level: 'silent' }),
    now: () => new Date(nowIso),
  });
  return { acts, latencies };
}

describe('evaluateTimeline', () => {
  it('waits exactly until expiry when that is the next boundary', async () => {
    const { acts } = make('2026-06-01T11:00:00.000Z');
    const step = await acts.evaluateTimeline({ ...bounds, ...ref });
    expect(step.waitMs).toBe(3_600_000);
    expect(step.timeline.phase).toBe('open');
  });

  it('caps a long wait and floors an immediate one at 1 ms', async () => {
    const far = make('2026-02-01T00:00:00.000Z');
    expect((await far.acts.evaluateTimeline({ ...bounds, ...ref })).waitMs).toBe(MAX_TIMER_MS);
    const past = make('2026-06-02T00:00:00.000Z');
    expect((await past.acts.evaluateTimeline({ ...bounds, ...ref })).waitMs).toBe(1);
  });
});

describe('blockEgress', () => {
  it('reports the expiry-to-block latency in seconds', async () => {
    const { acts, latencies } = make('2026-06-01T12:00:00.750Z');
    const result = await acts.blockEgress({
      ...ref,
      reason: 'sa_expired',
      triggerAt: '2026-06-01T12:00:00.000Z',
    });
    expect(result).toEqual({ outcome: 'already_blocked', latencyMs: 750 });
    expect(latencies).toEqual([0.75]);
  });

  it('rethrows a gateway failure so Temporal retries, and records no latency', async () => {
    const { acts, latencies } = make('2026-06-01T12:00:01.000Z', {
      blockRun: () => Promise.reject(new Error('503')),
    });
    await expect(
      acts.blockEgress({ ...ref, reason: 'sa_expired', triggerAt: '2026-06-01T12:00:00.000Z' }),
    ).rejects.toThrow('503');
    expect(latencies).toEqual([]);
  });

  it('passes an abort signal so a hung gateway cannot hold the stop', async () => {
    let signal: AbortSignal | undefined;
    const { acts } = make('2026-06-01T12:00:01.000Z', {
      blockRun: (_input, s) => {
        signal = s;
        return Promise.resolve('blocked');
      },
    });
    await acts.blockEgress({ ...ref, reason: 'sa_revoked', triggerAt: '2026-06-01T12:00:00.000Z' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
