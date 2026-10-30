import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isBefore,
  isoDateTimeSchema,
  labelSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/**
 * Recurring-run schedules and blackout windows (SCHED-001, CONTEXT_PACK §7, §8.6). A schedule is a stored
 * definition of runs that fire on a cron expression inside a standing authorisation. A blackout window suppresses
 * runs for a tenant or for named assets. The enums and caps below are the single source for the `schedules` and
 * `blackout_windows` check constraints in `@blackwing/db`, so the two cannot drift. The cron expression and the
 * timezone are stored as opaque text here: their syntax is validated by SCHED-002, not by SQL or these schemas.
 */

/** Assessment modes a schedule may run in (the same values as `assessment_requests.mode`). */
export const SCHEDULE_MODES = ['black', 'grey', 'white'] as const;
export const scheduleModeSchema = z.enum(SCHEDULE_MODES);
export type ScheduleMode = z.infer<typeof scheduleModeSchema>;

/** What happens when a fire is due while the previous run is still active. */
export const SCHEDULE_OVERLAP_POLICIES = ['skip', 'buffer_one', 'cancel_other', 'allow'] as const;
export const scheduleOverlapPolicySchema = z.enum(SCHEDULE_OVERLAP_POLICIES);
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>;

/** What happens to fires missed while the scheduler was down. */
export const SCHEDULE_CATCH_UP_POLICIES = ['skip', 'fire_once'] as const;
export const scheduleCatchUpPolicySchema = z.enum(SCHEDULE_CATCH_UP_POLICIES);
export type ScheduleCatchUpPolicy = z.infer<typeof scheduleCatchUpPolicySchema>;

/** A blackout window covers the whole tenant, or only the assets it names. */
export const BLACKOUT_SCOPES = ['tenant', 'asset'] as const;
export const blackoutScopeSchema = z.enum(BLACKOUT_SCOPES);
export type BlackoutScope = z.infer<typeof blackoutScopeSchema>;

/** Caps that mirror the check constraints in the `@blackwing/db` migration. */
export const SCHEDULE_NAME_MAX = LIMITS.labelMax;
export const SCHEDULE_CRON_MAX = 256;
export const SCHEDULE_TIMEZONE_MAX = 64;
export const SCHEDULE_ASSET_IDS_MAX = 100;
export const SCHEDULE_CATCH_UP_WINDOW_MAX_MINUTES = 10080;
export const SCHEDULE_CATCH_UP_WINDOW_DEFAULT_MINUTES = 60;

/** A public schedule id, `sched_` plus the 26-character Crockford base32 of its uuid. */
export const schedulePublicIdSchema = z.string().regex(/^sched_[0-9a-hjkmnp-tv-z]{26}$/);

/** Budgets are numbers only (no secrets, no strings), keyed by a short dimension name. */
const budgetsSchema = z.record(z.string().min(1).max(LIMITS.keyMax), z.number().nonnegative());

const assetIdsSchema = z.array(uuidV7Schema).max(SCHEDULE_ASSET_IDS_MAX);

/** `POST` body for a schedule. An empty `assetIds` is refused by the repository (`SCHEDULE_NO_ASSETS`). */
export const scheduleCreateSchema = z.strictObject({
  name: labelSchema,
  assetIds: assetIdsSchema,
  saId: uuidV7Schema,
  mode: scheduleModeSchema,
  objective: z.string().max(LIMITS.objectiveMax).nullable().default(null),
  cronExpr: z.string().min(1).max(SCHEDULE_CRON_MAX),
  timezone: z.string().min(1).max(SCHEDULE_TIMEZONE_MAX),
  overlapPolicy: scheduleOverlapPolicySchema.default('skip'),
  catchUpPolicy: scheduleCatchUpPolicySchema.default('skip'),
  catchUpWindowMinutes: z
    .number()
    .int()
    .min(0)
    .max(SCHEDULE_CATCH_UP_WINDOW_MAX_MINUTES)
    .default(SCHEDULE_CATCH_UP_WINDOW_DEFAULT_MINUTES),
  budgets: budgetsSchema.default({}),
  enabled: z.boolean().default(true),
});
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;

/** A stored schedule (`schedules`). Instants are UTC; the fire fields are null until the scheduler sets them. */
export const scheduleRowSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    publicId: schedulePublicIdSchema,
    name: labelSchema,
    assetIds: z.array(uuidV7Schema).min(1).max(SCHEDULE_ASSET_IDS_MAX),
    saId: uuidV7Schema,
    mode: scheduleModeSchema,
    objective: z.string().max(LIMITS.objectiveMax).nullable(),
    cronExpr: z.string().min(1).max(SCHEDULE_CRON_MAX),
    timezone: z.string().min(1).max(SCHEDULE_TIMEZONE_MAX),
    overlapPolicy: scheduleOverlapPolicySchema,
    catchUpPolicy: scheduleCatchUpPolicySchema,
    catchUpWindowMinutes: z.number().int().min(0).max(SCHEDULE_CATCH_UP_WINDOW_MAX_MINUTES),
    budgets: budgetsSchema.nullable(),
    enabled: z.boolean(),
    temporalScheduleId: z.string().min(1).nullable(),
    lastFireAt: isoDateTimeSchema.nullable(),
    nextFireAt: isoDateTimeSchema.nullable(),
    createdBy: uuidV7Schema,
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type Schedule = z.infer<typeof scheduleRowSchema>;

/**
 * A stored blackout window (`blackout_windows`). A half-open interval: suppressed from `startsAt` (inclusive) to
 * `endsAt` (exclusive). A tenant-wide window carries no asset ids; an asset window must name at least one.
 */
export const blackoutWindowRowSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    scope: blackoutScopeSchema,
    assetIds: assetIdsSchema.nullable(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    reason: z.string().max(LIMITS.reasonMax).nullable(),
    createdBy: uuidV7Schema,
    ...timestampsShape,
  })
  .superRefine((window, ctx) => {
    if (!isBefore(window.startsAt, window.endsAt)) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    }
    if (window.scope === 'asset' && (window.assetIds === null || window.assetIds.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetIds'],
        message: 'an asset blackout window must name at least one asset',
      });
    }
    if (window.scope === 'tenant' && window.assetIds !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetIds'],
        message: 'a tenant blackout window must not name assets',
      });
    }
    checkTimestamps(window, ctx);
  });
export type BlackoutWindow = z.infer<typeof blackoutWindowRowSchema>;
