import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLog } from './fixtures.js';
import { RECONCILE_INTERVAL_MS, startScheduleReconciler } from './reconciler.js';

import type { ReconcileResult, ScheduleManager } from './manager.js';

const TENANT_A = '0190f2d4-7c1a-7b2e-8f00-00000000000a';
const TENANT_B = '0190f2d4-7c1a-7b2e-8f00-00000000000b';

/** A manager double whose reconcile result is decided per call. */
function managerDouble(reconcile: (tenantId: string) => Promise<ReconcileResult>) {
  const calls: string[] = [];
  const manager: Pick<ScheduleManager, 'reconcile'> = {
    reconcile: (tenantId) => {
      calls.push(tenantId);
      return reconcile(tenantId);
    },
  };
  return { manager, calls };
}

const ok = (): Promise<ReconcileResult> => Promise.resolve({ repairs: 0 });

describe('startScheduleReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles every tenant on boot, then again every hour', async () => {
    const { manager, calls } = managerDouble(ok);
    const reconciler = startScheduleReconciler({
      manager,
      tenantIds: () => Promise.resolve([TENANT_A, TENANT_B]),
      log: silentLog(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([TENANT_A, TENANT_B]);

    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);

    expect(calls).toEqual([TENANT_A, TENANT_B, TENANT_A, TENANT_B]);
    reconciler.stop();
  });

  it('stops the hourly timer', async () => {
    const { manager, calls } = managerDouble(ok);
    const reconciler = startScheduleReconciler({
      manager,
      tenantIds: () => Promise.resolve([TENANT_A]),
      log: silentLog(),
    });
    await reconciler.runOnce();
    reconciler.stop();

    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);

    expect(calls).toEqual([TENANT_A]);
  });

  it('isolates a failing tenant: the others are still reconciled and the failure is retried next pass', async () => {
    let fail = true;
    const { manager, calls } = managerDouble((tenantId) => {
      if (tenantId === TENANT_A && fail) return Promise.reject(new Error('temporal down'));
      return ok();
    });
    const reconciler = startScheduleReconciler({
      manager,
      tenantIds: () => Promise.resolve([TENANT_A, TENANT_B]),
      log: silentLog(),
    });
    await reconciler.runOnce();
    fail = false;
    await reconciler.runOnce();
    reconciler.stop();

    expect(calls).toEqual([TENANT_A, TENANT_B, TENANT_A, TENANT_B]);
  });

  it('skips the pass when the tenant list cannot be read, and runs again on the next tick', async () => {
    let listable = false;
    const { manager, calls } = managerDouble(ok);
    const reconciler = startScheduleReconciler({
      manager,
      tenantIds: () =>
        listable ? Promise.resolve([TENANT_A]) : Promise.reject(new Error('db down')),
      log: silentLog(),
    });
    await reconciler.runOnce();
    expect(calls).toEqual([]);

    listable = true;
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    reconciler.stop();

    expect(calls).toEqual([TENANT_A]);
  });

  it('does not start a second pass while one is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, calls } = managerDouble(() => gate.then(() => ({ repairs: 0 })));
    const reconciler = startScheduleReconciler({
      manager,
      tenantIds: () => Promise.resolve([TENANT_A]),
      log: silentLog(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([TENANT_A]);

    const joined = reconciler.runOnce();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(calls).toEqual([TENANT_A]);

    release();
    await joined;
    reconciler.stop();
  });
});
