import { describe, expect, it } from 'vitest';

import { createKillActivities } from './activities.js';
import {
  ackAll,
  FakeGateway,
  KILL_ID,
  makeDeps,
  MemoryKillRepo,
  RUN_ID,
  RUN_ID_2,
  runIdentity,
  T0,
  TENANT,
} from './testing.js';

const ref = { tenantId: TENANT, killEventId: KILL_ID };

describe('blockEgress', () => {
  it('calls the gateway and records egress_blocked_at and status=propagating on ack', async () => {
    const repo = new MemoryKillRepo();
    const ids = [runIdentity(RUN_ID)];
    const gateway = new FakeGateway((i) => ackAll(i));
    const acts = createKillActivities(makeDeps(repo, gateway).deps);

    const result = await acts.blockEgress({ ...ref, identities: ids });

    expect(result.outcome).toBe('blocked');
    expect(gateway.calls).toHaveLength(1);
    expect(repo.event.egressBlockedAt).toEqual(T0);
    expect(repo.event.status).toBe('propagating');
    expect(repo.event.affected.egress).toEqual([{ identity: `run:${RUN_ID}`, outcome: 'blocked' }]);
  });

  it('treats already_blocked as an idempotent ack (expired run is already blocked)', async () => {
    const repo = new MemoryKillRepo();
    const ids = [runIdentity(RUN_ID)];
    const acts = createKillActivities(
      makeDeps(repo, new FakeGateway((i) => ackAll(i, 'already_blocked'))).deps,
    );
    const result = await acts.blockEgress({ ...ref, identities: ids });
    expect(result.outcome).toBe('blocked');
    expect(repo.event.affected.egress?.[0]?.outcome).toBe('already_blocked');
  });

  it('is idempotent: a second run neither re-blocks nor resets the timestamp', async () => {
    const repo = new MemoryKillRepo();
    const ids = [runIdentity(RUN_ID)];
    const gateway = new FakeGateway((i) => ackAll(i));
    const { deps, advance } = makeDeps(repo, gateway);
    const acts = createKillActivities(deps);
    await acts.blockEgress({ ...ref, identities: ids });
    const first = repo.event.egressBlockedAt;
    advance(5_000);

    const again = await acts.blockEgress({ ...ref, identities: ids });

    expect(again.outcome).toBe('skipped');
    expect(gateway.calls).toHaveLength(1);
    expect(repo.event.egressBlockedAt).toBe(first);
    expect(repo.writes).toBe(1);
  });

  it('retries with backoff and succeeds on a later attempt', async () => {
    const repo = new MemoryKillRepo();
    const ids = [runIdentity(RUN_ID)];
    const gateway = new FakeGateway((i, call) =>
      call < 3 ? new Error('econnrefused') : ackAll(i),
    );
    const acts = createKillActivities(makeDeps(repo, gateway).deps);
    const result = await acts.blockEgress({ ...ref, identities: ids });
    expect(result.attempts).toBe(3);
    expect(result.outcome).toBe('blocked');
  });

  it('gateway unreachable: marks partially_halted, increments the alert metric, stops at 5 attempts', async () => {
    const repo = new MemoryKillRepo();
    const ids = [runIdentity(RUN_ID)];
    const gateway = new FakeGateway(() => new Error('unreachable'));
    const { deps, metrics } = makeDeps(repo, gateway, { deadlineMs: 60_000 });
    const result = await createKillActivities(deps).blockEgress({ ...ref, identities: ids });

    expect(result.outcome).toBe('partially_halted');
    expect(gateway.calls).toHaveLength(5);
    expect(repo.event.status).toBe('partially_halted');
    expect(repo.event.egressBlockedAt).toBeNull();
    expect(metrics.partial).toBe(1);
    expect(metrics.results).toContainEqual(['egress', 'partially_halted']);
  });

  it('respects the 2 s deadline: slow failures stop retrying early', async () => {
    const repo = new MemoryKillRepo();
    const gateway = new FakeGateway(() => new Error('slow'));
    // Each attempt costs 900 ms of virtual time via the sleep seam.
    const { deps, advance } = makeDeps(repo, gateway);
    const slowGateway = {
      block: async (...args: Parameters<FakeGateway['block']>) => {
        advance(900);
        return gateway.block(...args);
      },
    };
    const result = await createKillActivities({ ...deps, egress: slowGateway }).blockEgress({
      ...ref,
      identities: [runIdentity(RUN_ID)],
    });
    expect(result.attempts).toBeLessThan(5);
    expect(result.outcome).toBe('partially_halted');
  });

  it('a delayed ack that never arrives in time still returns (workflow can advance)', async () => {
    const repo = new MemoryKillRepo();
    const never = {
      block: (_r: unknown, signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    };
    const { deps } = makeDeps(repo, never, {
      deadlineMs: 60,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    });
    const result = await createKillActivities(deps).blockEgress({
      ...ref,
      identities: [runIdentity(RUN_ID)],
    });
    expect(result.outcome).toBe('partially_halted');
    expect(repo.event.status).toBe('partially_halted');
  });

  it('records per-identity results for a partial block and retries only the unacked identity', async () => {
    const repo = new MemoryKillRepo();
    const a = runIdentity(RUN_ID);
    const b = runIdentity(RUN_ID_2);
    const gateway = new FakeGateway((ids) =>
      ids.map((identity) => ({
        identity,
        outcome: identity.runId === RUN_ID ? ('blocked' as const) : ('failed' as const),
      })),
    );
    const { deps } = makeDeps(repo, gateway, { deadlineMs: 60_000 });
    const result = await createKillActivities(deps).blockEgress({ ...ref, identities: [a, b] });

    expect(result.outcome).toBe('partially_halted');
    expect(gateway.calls[0]?.identities).toHaveLength(2);
    expect(gateway.calls[1]?.identities).toEqual([b]);
    expect(repo.event.affected.egress).toEqual([
      { identity: `run:${RUN_ID}`, outcome: 'blocked' },
      { identity: `run:${RUN_ID_2}`, outcome: 'failed' },
    ]);
  });

  it('with no egress identities the stage acks trivially', async () => {
    const repo = new MemoryKillRepo();
    const gateway = new FakeGateway(() => []);
    const result = await createKillActivities(makeDeps(repo, gateway).deps).blockEgress({
      ...ref,
      identities: [],
    });
    expect(result.outcome).toBe('blocked');
    expect(gateway.calls).toHaveLength(0);
    expect(repo.event.egressBlockedAt).not.toBeNull();
  });

  it('fails when the event is not visible to the tenant (tenant isolation)', async () => {
    const repo = new MemoryKillRepo();
    const acts = createKillActivities(makeDeps(repo, new FakeGateway((i) => ackAll(i))).deps);
    await expect(
      acts.blockEgress({
        tenantId: '0190a000-0000-7000-8000-0000000000ff',
        killEventId: KILL_ID,
        identities: [],
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('auditEgressBlocked', () => {
  it('appends kill.egress_blocked with the per-identity outcome and no secrets', async () => {
    const repo = new MemoryKillRepo();
    const { deps, audits } = makeDeps(repo, new FakeGateway((i) => ackAll(i)));
    const acts = createKillActivities(deps);
    const result = await acts.blockEgress({ ...ref, identities: [runIdentity(RUN_ID)] });
    await acts.auditEgressBlocked({ ...ref, result });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'kill.egress_blocked',
      outcome: 'success',
      metadata: { outcome: 'blocked', [`identity.run:${RUN_ID}`]: 'blocked' },
    });
  });

  it('writes nothing for a skipped re-run', async () => {
    const repo = new MemoryKillRepo();
    const { deps, audits } = makeDeps(repo, new FakeGateway((i) => ackAll(i)));
    await createKillActivities(deps).auditEgressBlocked({
      ...ref,
      result: { outcome: 'skipped', identities: [], attempts: 0, latencyMs: 0 },
    });
    expect(audits).toHaveLength(0);
  });
});

describe('completeEmptyKill and finalizeKill', () => {
  it('empty target set: halted with halt_ms=0', async () => {
    const repo = new MemoryKillRepo();
    const acts = createKillActivities(makeDeps(repo, new FakeGateway(() => [])).deps);
    await acts.completeEmptyKill(ref);
    expect(repo.event.status).toBe('halted');
    expect(repo.haltMs).toBe(0);
    expect(repo.event.completedAt).not.toBeNull();
  });

  it('stays open while later stages are outstanding', async () => {
    const repo = new MemoryKillRepo();
    const acts = createKillActivities(makeDeps(repo, new FakeGateway((i) => ackAll(i))).deps);
    await acts.blockEgress({ ...ref, identities: [runIdentity(RUN_ID)] });
    expect(await acts.finalizeKill(ref)).toEqual({ completed: false });
    expect(repo.event.completedAt).toBeNull();
  });

  it('completes halted with measured halt_ms once every stage recorded', async () => {
    const repo = new MemoryKillRepo();
    const { deps, advance, metrics } = makeDeps(repo, new FakeGateway((i) => ackAll(i)));
    const acts = createKillActivities(deps);
    await acts.blockEgress({ ...ref, identities: [runIdentity(RUN_ID)] });
    repo.event = {
      ...repo.event,
      sandboxesTerminatedAt: T0,
      keysRevokedAt: T0,
      workflowsCancelledAt: T0,
    };
    advance(1_500);
    expect(await acts.finalizeKill(ref)).toEqual({ completed: true });
    expect(repo.event.status).toBe('halted');
    expect(repo.haltMs).toBe(1_500);
    expect(metrics.halts).toEqual([1_500]);
  });

  it('completes partially_halted when egress was never fully acked, and never resets completion', async () => {
    const repo = new MemoryKillRepo();
    const { deps, advance } = makeDeps(repo, new FakeGateway(() => new Error('down')), {
      deadlineMs: 60_000,
    });
    const acts = createKillActivities(deps);
    await acts.blockEgress({ ...ref, identities: [runIdentity(RUN_ID)] });
    repo.event = {
      ...repo.event,
      sandboxesTerminatedAt: T0,
      keysRevokedAt: T0,
      workflowsCancelledAt: T0,
    };
    await acts.finalizeKill(ref);
    const completedAt = repo.event.completedAt;
    const haltMs = repo.haltMs;
    advance(10_000);
    await acts.finalizeKill(ref);
    expect(repo.event.status).toBe('partially_halted');
    expect(repo.event.completedAt).toBe(completedAt);
    expect(repo.haltMs).toBe(haltMs);
  });
});
