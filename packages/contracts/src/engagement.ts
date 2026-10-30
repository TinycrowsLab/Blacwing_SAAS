import { z } from 'zod';

import { subtaskBriefSchema, SUBTASK_LIFECYCLE_STATUSES } from './dispatch.js';
import { RUN_STATES } from './entities/run.js';
import { TEST_CASE_STATUSES, type TestCaseStatus } from './entities/test-case.js';
import { intrusivenessClassSchema } from './intrusiveness.js';
import { LIMITS } from './limits.js';
import { cweIdSchema, uuidV7Schema } from './primitives.js';

/**
 * Contracts of the engagement tools the orchestrator uses (MCP-012, #677; CONTEXT_PACK §4.2, REFERENCES §8.2).
 * The tools reach the Run Broker (`/internal/broker/runs/{runId}/engagement/*`) with a run-scoped token; the
 * broker is the only place that decides a status change or a dispatch.
 */

/** The statuses `mark_test_case_status` may set: the execution outcomes an orchestrator reports (§7). */
export const TEST_CASE_MARK_STATUSES = Object.freeze([
  'executing',
  'executed',
  'skipped',
  'blocked',
  'failed',
  'model_declined',
  'not_applicable',
] as const);
export const testCaseMarkStatusSchema = z.enum(TEST_CASE_MARK_STATUSES);
export type TestCaseMarkStatus = z.infer<typeof testCaseMarkStatusSchema>;

/**
 * Allowed `test_cases.status` transitions for the engagement tools. Terminal outcomes have no way out. A
 * `blocked` case may be retried (`executing`) once its blocker is gone. Anything else is refused.
 */
export const TEST_CASE_STATUS_TRANSITIONS: Readonly<
  Record<TestCaseStatus, readonly TestCaseStatus[]>
> = Object.freeze({
  proposed: [],
  approved: ['executing', 'skipped', 'blocked', 'not_applicable'],
  removed: [],
  executing: ['executed', 'failed', 'blocked', 'skipped', 'model_declined', 'not_applicable'],
  executed: [],
  skipped: [],
  blocked: ['executing', 'skipped', 'not_applicable'],
  failed: [],
  model_declined: [],
  not_applicable: [],
});

/** True when the engagement tools may move a test case from `from` to `to`. Pure: the broker and tests share it. */
export function canTransitionTestCase(from: TestCaseStatus, to: TestCaseStatus): boolean {
  return TEST_CASE_STATUS_TRANSITIONS[from].includes(to);
}

/** A subtask brief travels as one string into a fresh sandbox, so it is bounded (§8.2). */
export const DISPATCH_BRIEF_MAX_BYTES = 16_384;
const REASON_MAX = LIMITS.reasonMax;
const LIST_MAX = 100;
const REFS_MAX = 50;

/** Name of the Run Controller update that dispatches a specialist (ORCH-007; the worker's `DISPATCH_SUBTASK_UPDATE` must equal it). */
export const DISPATCH_SUBTASK_UPDATE = 'dispatchSubtask';

/** Run Controller workflow id of a run's execution phase. The phase starter and the broker both derive it here. */
export const executionWorkflowId = (runId: string): string => `execution-${runId}`;

/** `dispatch_subtask` input. `subtaskId` is the idempotency key; the brief is capped in bytes, not only by fields. */
export const engagementDispatchInputSchema = z.strictObject({
  persona: z.string().min(1).max(LIMITS.keyMax),
  subtaskId: uuidV7Schema,
  testCaseId: uuidV7Schema,
  brief: subtaskBriefSchema.refine(
    (brief) =>
      new TextEncoder().encode(JSON.stringify(brief)).byteLength <= DISPATCH_BRIEF_MAX_BYTES,
    { message: `brief must be at most ${String(DISPATCH_BRIEF_MAX_BYTES)} bytes` },
  ),
});
export type EngagementDispatchInput = z.infer<typeof engagementDispatchInputSchema>;

/** Why the Run Controller refused a dispatch. Mirrors `DISPATCH_REJECTION_CODES`; a refusal is a value, not an error. */
export const engagementDispatchResultSchema = z.discriminatedUnion('accepted', [
  z.strictObject({
    accepted: z.literal(true),
    subtaskId: uuidV7Schema,
    status: z.enum(SUBTASK_LIFECYCLE_STATUSES),
    created: z.boolean(),
  }),
  z.strictObject({
    accepted: z.literal(false),
    code: z.string().min(1).max(LIMITS.keyMax),
    message: z.string().max(REASON_MAX),
  }),
]);
export type EngagementDispatchResult = z.infer<typeof engagementDispatchResultSchema>;

