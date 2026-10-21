import { describe, expect, it } from 'vitest';

import { createKillActivities, type KillActivityDeps } from './activities.js';
import {
  ackAll,
  ackSandboxes,
  FakeGateway,
  FakeSandboxController,
  KILL_ID,
  makeDeps,
  MemoryKillRepo,
  T0,
  TENANT,
} from './testing.js';

const ref = { tenantId: TENANT, killEventId: KILL_ID };
const IDS = ['sbx-1', 'sbx-2', 'sbx-3'];

function setup(controller: FakeSandboxController, overrides: Partial<KillActivityDeps> = {}) {
  const repo = new MemoryKillRepo();
  const made = makeDeps(repo, new FakeGateway((i) => ackAll(i)), {
    sandboxes: controller,
    ...overrides,
  });
  return { repo, ...made, acts: createKillActivities(made.deps) };
}

describe('terminateSandboxes', () => {
  it('terminates N sandboxes and records sandboxes_terminated_at on full ack', async () => {
    const ctl = new FakeSandboxController();
    const { acts, repo, metrics } = setup(ctl);

    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });

    expect(result.outcome).toBe('terminated');
    expect(ctl.calls).toEqual([{ sandboxIds: IDS }]);
    expect(repo.event.sandboxesTerminatedAt).toEqual(T0);
    expect(repo.event.affected.sandboxes).toBe(3);
    expect(repo.event.affected.sandboxResults).toHaveLength(3);
    expect(metrics.sandboxCount).toBe(3);
    expect(metrics.results).toContainEqual(['sandbox', 'terminated']);
  });

  it('counts an already-gone sandbox as success', async () => {
    const ctl = new FakeSandboxController((ids) => ackSandboxes(ids, 'already_gone'));
    const { acts, repo } = setup(ctl);
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });
    expect(result.outcome).toBe('terminated');
    expect(repo.event.status).toBe('initiated');
    expect(repo.event.affected.sandboxResults?.[0]?.outcome).toBe('already_gone');
  });

  it('retries only the failed ids and succeeds when they ack', async () => {
    const ctl = new FakeSandboxController((ids, call) =>
      call === 1
        ? [...ackSandboxes(ids.slice(0, 2)), { sandboxId: 'sbx-3', outcome: 'failed' as const }]
        : ackSandboxes(ids),
    );
    const { acts, repo } = setup(ctl);
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });
    expect(result.outcome).toBe('terminated');
    expect(ctl.calls[1]).toEqual({ sandboxIds: ['sbx-3'] });
    expect(repo.event.affected.sandboxes).toBe(3);
  });

  it('on overrun marks partially_halted, still stamps the stage, records failed ids and alerts', async () => {
    const ctl = new FakeSandboxController((ids) =>
      ids.map((sandboxId) => ({
        sandboxId,
        outcome: sandboxId === 'sbx-2' ? ('failed' as const) : ('terminated' as const),
      })),
    );
    const { acts, repo, metrics } = setup(ctl, { sandboxDeadlineMs: 1_000 });

    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });

    expect(result.outcome).toBe('partially_halted');
    expect(repo.event.sandboxesTerminatedAt).not.toBeNull();
    expect(repo.event.status).toBe('partially_halted');
    expect(repo.event.affected.sandboxes).toBe(2);
    expect(repo.event.affected.sandboxResults).toContainEqual({
      sandboxId: 'sbx-2',
      outcome: 'failed',
    });
    expect(metrics.partial).toBe(1);
  });

  it('treats a controller outage (every call throws) as partially_halted without throwing', async () => {
    const ctl = new FakeSandboxController(() => new Error('down'));
    const { acts, repo } = setup(ctl, { sandboxDeadlineMs: 1_000 });
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });
    expect(result.outcome).toBe('partially_halted');
    expect(result.sandboxes.every((s) => s.outcome === 'failed')).toBe(true);
    expect(repo.event.sandboxesTerminatedAt).not.toBeNull();
  });

  it('a pod stuck terminating is recorded, not retried, and does not block the kill', async () => {
    const ctl = new FakeSandboxController((ids) => ackSandboxes(ids, 'terminating'));
    const { acts, repo } = setup(ctl);
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: ['sbx-1'] });
    expect(ctl.calls).toHaveLength(1);
    expect(result.sandboxes[0]?.outcome).toBe('terminating');
    expect(repo.event.sandboxesTerminatedAt).not.toBeNull();
  });

  it('re-run is a no-op for already-terminated sandboxes', async () => {
    const ctl = new FakeSandboxController();
    const { acts, repo, advance } = setup(ctl);
    await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });
    const first = repo.event.sandboxesTerminatedAt;
    advance(5_000);

    const again = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });

    expect(again.outcome).toBe('skipped');
    expect(ctl.calls).toHaveLength(1);
    expect(repo.event.sandboxesTerminatedAt).toBe(first);
  });

  it('an empty sandbox set stamps the stage without calling the controller', async () => {
    const ctl = new FakeSandboxController();
    const { acts, repo } = setup(ctl);
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: [] });
    expect(result.outcome).toBe('terminated');
    expect(ctl.calls).toHaveLength(0);
    expect(repo.event.sandboxesTerminatedAt).not.toBeNull();
  });

  it('de-duplicates ids and ignores acks for ids it did not ask about', async () => {
    const ctl = new FakeSandboxController((ids) => [
      ...ackSandboxes(ids),
      ...ackSandboxes(['other']),
    ]);
    const { acts, repo } = setup(ctl);
    await acts.terminateSandboxes({ ...ref, sandboxIds: ['a', 'a', 'b'] });
    expect(ctl.calls[0]?.sandboxIds).toEqual(['a', 'b']);
    expect(repo.event.affected.sandboxes).toBe(2);
  });

  it('does not touch another tenant event', async () => {
    const { acts } = setup(new FakeSandboxController());
    await expect(
      acts.terminateSandboxes({
        tenantId: '0190a000-0000-7000-8000-0000000000ff',
        killEventId: KILL_ID,
        sandboxIds: IDS,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('auditSandboxesTerminated', () => {
  it('appends kill.sandboxes_terminated with counts only', async () => {
    const { acts, audits } = setup(new FakeSandboxController());
    const result = await acts.terminateSandboxes({ ...ref, sandboxIds: IDS });
    await acts.auditSandboxesTerminated({ ...ref, result });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'kill.sandboxes_terminated',
      outcome: 'success',
      metadata: { total: 3, terminated: 3, failed: 0 },
    });
  });

  it('writes nothing for a skipped re-run', async () => {
    const { acts, audits } = setup(new FakeSandboxController());
    await acts.auditSandboxesTerminated({
      ...ref,
      result: { outcome: 'skipped', sandboxes: [], attempts: 0, latencyMs: 0 },
    });
    expect(audits).toHaveLength(0);
  });
});
