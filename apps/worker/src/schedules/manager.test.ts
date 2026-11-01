import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  ACTOR,
  ASSET,
  MemoryEngine,
  MemoryScheduleStore,
  NOW,
  OTHER_TENANT,
  RecordingMetrics,
  SCHEDULE,
  SCHEDULE_2,
  SA,
  TENANT,
  scheduleFixture,
  silentLog,
} from './fixtures.js';
import { createScheduleManager, type ScheduleManagerDeps } from './manager.js';
import { temporalScheduleIdFor, type DesiredScheduleFacts } from './spec.js';

import type { TenantStatusGate } from './ports.js';

const TEMPORAL_ID = temporalScheduleIdFor(TENANT, SCHEDULE);

interface Harness {
  readonly store: MemoryScheduleStore;
  readonly engine: MemoryEngine;
  readonly metrics: RecordingMetrics;
  readonly suspended: Set<string>;
  readonly manager: ReturnType<typeof createScheduleManager>;
}

function harness(
  rows = [scheduleFixture()],
  overrides: Partial<ScheduleManagerDeps> = {},
): Harness {
  const store = new MemoryScheduleStore(rows);
  const engine = new MemoryEngine();
  const metrics = new RecordingMetrics();
  const suspended = new Set<string>();
  const tenants: TenantStatusGate = {
    isSuspended: (tenantId) => Promise.resolve(suspended.has(tenantId)),
  };
  const manager = createScheduleManager({
    store: store,
    engine,
    tenants,
    metrics,
    log: silentLog(),
    now: () => NOW,
    ...overrides,
  });
  return { store, engine, metrics, suspended, manager };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('ScheduleManager.create', () => {
  it('creates the Temporal Schedule under the deterministic id and links it to the row', async () => {
    const { store, engine, manager } = harness();

    const stored = await manager.create(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.has(TEMPORAL_ID)).toBe(true);
    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(false);
    expect(stored.temporalScheduleId).toBe(TEMPORAL_ID);
    expect(stored.nextFireAt).toBe('2026-11-01T02:00:00.000Z');
    expect(store.audits.map((a) => a.event.action)).toEqual(['schedule.created']);
  });

  it('starts a disabled row paused', async () => {
    const { engine, manager } = harness([scheduleFixture({ enabled: false })]);

    const stored = await manager.create(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
    expect(stored.nextFireAt).toBeNull();
  });

  it('creates a tenant-suspended schedule paused', async () => {
    const { engine, manager, suspended } = harness();
    suspended.add(TENANT);

    await manager.create(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
  });

  it('compensates a failed Temporal create: the row is disabled, audited and the call fails with TEMPORAL_UNAVAILABLE', async () => {
    const { store, engine, metrics, manager } = harness();
    engine.failing.add('create');

    const err = await rejection(manager.create(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(err.httpStatus).toBe(503);
    const row = store.rows.get(`${TENANT}/${SCHEDULE}`);
    expect(row?.enabled).toBe(false);
    expect(row?.temporalScheduleId).toBeNull();
    expect(store.audits.map((audit) => audit.event)).toMatchObject([
      { action: 'schedule.paused', metadata: { reason: 'temporal_create_failed' } },
    ]);
    expect(metrics.ops).toEqual([{ op: 'create', result: 'error' }]);
  });

  it('refuses an expression the domain rejects before anything reaches Temporal', async () => {
    const { engine, manager } = harness([scheduleFixture({ cronExpr: '*/5 * * * *' })]);

    const err = await rejection(manager.create(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('SCHEDULE_TOO_FREQUENT');
    expect(engine.calls).toEqual([]);
  });

  it('refuses an unknown time zone before anything reaches Temporal', async () => {
    const { engine, manager } = harness([scheduleFixture({ timezone: 'Mars/Olympus' })]);

    const err = await rejection(manager.create(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('SCHEDULE_TZ_INVALID');
    expect(engine.calls).toEqual([]);
  });

  it('fails with NOT_FOUND for a schedule the tenant does not own', async () => {
    const { manager } = harness();

    const err = await rejection(manager.create(OTHER_TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('ScheduleManager.update', () => {
  it('writes the new definition, updates Temporal and audits the change', async () => {
    const row = scheduleFixture({ temporalScheduleId: TEMPORAL_ID });
    const { store, engine, manager } = harness([row]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    const current = store.rows.get(`${TENANT}/${SCHEDULE}`);
    if (current === undefined) throw new Error('setup');

    const stored = await manager.update(
      TENANT,
      SCHEDULE,
      current.updatedAt,
      { cronExpr: '30 6 * * 1', overlapPolicy: 'cancel_other' },
      ACTOR,
    );

    expect(stored.cronExpr).toBe('30 6 * * 1');
    expect(engine.schedules.get(TEMPORAL_ID)).toMatchObject({
      cronExpr: '30 6 * * 1',
      overlap: 'CANCEL_OTHER',
    });
    expect(store.audits.at(-1)?.event).toMatchObject({
      action: 'schedule.updated',
      metadata: { changed: ['cronExpr', 'overlapPolicy'] },
    });
  });

  it('refuses a stale ETag with SCHEDULE_CONFLICT and changes nothing', async () => {
    const { store, engine, manager } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    const callsBefore = engine.calls.length;

    const err = await rejection(
      manager.update(TENANT, SCHEDULE, '2020-01-01T00:00:00.000Z', { name: 'Renamed' }, ACTOR),
    );

    expect(err.code).toBe('SCHEDULE_CONFLICT');
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.name).toBe('Nightly external');
    expect(engine.calls.length).toBe(callsBefore);
  });

  it('refuses an invalid expression before writing the row', async () => {
    const { store, manager } = harness();
    const current = store.rows.get(`${TENANT}/${SCHEDULE}`);
    if (current === undefined) throw new Error('setup');

    const err = await rejection(
      manager.update(TENANT, SCHEDULE, current.updatedAt, { cronExpr: 'not a cron' }, ACTOR),
    );

    expect(err.code).toBe('SCHEDULE_CRON_INVALID');
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.cronExpr).toBe('0 2 * * *');
    expect(store.audits).toEqual([]);
  });

  it('keeps the new definition when Temporal is unavailable, so reconciliation can repair the timer', async () => {
    const { store, engine, manager } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    const current = store.rows.get(`${TENANT}/${SCHEDULE}`);
    if (current === undefined) throw new Error('setup');
    engine.failing.add('update');

    const err = await rejection(
      manager.update(TENANT, SCHEDULE, current.updatedAt, { cronExpr: '30 6 * * *' }, ACTOR),
    );

    expect(err.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.cronExpr).toBe('30 6 * * *');
    expect(engine.schedules.get(TEMPORAL_ID)?.cronExpr).toBe('0 2 * * *');
  });
});

describe('ScheduleManager.pause and unpause', () => {
  it('pauses Temporal first, then disables the row and audits it', async () => {
    const { store, engine, manager } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);

    const stored = await manager.pause(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
    expect(stored.enabled).toBe(false);
    expect(stored.nextFireAt).toBeNull();
    expect(store.audits.at(-1)?.event.action).toBe('schedule.paused');
  });

  it('leaves the row enabled when the pause did not reach Temporal (fail closed, retryable)', async () => {
    const { store, engine, manager } = harness();
    await manager.create(TENANT, SCHEDULE, ACTOR);
    engine.failing.add('pause');

    const err = await rejection(manager.pause(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.enabled).toBe(true);
  });

  it('resumes the Temporal Schedule and enables the row', async () => {
    const { store, engine, manager } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    await manager.pause(TENANT, SCHEDULE, ACTOR);

    const stored = await manager.unpause(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(false);
    expect(stored.enabled).toBe(true);
    expect(stored.nextFireAt).toBe('2026-11-01T02:00:00.000Z');
    expect(store.audits.at(-1)?.event.action).toBe('schedule.resumed');
  });

  it('refuses to resume a suspended tenant and touches nothing', async () => {
    const { store, engine, manager, suspended } = harness([
      scheduleFixture({ enabled: false, temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    suspended.add(TENANT);
    const callsBefore = engine.calls.length;

    const err = await rejection(manager.unpause(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('SCHEDULE_TENANT_SUSPENDED');
    expect(engine.calls.length).toBe(callsBefore);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.enabled).toBe(false);
  });

  it('refuses to resume a row whose expression is no longer valid', async () => {
    const { engine, manager } = harness([scheduleFixture({ enabled: false, cronExpr: 'garbage' })]);

    const err = await rejection(manager.unpause(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('SCHEDULE_CRON_INVALID');
    expect(engine.calls).toEqual([]);
  });
});

describe('ScheduleManager.delete', () => {
  it('removes the Temporal Schedule, then the row, and audits the delete', async () => {
    const { store, engine, manager } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);

    await manager.delete(TENANT, SCHEDULE, ACTOR);

    expect(engine.schedules.has(TEMPORAL_ID)).toBe(false);
    expect(store.rows.has(`${TENANT}/${SCHEDULE}`)).toBe(false);
    expect(store.audits.at(-1)?.event.action).toBe('schedule.deleted');
  });

  it('keeps the row, disabled and paused, when the Temporal delete fails', async () => {
    const { store, engine, manager } = harness();
    await manager.create(TENANT, SCHEDULE, ACTOR);
    engine.failing.add('delete');

    const err = await rejection(manager.delete(TENANT, SCHEDULE, ACTOR));

    expect(err.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(store.rows.has(`${TENANT}/${SCHEDULE}`)).toBe(true);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.enabled).toBe(false);
    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
  });
});

describe('ScheduleManager.reconcile', () => {
  it('recreates the Temporal Schedule for an enabled row that has none', async () => {
    const { store, engine, manager, metrics } = harness();

    const result = await manager.reconcile(TENANT);

    expect(result.repairs).toBe(2);
    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(false);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.temporalScheduleId).toBe(TEMPORAL_ID);
    expect(metrics.repairTotal).toBe(2);
  });

  it('does not create a timer for a disabled row, and pauses one that is running', async () => {
    const { engine, manager } = harness([scheduleFixture({ enabled: false })]);

    const first = await manager.reconcile(TENANT);
    expect(engine.schedules.has(TEMPORAL_ID)).toBe(false);
    expect(first.repairs).toBe(1);

    engine.schedules.set(TEMPORAL_ID, engineFacts());
    const second = await manager.reconcile(TENANT);
    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
    expect(second.repairs).toBe(1);
  });

  it('repairs a definition that drifted in Temporal', async () => {
    const { engine, manager } = harness([scheduleFixture({ temporalScheduleId: TEMPORAL_ID })]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    const drifted = engine.schedules.get(TEMPORAL_ID);
    if (drifted === undefined) throw new Error('setup');
    engine.schedules.set(TEMPORAL_ID, { ...drifted, cronExpr: '0 9 * * *' });

    const result = await manager.reconcile(TENANT);

    expect(result.repairs).toBe(1);
    expect(engine.schedules.get(TEMPORAL_ID)?.cronExpr).toBe('0 2 * * *');
  });

  it('is idempotent: a second pass over a repaired tenant changes nothing', async () => {
    const { manager } = harness();
    await manager.reconcile(TENANT);

    const second = await manager.reconcile(TENANT);

    expect(second.repairs).toBe(0);
  });

  it('removes an orphan Temporal Schedule for the tenant and leaves other tenants alone', async () => {
    const { engine, manager } = harness([scheduleFixture({ temporalScheduleId: TEMPORAL_ID })]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    const orphan = temporalScheduleIdFor(TENANT, SCHEDULE_2);
    const foreign = temporalScheduleIdFor(OTHER_TENANT, SCHEDULE_2);
    engine.schedules.set(orphan, { ...engineFacts(), paused: false });
    engine.schedules.set(foreign, { ...engineFacts(), paused: false });

    const result = await manager.reconcile(TENANT);

    expect(result.repairs).toBe(1);
    expect(engine.schedules.has(orphan)).toBe(false);
    expect(engine.schedules.has(foreign)).toBe(true);
  });

  it('pauses every schedule of a suspended tenant', async () => {
    const { engine, manager, suspended } = harness([
      scheduleFixture({ temporalScheduleId: TEMPORAL_ID }),
    ]);
    await manager.create(TENANT, SCHEDULE, ACTOR);
    suspended.add(TENANT);

    const result = await manager.reconcile(TENANT);

    expect(engine.schedules.get(TEMPORAL_ID)?.paused).toBe(true);
    expect(result.repairs).toBe(1);
  });

  it('isolates a bad row: a row the domain refuses is skipped and the others are still repaired', async () => {
    const { store, engine, manager, metrics } = harness([
      scheduleFixture({ cronExpr: '*/5 * * * *' }),
      scheduleFixture({ id: SCHEDULE_2, publicId: 'sched_00000000000000000000000001' }),
    ]);

    const result = await manager.reconcile(TENANT);

    expect(result.repairs).toBe(2);
    expect(engine.schedules.has(temporalScheduleIdFor(TENANT, SCHEDULE_2))).toBe(true);
    expect(engine.schedules.has(TEMPORAL_ID)).toBe(false);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.temporalScheduleId).toBeNull();
    expect(metrics.repairTotal).toBe(2);
  });
});

function engineFacts(): DesiredScheduleFacts {
  return {
    cronExpr: '0 2 * * *',
    timezone: 'Europe/London',
    overlap: 'SKIP' as const,
    catchupWindowMs: 10_000,
    input: {
      tenantId: TENANT,
      scheduleId: SCHEDULE,
      assetIds: [ASSET],
      saId: SA,
      mode: 'grey' as const,
      objective: null,
      budgets: { max_requests: 100 },
      trigger: 'schedule' as const,
    },
    paused: false,
  };
}