/** `get_subtask_result` answer. A subtask still in flight is `pending`, not an error (§4.2). */
export const engagementSubtaskResultSchema = z.strictObject({
  subtaskId: uuidV7Schema,
  status: z.enum(SUBTASK_LIFECYCLE_STATUSES),
  pending: z.boolean(),
  result: z
    .record(z.string().max(LIMITS.keyMax), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable(),
});
export type EngagementSubtaskResult = z.infer<typeof engagementSubtaskResultSchema>;

/** Run phase, test-case counts by status, subtask counts by status and confirmed findings (`get_engagement_state`). */
export const engagementStateSchema = z.strictObject({
  runId: uuidV7Schema,
  phase: z.enum(RUN_STATES),
  testCases: z.record(z.enum(TEST_CASE_STATUSES), z.int().nonnegative()),
  subtasks: z.record(z.enum(SUBTASK_LIFECYCLE_STATUSES), z.int().nonnegative()),
  confirmedFindings: z.int().nonnegative(),
});
export type EngagementState = z.infer<typeof engagementStateSchema>;

/** One approved test case with no subtask yet, and the personas whose mandate covers its standards. */
export const engagementOpenSubtaskSchema = z.strictObject({
  testCaseId: uuidV7Schema,
  class: intrusivenessClassSchema,
  cwe: z.array(cweIdSchema).max(REFS_MAX),
  wstg: z.array(z.string().min(1).max(LIMITS.keyMax)).max(REFS_MAX),
  owasp: z.array(z.string().min(1).max(LIMITS.keyMax)).max(REFS_MAX),
  eligiblePersonas: z.array(z.string().min(1).max(LIMITS.keyMax)).max(REFS_MAX),
});
export const engagementOpenSubtasksSchema = z.strictObject({
  items: z.array(engagementOpenSubtaskSchema).max(LIST_MAX),
});
export type EngagementOpenSubtask = z.infer<typeof engagementOpenSubtaskSchema>;
export type EngagementOpenSubtasks = z.infer<typeof engagementOpenSubtasksSchema>;

/** `mark_test_case_status` input: an outcome from the allowed set, always with a reason. */
export const engagementMarkTestCaseInputSchema = z.strictObject({
  testCaseId: uuidV7Schema,
  status: testCaseMarkStatusSchema,
  reason: z.string().min(1).max(REASON_MAX),
});
export type EngagementMarkTestCaseInput = z.infer<typeof engagementMarkTestCaseInputSchema>;

export const engagementMarkTestCaseResultSchema = z.strictObject({
  testCaseId: uuidV7Schema,
  status: z.enum(TEST_CASE_STATUSES),
  previousStatus: z.enum(TEST_CASE_STATUSES),
});
export type EngagementMarkTestCaseResult = z.infer<typeof engagementMarkTestCaseResultSchema>;

/** `request_mentor_review` input: a stalled subtask and why the orchestrator wants a second look. */
export const engagementMentorReviewInputSchema = z.strictObject({
  subtaskId: uuidV7Schema,
  reason: z.string().min(1).max(REASON_MAX),
});
export type EngagementMentorReviewInput = z.infer<typeof engagementMentorReviewInputSchema>;

export const engagementMentorReviewResultSchema = z.strictObject({
  reviewId: uuidV7Schema,
  status: z.literal('requested'),
});
export type EngagementMentorReviewResult = z.infer<typeof engagementMentorReviewResultSchema>;

/** `request_scope_exception` input: an out-of-envelope target and the justification. */
export const engagementScopeExceptionInputSchema = z.strictObject({
  target: z.string().min(1).max(LIMITS.urlMax),
  reason: z.string().min(1).max(REASON_MAX),
});
export type EngagementScopeExceptionInput = z.infer<typeof engagementScopeExceptionInputSchema>;

/** The Gate 2 row the request opened (or the existing row for the same target while it is undecided). */
export const engagementScopeExceptionResultSchema = z.strictObject({
  decisionId: uuidV7Schema,
  gate: z.literal(2),
  status: z.enum(['pending', 'approved', 'denied']),
});
export type EngagementScopeExceptionResult = z.infer<typeof engagementScopeExceptionResultSchema>;
