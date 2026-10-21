import { z } from 'zod';

import { runBudgetSchema } from '../budget.js';
import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isBefore,
  isoDateTimeSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/** Assessment mode (§7 `runs.mode`). */
export const runModeSchema = z.enum(['black', 'grey', 'white']);
export type RunMode = z.infer<typeof runModeSchema>;

/** What started the run (§7 `runs.trigger`). */
export const runTriggerSchema = z.enum(['console', 'api', 'ci', 'schedule', 'retest']);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/**
 * Run states, §3.3. The transition rules (guards, actors, audit) live in `packages/domain/run`; this is
 * only the set of values `runs.state` may hold.
 */
export const runStateSchema = z.enum([
  'draft',
  'preflight',
  'recon',
  'planning',
  'awaiting_gate1',
  'approved',
  'executing',
  'paused',
  'validating',
  'awaiting_gate3',
  'released',
  'reporting',
  'completed',
  'cancelled',
  'killed',
  'failed',
  'expired',
]);
export type RunState = z.infer<typeof runStateSchema>;

/** Terminal run states (§3.3). */
export const TERMINAL_RUN_STATES: readonly RunState[] = Object.freeze([
  'completed',
  'cancelled',
  'killed',
  'failed',
  'expired',
]);

/** Why an `executing` run is `paused` (§3.3). */
export const runPauseReasonSchema = z.enum([
  'gate2_pending',
  'cost_cap',
  'operator_pause',
  'window_closed',
]);
export type RunPauseReason = z.infer<typeof runPauseReasonSchema>;

/**
 * An assessment run, §7 `assessment_requests / runs`.
 *
 * `runManifest` holds the pinned versions (§8.9) as name → version/digest; its full shape belongs to the
 * run-manifest issue. Rules: `pauseReason` is set exactly when `state` is `paused`; `endedAt` is set for
 * terminal states only and never precedes `startedAt`.
 */
export const runSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    mode: runModeSchema,
    objective: z.string().min(1).max(LIMITS.objectiveMax),
    assetIds: z.array(uuidV7Schema).min(1),
    saId: uuidV7Schema,
    inputManifestId: uuidV7Schema.nullable(),
    state: runStateSchema,
    pauseReason: runPauseReasonSchema.nullable(),
    stateVersion: z.int().min(0),
    runManifest: z.record(z.string().min(1), z.string().min(1)).nullable(),
    budgets: runBudgetSchema,
    requestedBy: uuidV7Schema,
    trigger: runTriggerSchema,
    startedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    ...timestampsShape,
  })
  .superRefine((run, ctx) => {
    checkTimestamps(run, ctx);
    if ((run.state === 'paused') !== (run.pauseReason !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'pauseReason must be set exactly when the run is paused',
      });
    }
    if (run.endedAt !== null && !TERMINAL_RUN_STATES.includes(run.state)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'only a terminal run has endedAt',
      });
    }
    if (run.startedAt !== null && run.endedAt !== null && isBefore(run.endedAt, run.startedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt must not be before startedAt',
      });
    }
  });
export type Run = z.infer<typeof runSchema>;
