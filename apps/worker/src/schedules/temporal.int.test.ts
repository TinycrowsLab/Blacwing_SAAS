// Schedule sync against the dev Temporal service (SCHED-003): a created schedule fires AssessmentRunWorkflow with the
// schedule's trigger and id, pause, resume, update and delete reach Temporal, and reconciliation recreates a Temporal
// Schedule that was removed behind the manager's back. The time-skipping test server does not implement schedules, so
// this runs on the `pnpm dev:deps` stack (TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override). Run with `pnpm test:int`.

import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getWorkflowResult } from '@blackwing/testing/temporal';

import {
  ACTOR,
  MemoryScheduleStore,
  RecordingMetrics,
  SCHEDULE,
  TENANT,
  scheduleFixture,
  silentLog,
} from './fixtures.js';
import { createScheduleManager, type ScheduleManager } from './manager.js';
import { RUN_TASK_QUEUE, scheduleRunInput, temporalScheduleIdFor } from './spec.js';
import { createTemporalScheduleEngine } from './temporal-engine.js';

import type { TemporalScheduleEngine, TenantStatusGate } from './ports.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const WORKFLOWS_PATH = fileURLToPath(new URL('./test-workflows.ts', import.meta.url));
const TEMPORAL_ID = temporalScheduleIdFor(TENANT, SCHEDULE);

describe('ScheduleManager against Temporal', () => {
  let connection: Connection | undefined;
  let native: NativeConnection | undefined;
  let client: Client;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let store: MemoryScheduleStore;
  let engine: TemporalScheduleEngine;
  let manager: ScheduleManager;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
    // Serves the run workflow the schedule starts. A leftover schedule from an earlier run is removed first.
    worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue: RUN_TASK_QUEUE,
      workflowsPath: WORKFLOWS_PATH,
      activities: {},
    });
    workerRun = worker.run();
    engine = createTemporalScheduleEngine(client.schedule);
    await engine.delete(TEMPORAL_ID);
    store = new MemoryScheduleStore([scheduleFixture()]);
    const tenants: TenantStatusGate = { isSuspended: () => Promise.resolve(false) };
    manager = createScheduleManager({
      store: store,
      engine,
      tenants,
      metrics: new RecordingMetrics(),
      log: silentLog(),
    });
  }, 120_000);

  afterAll(async () => {
    // Removes a schedule that a failed run left behind, so the next run starts clean.
    if (connection !== undefined) {
      await createTemporalScheduleEngine(new Client({ connection, namespace }).schedule).delete(
        TEMPORAL_ID,
      );
    }
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await native?.close();
    await connection?.close();
  });

  it('fires AssessmentRunWorkflow with the schedule trigger and id, and keeps Temporal in step with the row', async () => {
    const handle = client.schedule.getHandle(TEMPORAL_ID);

    // Create: the Temporal Schedule carries the cron, zone, overlap and catch-up policy of the row.
    await manager.create(TENANT, SCHEDULE, ACTOR);
    expect(await engine.describe(TEMPORAL_ID)).toEqual({
      paused: false,
      cronExpr: '0 2 * * *',
      timezone: 'Europe/London',
      overlap: 'SKIP',
      catchupWindowMs: 10_000,
      input: scheduleRunInput(scheduleFixture()),
    });

    // Fire: triggering the schedule starts one run, and its input names the schedule and the schedule trigger.
    await handle.trigger();
    const fired = await handle.describe();
    expect(fired.action.taskQueue).toBe(RUN_TASK_QUEUE);
    const workflowId = fired.info.recentActions.at(-1)?.action.workflow.workflowId;
    if (workflowId === undefined) throw new Error('the schedule fired but recorded no run');
    expect(await getWorkflowResult(client.workflow.getHandle(workflowId))).toEqual({
      tenantId: TENANT,
      scheduleId: SCHEDULE,
      assetIds: scheduleFixture().assetIds,
      saId: scheduleFixture().saId,
      mode: 'grey',
      objective: null,
      budgets: { max_requests: 100 },
      trigger: 'schedule',
    });

    // Pause: Temporal and the row both say the schedule is off.
    await manager.pause(TENANT, SCHEDULE, ACTOR);
    expect((await engine.describe(TEMPORAL_ID))?.paused).toBe(true);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.enabled).toBe(false);

    // Resume: Temporal and the row both say the schedule runs again.
    await manager.unpause(TENANT, SCHEDULE, ACTOR);
    expect((await engine.describe(TEMPORAL_ID))?.paused).toBe(false);
    expect(store.rows.get(`${TENANT}/${SCHEDULE}`)?.enabled).toBe(true);

    // Update: the new cron and overlap policy replace the old ones; a stale ETag is refused.
    const row = store.rows.get(`${TENANT}/${SCHEDULE}`);
    if (row === undefined) throw new Error('setup');
    await manager.update(
      TENANT,
      SCHEDULE,
      row.updatedAt,
      { cronExpr: '0 3 * * *', overlapPolicy: 'allow' },
      ACTOR,
    );
    const updated = await engine.describe(TEMPORAL_ID);
    expect(updated?.cronExpr).toBe('0 3 * * *');
    expect(updated?.overlap).toBe('ALLOW_ALL');
    await expect(
      manager.update(TENANT, SCHEDULE, row.updatedAt, { cronExpr: '0 4 * * *' }, ACTOR),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT' });

    // Drift: a Temporal Schedule removed behind the manager's back is recreated by reconciliation.
    await handle.delete();
    expect(await engine.describe(TEMPORAL_ID)).toBeNull();
    const pass = await manager.reconcile(TENANT);
    expect(pass.repairs).toBeGreaterThanOrEqual(1);
    expect((await engine.describe(TEMPORAL_ID))?.cronExpr).toBe('0 3 * * *');

    // Delete: the Temporal Schedule and then the row go.
    await manager.delete(TENANT, SCHEDULE, ACTOR);
    expect(await engine.describe(TEMPORAL_ID)).toBeNull();
    expect(await store.get(TENANT, SCHEDULE)).toBeNull();
  }, 180_000);
});
