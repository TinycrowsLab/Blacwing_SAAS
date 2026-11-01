import type { ReconcileResult, ScheduleManager } from './manager.js';
import type { Logger } from '@blackwing/logger';

/**
 * Drives reconciliation for every tenant at worker boot and then hourly (SCHED-003). Passes never overlap: a tick that
 * fires while a pass is still running joins it. One tenant's failure is logged and does not stop the others, and the
 * next pass retries it.
 */

/** Hourly, in milliseconds. */
export const RECONCILE_INTERVAL_MS = 3_600_000;

export interface ScheduleReconcilerDeps {
  readonly manager: Pick<ScheduleManager, 'reconcile'>;
  /**
   * The tenants to reconcile. Supplied by the caller: the schedule store is tenant-scoped (RLS) and cannot enumerate
   * tenants, so the process that owns the tenant registry provides the list.
   */
  readonly tenantIds: () => Promise<readonly string[]>;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Defaults to one hour. */
  readonly intervalMs?: number;
}

export interface ScheduleReconciler {
  /** One pass now. A call made while a pass is running joins that pass instead of starting another. */
  runOnce(): Promise<void>;
  /** Stops the hourly timer. A pass already running finishes. */
  stop(): void;
}

export function startScheduleReconciler(deps: ScheduleReconcilerDeps): ScheduleReconciler {
  let running: Promise<void> | undefined;

  async function pass(): Promise<void> {
    let tenants: readonly string[];
    try {
      tenants = await deps.tenantIds();
    } catch (err) {
      deps.log.error({ err }, 'schedule reconcile could not list tenants; retrying next pass');
      return;
    }
    for (const tenantId of tenants) {
      try {
        const result: ReconcileResult = await deps.manager.reconcile(tenantId);
        deps.log.info({ tenantId, repairs: result.repairs }, 'schedule reconcile pass finished');
      } catch (err) {
        deps.log.warn(
          { tenantId, err },
          'schedule reconcile failed for tenant; retrying next pass',
        );
      }
    }
  }

  const runOnce = (): Promise<void> => {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  };

  const timer = setInterval(() => {
    void runOnce();
  }, deps.intervalMs ?? RECONCILE_INTERVAL_MS);
  timer.unref();
  void runOnce();

  return {
    runOnce,
    stop: () => {
      clearInterval(timer);
    },
  };
}
