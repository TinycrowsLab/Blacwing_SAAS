import { tenants, type Database } from '@blackwing/db';

import { createScheduleActivities, type ScheduleActivities } from './activities.js';
import { createScheduleManager, type ScheduleManager } from './manager.js';
import { createOtelScheduleMetrics } from './metrics.js';
import { startScheduleReconciler, type ScheduleReconciler } from './reconciler.js';
import { createPgScheduleStore } from './store-pg.js';
import { createTemporalScheduleEngine } from './temporal-engine.js';
import { createPgTenantStatusGate } from './tenant-gate-pg.js';

import type { Logger } from '@blackwing/logger';
import type { Client } from '@temporalio/client';

/**
 * Wires the ScheduleManager of this worker process: the Postgres store and tenant gate on the app-role database,
 * the Temporal Schedule engine on the client's schedule API, and the reconciliation driver (SCHED-003). The activity
 * is registered on every worker; the hourly driver runs only where the `scheduler` queue is served.
 */

export interface ScheduleSyncDeps {
  readonly db: Database;
  readonly temporal: Pick<Client, 'schedule'>;
  readonly log: Logger;
}

export interface ScheduleSync {
  readonly manager: ScheduleManager;
  /** The `reconcileSchedules` activity, for the worker's activity registry. */
  readonly activities: ScheduleActivities;
  /** Starts the boot pass and the hourly timer. Call once; stop it on shutdown. */
  startReconciler(): ScheduleReconciler;
}

/** Every tenant id, suspended ones included: a suspended tenant's schedules still need reconciling (paused). */
async function allTenantIds(db: Database): Promise<readonly string[]> {
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((row) => row.id);
}

export function createScheduleSync(deps: ScheduleSyncDeps): ScheduleSync {
  const manager = createScheduleManager({
    store: createPgScheduleStore(deps.db),
    engine: createTemporalScheduleEngine(deps.temporal.schedule),
    tenants: createPgTenantStatusGate(deps.db),
    metrics: createOtelScheduleMetrics(),
    log: deps.log,
  });
  return {
    manager,
    activities: createScheduleActivities(manager),
    startReconciler: () =>
      startScheduleReconciler({
        manager,
        tenantIds: () => allTenantIds(deps.db),
        log: deps.log,
      }),
  };
}
