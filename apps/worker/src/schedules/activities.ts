import type { ReconcileResult, ScheduleManager } from './manager.js';

/** The Temporal activities of the schedule sync, run on the `scheduler` queue. */
export interface ScheduleActivities {
  /** Repairs one tenant's drift. Run on worker boot for each tenant, then hourly. */
  reconcileSchedules(tenantId: string): Promise<ReconcileResult>;
}

export function createScheduleActivities(manager: ScheduleManager): ScheduleActivities {
  return {
    reconcileSchedules(tenantId) {
      return manager.reconcile(tenantId);
    },
  };
}
