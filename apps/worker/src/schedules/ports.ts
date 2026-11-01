import type { DesiredScheduleFacts } from './spec.js';
import type { AuditMetadata, Schedule, ScheduleMode } from '@blackwing/contracts';

/**
 * Ports the ScheduleManager runs on. The Postgres store and the Temporal adapter are the production bindings; the
 * manager and its tests depend only on these shapes.
 */

/** Who acted, for the audit event (AUDIT-001 actor shapes). */
export interface ScheduleActor {
  readonly type: 'user' | 'system';
  readonly id: string;
}

/** The audit action a store write records, in the same transaction as the write (SCHED-008). */
type ScheduleAuditAction =
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.paused'
  | 'schedule.resumed'
  | 'schedule.deleted';

export interface ScheduleAudit {
  readonly action: ScheduleAuditAction;
  readonly actor: ScheduleActor;
  readonly metadata?: AuditMetadata;
}

/** The fields a store write may change. `enabled` and the Temporal link are the only state the manager owns. */
export interface ScheduleStateChange {
  readonly enabled?: boolean;
  readonly temporalScheduleId?: string | null;
  readonly nextFireAt?: Date | null;
  /** The new definition, when an update changes it. Field names follow `Schedule`. */
  readonly definition?: ScheduleDefinitionChange;
}

export interface ScheduleDefinitionChange {
  readonly name?: string;
  readonly assetIds?: string[];
  readonly mode?: ScheduleMode;
  readonly objective?: string | null;
  readonly cronExpr?: string;
  readonly timezone?: string;
  readonly overlapPolicy?: Schedule['overlapPolicy'];
  readonly catchUpPolicy?: Schedule['catchUpPolicy'];
  readonly catchUpWindowMinutes?: number;
  readonly budgets?: Record<string, number> | null;
}

/**
 * Tenant-scoped persistence of `schedules`. Every method runs inside `withTenant`, so RLS confines it. A write that
 * carries `audit` records the audit event in the same transaction, so the change and its audit trail commit together.
 */
export interface ScheduleStore {
  /** The schedule with this id in the tenant, or null. */
  get(tenantId: string, id: string): Promise<Schedule | null>;
  /** Every schedule in the tenant, enabled or not. */
  list(tenantId: string): Promise<Schedule[]>;
  /**
   * Applies `change` and returns the stored row. With `expectedUpdatedAt`, the write applies only while the row still
   * carries that timestamp (optimistic concurrency, SCHED-006); otherwise it throws `SCHEDULE_CONFLICT`.
   */
  write(
    tenantId: string,
    id: string,
    change: ScheduleStateChange,
    options: { readonly expectedUpdatedAt?: string; readonly audit?: ScheduleAudit },
  ): Promise<Schedule>;
  /** Deletes the row and records the audit event in the same transaction. */
  delete(tenantId: string, id: string, audit: ScheduleAudit): Promise<void>;
}

/**
 * What Temporal holds for one schedule. Values are as Temporal returned them, not validated: `overlap` is a plain
 * string and `input` is unknown, so the manager compares them with the desired facts rather than trusting their shape.
 */
export interface ActualScheduleFacts {
  readonly paused: boolean;
  readonly cronExpr: string;
  readonly timezone: string;
  readonly overlap: string;
  readonly catchupWindowMs: number;
  readonly input: unknown;
}

/** The subset of the Temporal Schedule API the manager uses. Errors other than "not found" are real failures. */
export interface TemporalScheduleEngine {
  /** Creates the schedule. Resolves `false` when it already exists (idempotent create). */
  create(scheduleId: string, facts: DesiredScheduleFacts): Promise<boolean>;
  /** Replaces the definition of an existing schedule, keeping its paused state. Temporal cannot update the memo in place. */
  update(scheduleId: string, facts: DesiredScheduleFacts): Promise<void>;
  /** Stops the schedule from firing. */
  pause(scheduleId: string, note: string): Promise<void>;
  /** Starts the schedule firing again. */
  unpause(scheduleId: string, note: string): Promise<void>;
  /** Removes the schedule. A schedule that is already gone is not an error. */
  delete(scheduleId: string): Promise<void>;
  /** The schedule's facts, or null when Temporal has no such schedule. */
  describe(scheduleId: string): Promise<ActualScheduleFacts | null>;
  /** Every Temporal Schedule id in the namespace. */
  listIds(): Promise<string[]>;
}

/** Whether the tenant is suspended. A suspended tenant's schedules never resume (SCHED-003, ADMIN). */
export interface TenantStatusGate {
  isSuspended(tenantId: string): Promise<boolean>;
}

/** `temporal_schedule_ops_total{op,result}` and `schedule_reconcile_repairs_total`. */
export interface ScheduleMetrics {
  op(labels: { readonly op: ScheduleOp; readonly result: 'ok' | 'error' }): void;
  repairs(count: number): void;
}

export type ScheduleOp = 'create' | 'update' | 'pause' | 'unpause' | 'delete' | 'reconcile';
