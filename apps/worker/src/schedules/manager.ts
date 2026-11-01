import { trace } from '@opentelemetry/api';

import { nextFireAfter, parseSchedule } from '@blackwing/domain';
import { AppError, NotFoundError } from '@blackwing/errors';

import { desiredScheduleFacts, temporalScheduleIdFor, type DesiredScheduleFacts } from './spec.js';

import type {
  ActualScheduleFacts,
  ScheduleActor,
  ScheduleDefinitionChange,
  ScheduleMetrics,
  ScheduleOp,
  ScheduleStore,
  TemporalScheduleEngine,
  TenantStatusGate,
} from './ports.js';
import type { Schedule } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

/**
 * Keeps each `schedules` row and its Temporal Schedule in step (SCHED-003, CONTEXT_PACK §7, §8.6, §8.8). The database
 * row is the source of truth; Temporal owns the timer. Every operation fails closed: a Temporal failure surfaces as
 * `TEMPORAL_UNAVAILABLE` and reconciliation repairs whatever was left half-done.
 */

export interface ScheduleManagerDeps {
  readonly store: ScheduleStore;
  readonly engine: TemporalScheduleEngine;
  readonly tenants: TenantStatusGate;
  readonly metrics: ScheduleMetrics;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Defaults to the wall clock. Tests inject a fixed instant. */
  readonly now?: () => Date;
}

export interface ReconcileResult {
  /** Drift repaired in this pass: created, updated, paused, resumed, linked or removed. */
  readonly repairs: number;
}

export interface ScheduleManager {
  /** Starts the Temporal Schedule for an existing row. A failure disables the row (compensation) and throws. */
  create(tenantId: string, scheduleId: string, actor: ScheduleActor): Promise<Schedule>;
  /** Changes the definition. `expectedUpdatedAt` is the ETag the caller read; a stale one throws `SCHEDULE_CONFLICT`. */
  update(
    tenantId: string,
    scheduleId: string,
    expectedUpdatedAt: string,
    patch: ScheduleDefinitionChange,
    actor: ScheduleActor,
  ): Promise<Schedule>;
  pause(tenantId: string, scheduleId: string, actor: ScheduleActor): Promise<Schedule>;
  /** Resumes the schedule. A suspended tenant is refused with `SCHEDULE_TENANT_SUSPENDED`. */
  unpause(tenantId: string, scheduleId: string, actor: ScheduleActor): Promise<Schedule>;
  /** Removes the Temporal Schedule, then the row. A failed Temporal delete leaves the row, paused and disabled. */
  delete(tenantId: string, scheduleId: string, actor: ScheduleActor): Promise<void>;
  /** Repairs drift between the tenant's rows and its Temporal Schedules. Idempotent; safe to run hourly. */
  reconcile(tenantId: string): Promise<ReconcileResult>;
}

const tracer = trace.getTracer('@blackwing/worker');

/** The next fire for a row that will run, for the UI (SCHED-002 math); null while paused. */
function nextFireFor(row: Schedule, paused: boolean, now: Date): Date | null {
  if (paused) return null;
  return nextFireAfter(parseSchedule({ cronExpr: row.cronExpr, timezone: row.timezone }), now);
}

/** Compares two JSON-like values with object keys in sorted order, so key order never reads as drift. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** True when Temporal's schedule matches the desired definition, ignoring the paused state (reconcile handles that). */
function matchesDefinition(desired: DesiredScheduleFacts, actual: ActualScheduleFacts): boolean {
  return (
    desired.cronExpr === actual.cronExpr &&
    desired.timezone === actual.timezone &&
    desired.overlap === actual.overlap &&
    desired.catchupWindowMs === actual.catchupWindowMs &&
    stableJson(desired.input) === stableJson(actual.input)
  );
}

