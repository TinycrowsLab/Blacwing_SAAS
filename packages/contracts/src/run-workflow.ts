import { z } from 'zod';

import { runBudgetSchema } from './budget.js';
import { killScopeSchema } from './entities/kill.js';
import { runModeSchema, runPauseReasonSchema, runStateSchema } from './entities/run.js';
import { LIMITS } from './limits.js';
import { uuidV7Schema } from './primitives.js';

/**
 * Contract of the `AssessmentRunWorkflow` (ORCH-002, CONTEXT_PACK §4.2): its input, the signal and
 * query names and payloads. Defined once here so `apps/api` (the signaler) and `apps/worker` (the
 * workflow) cannot drift. Pure data and schemas: safe to import into the deterministic workflow bundle.
 */

/** Workflow type name; clients start the run controller by this name. */
export const ASSESSMENT_RUN_WORKFLOW = 'AssessmentRunWorkflow';

/** The Temporal workflow id of a run (`run_<id>`): one workflow per run, so a restart cannot duplicate it. */
export function runWorkflowId(runId: string): string {
  return `run_${runId}`;
}

/** Most asset ids one run may carry; Zod rejects an oversized input before the workflow starts. */
export const RUN_INPUT_MAX_ASSETS = 500;
/** Most pinned entries in a run manifest. */
const RUN_MANIFEST_MAX_ENTRIES = 64;
/** Most finding ids one Gate 3 release signal may carry. */
export const RUN_RELEASE_MAX_FINDINGS = 1000;

/**
 * Pinned versions (§8.9), name -> version or digest. Bounded so the workflow history stays small.
 */
const runManifestSchema = z
  .record(z.string().min(1).max(LIMITS.keyMax), z.string().min(1).max(LIMITS.shortTextMax))
  .refine(
    (m) => Object.keys(m).length <= RUN_MANIFEST_MAX_ENTRIES,
    'run manifest has too many entries',
  );

/** Input of `AssessmentRunWorkflow`. */
export const runInputSchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  saId: uuidV7Schema,
  /** The requesting user: the Gate 1 and Gate 3 approver must differ from them (§8.4). */
  requestedBy: uuidV7Schema,
  mode: runModeSchema,
  assetIds: z.array(uuidV7Schema).min(1).max(RUN_INPUT_MAX_ASSETS),
  objective: z.string().min(1).max(LIMITS.objectiveMax),
  runManifest: runManifestSchema,
  budgets: runBudgetSchema,
});
export type RunInput = z.infer<typeof runInputSchema>;

/** Who sent a signal. `system` for timers and platform components; a person otherwise. */
export const runSignalActorSchema = z.strictObject({
  kind: z.enum(['user', 'system']),
  id: z.string().min(1).max(LIMITS.subjectMax),
});
export type RunSignalActor = z.infer<typeof runSignalActorSchema>;

const actor = { actor: runSignalActorSchema };

export const pauseSignalSchema = z.strictObject({ ...actor, reason: runPauseReasonSchema });
export const resumeSignalSchema = z.strictObject({ ...actor });
export const gate1DecisionSignalSchema = z.strictObject({
  ...actor,
  decision: z.enum(['approved', 'rejected']),
  /** True only when every test case is inside the standing authorisation (system actor only). */
  autoApproved: z.boolean().optional(),
});
export const gate2DecisionSignalSchema = z.strictObject({
  ...actor,
  subtaskId: z.string().min(1).max(LIMITS.keyMax),
  decision: z.enum(['approved', 'denied']),
});
export const gate3ReleasedSignalSchema = z.strictObject({
  ...actor,
  findingIds: z.array(uuidV7Schema).min(1).max(RUN_RELEASE_MAX_FINDINGS),
});
/** Positive increments; at least one dimension. */
export const increaseBudgetSignalSchema = z.strictObject({
  ...actor,
  delta: runBudgetSchema
    .partial()
    .refine((d) => Object.keys(d).length > 0, 'delta must name at least one dimension'),
});
export const killSignalSchema = z.strictObject({
  ...actor,
  scope: killScopeSchema,
  reason: z.string().max(LIMITS.reasonMax).optional(),
});
export const systemSignalSchema = z.strictObject({ ...actor });

/** Signal names (one place; the API imports these). */
export const RUN_SIGNALS = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  gate1Decision: 'gate1Decision',
  gate2Decision: 'gate2Decision',
  gate3Released: 'gate3Released',
  increaseBudget: 'increaseBudget',
  kill: 'kill',
  saExpired: 'saExpired',
  windowClosed: 'windowClosed',
} as const);

/** Query names (one place; the API imports these). */
export const RUN_QUERIES = Object.freeze({
  getState: 'getState',
  getPhase: 'getPhase',
  getBudgetRemaining: 'getBudgetRemaining',
  getOpenSubtasks: 'getOpenSubtasks',
  getSummary: 'getSummary',
} as const);

/** `getState()` result: the live state and its optimistic-concurrency version. */
export const runStateViewSchema = z.strictObject({
  state: runStateSchema,
  version: z.int().min(0),
  pauseReason: runPauseReasonSchema.nullable(),
});
export type RunStateView = z.infer<typeof runStateViewSchema>;

/** `getBudgetRemaining()` result. */
export type RunBudgetRemaining = z.infer<typeof runBudgetSchema>;

/** `getSummary()` result, for the console live view. */
export const runSummarySchema = z.strictObject({
  runId: uuidV7Schema,
  tenantId: uuidV7Schema,
  mode: runModeSchema,
  state: runStateSchema,
  version: z.int().min(0),
  pauseReason: runPauseReasonSchema.nullable(),
  /** The phase being worked: for a paused run, the state it resumes to. */
  phase: runStateSchema,
  budgetRemaining: runBudgetSchema,
  openSubtasks: z.array(z.string()),
  releasedFindingIds: z.array(z.string()),
  /** Signals refused as illegal (or not allowed) so far. */
  ignoredSignals: z.int().min(0),
  /** Why the run failed, when `state` is `failed` because of the controller. */
  failureReason: z.string().nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * The budget after adding `delta` to each named dimension, or `null` when the result would break the
 * platform ceilings (the whole increase is refused rather than clamped silently).
 */
export function raiseRunBudget(
  budgets: RunBudgetRemaining,
  delta: z.infer<typeof increaseBudgetSignalSchema>['delta'],
): RunBudgetRemaining | null {
  const raised = runBudgetSchema.safeParse({
    costCapUsd: budgets.costCapUsd + (delta.costCapUsd ?? 0),
    maxRequests: budgets.maxRequests + (delta.maxRequests ?? 0),
    maxDurationMs: budgets.maxDurationMs + (delta.maxDurationMs ?? 0),
  });
  return raised.success ? raised.data : null;
}
