// Halt-time derivation (KILL-007): the one function the worker and the API share.

import { describe, expect, it } from 'vitest';

import { computeKillHalt } from './kill.js';

const T = '2026-10-20T10:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(T) + ms).toISOString();
const open = {
  triggeredAt: T,
  egressBlockedAt: null,
  sandboxesTerminatedAt: null,
  keysRevokedAt: null,
  workflowsCancelledAt: null,
  completedAt: null,
};

describe('computeKillHalt', () => {
  it('derives haltMs and the consecutive per-stage breakdown for a completed kill', () => {
    expect(
      computeKillHalt({
        triggeredAt: T,
        egressBlockedAt: at(400),
        sandboxesTerminatedAt: at(3100),
        keysRevokedAt: at(3200),
        workflowsCancelledAt: at(3300),
        completedAt: at(3300),
      }),
    ).toEqual({
      haltMs: 3300,
      stages: { egressMs: 400, sandboxMs: 2700, keysMs: 100, workflowsMs: 100 },
      clamped: false,
    });
  });

  it('accepts Date inputs (worker rows)', () => {
    const t = new Date(T);
    expect(
      computeKillHalt({ ...open, triggeredAt: t, completedAt: new Date(t.getTime() + 5) }).haltMs,
    ).toBe(5);
  });

  it('returns null for a stage missing a bounding timestamp but still computes haltMs', () => {
    const r = computeKillHalt({
      ...open,
      egressBlockedAt: at(100),
      keysRevokedAt: at(900),
      workflowsCancelledAt: at(1000),
      completedAt: at(1000),
    });
    expect(r.haltMs).toBe(1000);
    expect(r.stages).toEqual({ egressMs: 100, sandboxMs: null, keysMs: null, workflowsMs: 100 });
  });

  it('has no haltMs while the kill is open', () => {
    expect(computeKillHalt(open).haltMs).toBeNull();
  });

  it('clamps negative deltas to 0 and flags the anomaly', () => {
    const r = computeKillHalt({ ...open, egressBlockedAt: at(-50), completedAt: at(-1) });
    expect(r.stages.egressMs).toBe(0);
    expect(r.haltMs).toBe(0);
    expect(r.clamped).toBe(true);
  });
});
