import { parseSchedule } from '@blackwing/domain';

import { TASK_QUEUES } from '../task-queues.js';

import type { Schedule, ScheduleOverlapPolicy } from '@blackwing/contracts';

/**
 * Pure translation from a stored schedule to the Temporal Schedule that fires it (SCHED-003, CONTEXT_PACK §7). No IO:
 * the same row always yields the same spec, so reconciliation can compare what Temporal holds with what the database
 * says. Cron validation and the next-fire math belong to `@blackwing/domain` (SCHED-002); this module only maps.
 */

/** The run workflow a schedule starts. Registered by name: ORCH owns the class, and the worker only starts it by type. */
export const ASSESSMENT_RUN_WORKFLOW = 'AssessmentRunWorkflow';

/** `sched-{tenantId}-{scheduleId}`: the Temporal Schedule id. Deterministic, so a retry never creates a second one. */
export function temporalScheduleIdFor(tenantId: string, scheduleId: string): string {
  return `sched-${tenantId}-${scheduleId}`;
}

/** Temporal overlap policies, by Blackwing's `overlap_policy` value. */
export type TemporalOverlapPolicy = 'SKIP' | 'BUFFER_ONE' | 'CANCEL_OTHER' | 'ALLOW_ALL';

const OVERLAP_POLICIES: Readonly<Record<ScheduleOverlapPolicy, TemporalOverlapPolicy>> = {
  skip: 'SKIP',
  buffer_one: 'BUFFER_ONE',
  cancel_other: 'CANCEL_OTHER',
  allow: 'ALLOW_ALL',
};

export function temporalOverlapPolicy(policy: ScheduleOverlapPolicy): TemporalOverlapPolicy {
  return OVERLAP_POLICIES[policy];
}

const MS_PER_MINUTE = 60_000;
const SKIP_CATCH_UP_WINDOW_MS = 10_000;

/**
 * The catch-up window in milliseconds (SCHED-005). `fire_once` takes the missed fires inside the configured window,
 * at least one minute. `skip` takes none: Temporal refuses a window under ten seconds and reports that minimum back,
 * so `skip` gets ten seconds, the smallest window the server accepts, and the desired value matches what it holds.
 */
export function catchupWindowMs(policy: Schedule['catchUpPolicy'], windowMinutes: number): number {
  if (policy === 'skip') return SKIP_CATCH_UP_WINDOW_MS;
  return Math.max(1, windowMinutes) * MS_PER_MINUTE;
}

/** The input every started run receives. It carries references only: no secret ever reaches a schedule action. */
export interface ScheduleRunInput {
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly assetIds: readonly string[];
  readonly saId: string;
  readonly mode: Schedule['mode'];
  readonly objective: string | null;
  readonly budgets: Record<string, number> | null;
  readonly trigger: 'schedule';
}

/** The run input for one schedule row. */
export function scheduleRunInput(schedule: Schedule): ScheduleRunInput {
  return {
    tenantId: schedule.tenantId,
    scheduleId: schedule.id,
    assetIds: schedule.assetIds,
    saId: schedule.saId,
    mode: schedule.mode,
    objective: schedule.objective,
    budgets: schedule.budgets,
    trigger: 'schedule',
  };
}

/**
 * What a Temporal Schedule must look like for one stored row. `paused` is the desired state: a disabled row, or a
 * row whose tenant is suspended, is paused. The cron and zone are the normalised ones from SCHED-002.
 */
export interface DesiredScheduleFacts {
  readonly paused: boolean;
  readonly cronExpr: string;
  readonly timezone: string;
  readonly overlap: TemporalOverlapPolicy;
  readonly catchupWindowMs: number;
  readonly input: ScheduleRunInput;
}

/**
 * Builds the desired facts for a row. It throws the SCHED-002 error (`SCHEDULE_CRON_INVALID`, `SCHEDULE_TZ_INVALID`,
 * `SCHEDULE_TOO_FREQUENT`) for an expression the domain refuses, so an invalid row never reaches Temporal.
 */
export function desiredScheduleFacts(
  schedule: Schedule,
  tenantSuspended: boolean,
): DesiredScheduleFacts {
  const cron = parseSchedule({ cronExpr: schedule.cronExpr, timezone: schedule.timezone });
  return {
    paused: !schedule.enabled || tenantSuspended,
    cronExpr: cron.cronExpr,
    timezone: cron.timezone,
    overlap: temporalOverlapPolicy(schedule.overlapPolicy),
    catchupWindowMs: catchupWindowMs(schedule.catchUpPolicy, schedule.catchUpWindowMinutes),
    input: scheduleRunInput(schedule),
  };
}

/** The task queue the run workflow is started on. */
export const RUN_TASK_QUEUE = TASK_QUEUES.RUN_ORCHESTRATION;