export function createScheduleManager(deps: ScheduleManagerDeps): ScheduleManager {
  const now = deps.now ?? (() => new Date());

  /** Runs one operation under a span and counts its outcome. */
  async function instrumented<T>(
    op: ScheduleOp,
    tenantId: string,
    scheduleId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan('schedule.manage', async (span) => {
      span.setAttributes({ 'schedule.op': op, 'tenant.id': tenantId, 'schedule.id': scheduleId });
      try {
        const result = await fn();
        deps.metrics.op({ op, result: 'ok' });
        return result;
      } catch (err) {
        deps.metrics.op({ op, result: 'error' });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async function requireRow(tenantId: string, scheduleId: string): Promise<Schedule> {
    const row = await deps.store.get(tenantId, scheduleId);
    if (row === null) throw new NotFoundError('schedule not found');
    return row;
  }

  /** Calls the Temporal engine; any failure surfaces as `TEMPORAL_UNAVAILABLE` (retryable, repaired by reconcile). */
  async function engineCall<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw new AppError('TEMPORAL_UNAVAILABLE', `temporal schedule ${label} failed`, {
        cause: err,
      });
    }
  }

  async function isSuspended(tenantId: string): Promise<boolean> {
    return deps.tenants.isSuspended(tenantId);
  }

  return {
    create(tenantId, scheduleId, actor) {
      return instrumented('create', tenantId, scheduleId, async () => {
        const row = await requireRow(tenantId, scheduleId);
        const temporalScheduleId = temporalScheduleIdFor(tenantId, scheduleId);
        const suspended = await isSuspended(tenantId);
        const facts = desiredScheduleFacts(row, suspended);
        try {
          // An existing Temporal Schedule under this id is brought onto the desired definition, not left as it is.
          if (!(await deps.engine.create(temporalScheduleId, facts))) {
            await deps.engine.update(temporalScheduleId, facts);
          }
        } catch (err) {
          // Compensation: the row must not stay enabled with no timer behind it. Disable it, record why, and alert.
          deps.log.error(
            { tenantId, scheduleId, temporalScheduleId, err },
            'temporal schedule create failed; schedule disabled',
          );
          await deps.store.write(
            tenantId,
            scheduleId,
            { enabled: false, nextFireAt: null },
            {
              audit: {
                action: 'schedule.paused',
                actor,
                metadata: { reason: 'temporal_create_failed' },
              },
            },
          );
          throw new AppError('TEMPORAL_UNAVAILABLE', 'temporal schedule create failed', {
            cause: err,
          });
        }
        const stored = await deps.store.write(
          tenantId,
          scheduleId,
          { temporalScheduleId, nextFireAt: nextFireFor(row, facts.paused, now()) },
          { audit: { action: 'schedule.created', actor, metadata: { temporalScheduleId } } },
        );
        deps.log.info({ tenantId, scheduleId, temporalScheduleId }, 'temporal schedule created');
        return stored;
      });
    },

    update(tenantId, scheduleId, expectedUpdatedAt, patch, actor) {
      return instrumented('update', tenantId, scheduleId, async () => {
        const row = await requireRow(tenantId, scheduleId);
        if (row.updatedAt !== expectedUpdatedAt) {
          throw new AppError('SCHEDULE_CONFLICT', 'schedule was changed by another request');
        }
        const merged: Schedule = { ...row, ...patch };
        // Validate before anything is written: an expression Temporal must not see is refused, and nothing changes.
        const suspended = await isSuspended(tenantId);
        const facts = desiredScheduleFacts(merged, suspended);
        const stored = await deps.store.write(
          tenantId,
          scheduleId,
          { definition: patch, nextFireAt: nextFireFor(merged, facts.paused, now()) },
          {
            expectedUpdatedAt,
            audit: { action: 'schedule.updated', actor, metadata: { changed: Object.keys(patch) } },
          },
        );
        const temporalScheduleId = temporalScheduleIdFor(tenantId, scheduleId);
        // A failure here leaves Temporal on the old definition; reconcile compares and repairs it.
        await engineCall('update', () => deps.engine.update(temporalScheduleId, facts));
        deps.log.info({ tenantId, scheduleId, temporalScheduleId }, 'temporal schedule updated');
        return stored;
      });
    },

    pause(tenantId, scheduleId, actor) {
      return instrumented('pause', tenantId, scheduleId, async () => {
        const row = await requireRow(tenantId, scheduleId);
        const temporalScheduleId = temporalScheduleIdFor(tenantId, scheduleId);
        // Temporal first: a pause that did not reach Temporal changes nothing, so the row keeps saying what runs.
        await engineCall('pause', () => deps.engine.pause(temporalScheduleId, 'paused by user'));
        const stored = await deps.store.write(
          tenantId,
          scheduleId,
          { enabled: false, nextFireAt: nextFireFor(row, true, now()) },
          { audit: { action: 'schedule.paused', actor } },
        );
        deps.log.info({ tenantId, scheduleId, temporalScheduleId }, 'temporal schedule paused');
        return stored;
      });
    },

    unpause(tenantId, scheduleId, actor) {
      return instrumented('unpause', tenantId, scheduleId, async () => {
        const row = await requireRow(tenantId, scheduleId);
        if (await isSuspended(tenantId)) {
          throw new AppError(
            'SCHEDULE_TENANT_SUSPENDED',
            'tenant is suspended; its schedules cannot be resumed',
          );
        }
        // Validates the row first: a schedule with an invalid expression is never resumed.
        desiredScheduleFacts(row, false);
        const temporalScheduleId = temporalScheduleIdFor(tenantId, scheduleId);
        await engineCall('unpause', () =>
          deps.engine.unpause(temporalScheduleId, 'resumed by user'),
        );
        const stored = await deps.store.write(
          tenantId,
          scheduleId,
          { enabled: true, nextFireAt: nextFireFor(row, false, now()) },
          { audit: { action: 'schedule.resumed', actor } },
        );
        deps.log.info({ tenantId, scheduleId, temporalScheduleId }, 'temporal schedule resumed');
        return stored;
      });
    },

    delete(tenantId, scheduleId, actor) {
      return instrumented('delete', tenantId, scheduleId, async () => {
        await requireRow(tenantId, scheduleId);
        const temporalScheduleId = temporalScheduleIdFor(tenantId, scheduleId);
        try {
          await deps.engine.delete(temporalScheduleId);
        } catch (err) {
          // Fail closed: the timer must not keep firing for a schedule the user is trying to remove.
          deps.log.error({ tenantId, scheduleId, err }, 'temporal schedule delete failed; paused');
          await deps.engine
            .pause(temporalScheduleId, 'delete failed; paused')
            .catch((pauseErr: unknown) => {
              deps.log.error({ tenantId, scheduleId, err: pauseErr }, 'best-effort pause failed');
            });
          await deps.store.write(
            tenantId,
            scheduleId,
            { enabled: false, nextFireAt: null },
            { audit: { action: 'schedule.paused', actor, metadata: { reason: 'delete_failed' } } },
          );
          throw new AppError('TEMPORAL_UNAVAILABLE', 'temporal schedule delete failed', {
            cause: err,
          });
        }
        await deps.store.delete(tenantId, scheduleId, {
          action: 'schedule.deleted',
          actor,
          metadata: { temporalScheduleId },
        });
        deps.log.info({ tenantId, scheduleId, temporalScheduleId }, 'temporal schedule deleted');
      });
    },

    reconcile(tenantId) {
      return instrumented('reconcile', tenantId, '*', async () => {
        const rows = await deps.store.list(tenantId);
        const suspended = await isSuspended(tenantId);
        const known = new Set(rows.map((row) => temporalScheduleIdFor(tenantId, row.id)));
        let repairs = 0;

        for (const row of rows) {
          const temporalScheduleId = temporalScheduleIdFor(tenantId, row.id);
          try {
            const desired = desiredScheduleFacts(row, suspended);
            const actual = await engineCall('describe', () =>
              deps.engine.describe(temporalScheduleId),
            );
            if (actual === null) {
              // A missing timer is recreated only for a row that should run; a disabled row needs none.
              if (!desired.paused) {
                await engineCall('create', () => deps.engine.create(temporalScheduleId, desired));
                repairs += 1;
              }
            } else {
              if (!matchesDefinition(desired, actual)) {
                await engineCall('update', () => deps.engine.update(temporalScheduleId, desired));
                repairs += 1;
              }
              if (actual.paused !== desired.paused) {
                if (desired.paused) {
                  await engineCall('pause', () =>
                    deps.engine.pause(temporalScheduleId, 'reconciled'),
                  );
                } else {
                  await engineCall('unpause', () =>
                    deps.engine.unpause(temporalScheduleId, 'reconciled'),
                  );
                }
                repairs += 1;
              }
            }
            if (row.temporalScheduleId !== temporalScheduleId) {
              await deps.store.write(tenantId, row.id, { temporalScheduleId }, {});
              repairs += 1;
            }
          } catch (err) {
            // One bad row must not stop the others. Its error is logged and the next pass retries it.
            deps.log.warn(
              { tenantId, scheduleId: row.id, err },
              'schedule reconcile skipped a row',
            );
          }
        }

        // A Temporal Schedule for this tenant with no row behind it is an orphan: remove it.
        const prefix = `sched-${tenantId}-`;
        for (const id of await engineCall('list', () => deps.engine.listIds())) {
          if (id.startsWith(prefix) && !known.has(id)) {
            await engineCall('delete', () => deps.engine.delete(id));
            repairs += 1;
            deps.log.info({ tenantId, temporalScheduleId: id }, 'orphan temporal schedule removed');
          }
        }

        deps.metrics.repairs(repairs);
        return { repairs };
      });
    },
  };
}
