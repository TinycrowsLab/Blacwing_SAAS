import { describe, expect, it } from 'vitest';

import { dashboardSchema, runSchema, toSidebar } from './schemas';

const base = {
  actor: { id: 'u1', name: 'Avery', roles: ['admin'] },
  counts: { assets: 1, confirmedFindings: 0 },
};
const run = (id: string, state: string) => ({ id, requestId: 'q', state, createdAt: '2026-11-08T10:00:00.000Z' });

describe('sidebar slice', () => {
  it('uses the exact counts and the uncapped live list when the API sends them', () => {
    const slice = toSidebar(
      dashboardSchema.parse({
        ...base,
        runs: [run('a', 'running'), run('b', 'completed')],
        liveRuns: [run('a', 'running'), run('c', 'queued')],
        pendingCounts: { gate1: 3, gate2: 1, gate3: 56, keptBack: 7, live: 2 },
      }),
    );
    expect(slice.actorId).toBe('u1');
    expect(slice.counts).toEqual({ gate1: 3, gate2: 1, gate3: 56, live: 2 });
    expect(slice.live.map((r) => r.id)).toEqual(['a', 'c']);
    expect(slice.earlier.map((r) => r.id)).toEqual(['b']);
  });

  it('falls back to the capped lists for an older API', () => {
    const slice = toSidebar(dashboardSchema.parse({ ...base, runs: [run('a', 'paused'), run('b', 'killed')] }));
    expect(slice.counts).toBeNull();
    expect(slice.live.map((r) => r.id)).toEqual(['a']);
  });

  it('reads a run without the signing key id (the API stops sending it)', () => {
    const parsed = runSchema.parse({
      ...run('a', 'running'),
      budget: { requests: 10, seconds: 60 },
      pins: { authorisation: { saId: 's', signedBy: null } },
    });
    expect(parsed.pins.authorisation?.keyId).toBeUndefined();
    expect(parsed.queue).toBeNull();
    expect(parsed.startedBy).toBeNull();
  });
});
