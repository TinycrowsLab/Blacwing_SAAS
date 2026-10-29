import { z } from 'zod';

import { requestBudgetSchema } from './budget.js';
import { authorisableIntrusivenessSchema } from './entities/authorisation.js';
import { oracleSchema } from './entities/test-case.js';
import { LIMITS } from './limits.js';
import { cweIdSchema, uuidV7Schema } from './primitives.js';

/**
 * `dispatch_subtask` contract (ORCH-007, CONTEXT_PACK §4.2 / §7 `subtasks`, REFERENCES §8.2).
 * The brief is the ONLY thing that crosses into a specialist's fresh session, so it must be self-contained.
 */

/** Subtask lifecycle: `dispatched → running → (submitted | blocked | failed | model_declined | deferred)`. */
export const SUBTASK_LIFECYCLE_STATUSES = Object.freeze([
  'dispatched',
  'running',
  'submitted',
  'blocked',
  'failed',
  'model_declined',
  'deferred',
] as const);
export const subtaskStatusSchema = z.enum(SUBTASK_LIFECYCLE_STATUSES);
export type SubtaskLifecycleStatus = z.infer<typeof subtaskStatusSchema>;

/** Statuses a subtask can still leave: its session is alive (or about to be). */
export const SUBTASK_ACTIVE_STATUSES: readonly SubtaskLifecycleStatus[] = Object.freeze([
  'dispatched',
  'running',
]);

const MAX_REFS = 50;
const MAX_TARGETS = 100;
const refList = z.array(z.string().min(1).max(LIMITS.keyMax)).max(MAX_REFS);

/** The standards a specialist's candidate must cite. At least one id overall. */
export const subtaskStandardRefsSchema = z
  .strictObject({ wstg: refList, cwe: z.array(cweIdSchema).max(MAX_REFS), owasp: refList })
  .refine((refs) => refs.wstg.length + refs.cwe.length + refs.owasp.length > 0, {
    message: 'needs at least one WSTG, CWE or OWASP id',
  });

/** Everything a specialist needs to start cold (§8.2). Every field but `role` is required. */
export const subtaskBriefSchema = z.strictObject({
  targets: z.array(z.string().min(1).max(LIMITS.urlMax)).min(1).max(MAX_TARGETS),
  // A role id, not a display name: it becomes part of the egress identity `tc_<id>.role_<roleId>`.
  role: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'must be a role id')
    .optional(),
  class: authorisableIntrusivenessSchema,
  oracle: oracleSchema,
  negativeControl: oracleSchema,
  budget: requestBudgetSchema,
  standardRefs: subtaskStandardRefsSchema,
});
export type SubtaskBrief = z.infer<typeof subtaskBriefSchema>;

/** The `dispatchSubtask` signal/update payload. `subtaskId` is the idempotency key. */
export const dispatchSubtaskSchema = z.strictObject({
  subtaskId: uuidV7Schema,
  testCaseId: uuidV7Schema,
  persona: z.string().min(1).max(LIMITS.keyMax),
  brief: subtaskBriefSchema,
});
export type DispatchSubtask = z.infer<typeof dispatchSubtaskSchema>;

/** Why a dispatch was refused. The orchestrator reads it to back off, re-plan or stop. */
export const DISPATCH_REJECTION_CODES = Object.freeze([
  'INVALID_REQUEST',
  'BRIEF_INCOMPLETE',
  'UNKNOWN_PERSONA',
  'PERSONA_INELIGIBLE',
  'TEST_CASE_NOT_FOUND',
  'TEST_CASE_NOT_APPROVED',
  'REVERSAL_JOURNAL_MISSING',
  'RUN_NOT_EXECUTING',
  'RUN_TERMINATING',
  'CONCURRENCY_LIMIT',
  'BUDGET_UNAVAILABLE',
] as const);
export type DispatchRejectionCode = (typeof DISPATCH_REJECTION_CODES)[number];
