import { z } from 'zod';

import { intrusivenessClassSchema } from './intrusiveness.js';
import { LIMITS } from './limits.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';

/**
 * Gate 2 runtime-exception contracts (GATE2-001, F13, F31, CONTEXT_PACK §3.2 step 8, §7, §8.2-§8.4).
 *
 * A Gate 2 exception is the record created when a tool call falls outside the approved envelope. It
 * starts `pending`, and the only ways out are an explicit, separation-of-duties-valid approval, an
 * explicit denial, the timeout (denied) or the run being killed or cancelled (denied). Nothing ever
 * defaults to allow. The table (`gate2_exceptions`) lives in `@blackwing/db`, the guarded state
 * machine in `@blackwing/domain`; the value lists below are the single source for both, and for the
 * check constraints behind them.
 */

/** Lifecycle of one exception. `approved_once` is the only state that allows the deferred call. */
export const GATE2_STATES = [
  'pending',
  'approved_once',
  'denied',
  'timed_out',
  'superseded',
] as const;
export const gate2StateSchema = z.enum(GATE2_STATES);
export type Gate2State = z.infer<typeof gate2StateSchema>;

/** States with no way out; a terminal exception is immutable. */
export const GATE2_TERMINAL_STATES = [
  'approved_once',
  'denied',
  'timed_out',
  'superseded',
] as const satisfies readonly Gate2State[];

/**
 * What a Gate 2 exception's decision records in `gate_decisions` (§7). A timeout, a supersede and an explicit
 * denial are all `denied`: an approval is the only outcome that lets the deferred call run.
 */
export const GATE2_DECISION_OUTCOMES = ['approved', 'denied'] as const;
export type Gate2DecisionOutcome = (typeof GATE2_DECISION_OUTCOMES)[number];

/** Longest `idempotency_key`; printable ASCII without spaces. */
export const GATE2_IDEMPOTENCY_KEY_MAX = 255;
export const gate2IdempotencyKeySchema = z
  .string()
  .regex(
    new RegExp(`^[\\x21-\\x7e]{1,${GATE2_IDEMPOTENCY_KEY_MAX}}$`),
    `must be 1-${GATE2_IDEMPOTENCY_KEY_MAX} printable ASCII characters without spaces`,
  );

/** Longest tool name and Cedar diagnostic. */
export const GATE2_TOOL_NAME_MAX = LIMITS.shortTextMax;
export const GATE2_ENVELOPE_REASON_MAX = LIMITS.reasonMax;

/**
 * The redacted summary of the deferred call (§8.7): a JSON object that references, never carries,
 * secret values. The writer redacts again as a safety net.
 */
export const gate2ProposedActionSchema = z.record(z.string(), z.json());
export type Gate2ProposedAction = z.infer<typeof gate2ProposedActionSchema>;

/** Input of creating an exception (GATE2-003 calls it). The tenant is never a field: it is the ambient one. */
export const gate2ExceptionCreateSchema = z.strictObject({
  runId: uuidV7Schema,
  sessionId: z.string().min(1).max(LIMITS.shortTextMax),
  subtaskId: uuidV7Schema.nullish(),
  testCaseId: uuidV7Schema.nullish(),
  toolName: z.string().min(1).max(GATE2_TOOL_NAME_MAX),
  proposedAction: gate2ProposedActionSchema,
  envelopeReason: z.string().min(1).max(GATE2_ENVELOPE_REASON_MAX),
  intrusiveness: intrusivenessClassSchema,
  batch: z.boolean().default(false),
  requesterId: uuidV7Schema.nullish(),
  planApproverId: uuidV7Schema.nullish(),
  /** When silence turns into a denial. Must lie in the future when the row is created. */
  timeoutAt: isoDateTimeSchema,
  idempotencyKey: gate2IdempotencyKeySchema,
});
export type Gate2ExceptionCreate = z.input<typeof gate2ExceptionCreateSchema>;

/** The two decisions a person can record; the timeout and the supersede are system events. */
export const GATE2_HUMAN_DECISIONS = ['approve', 'deny'] as const;
export const gate2HumanDecisionSchema = z.enum(GATE2_HUMAN_DECISIONS);
export type Gate2HumanDecision = z.infer<typeof gate2HumanDecisionSchema>;

/** A person's decision. The reason is mandatory: it lands in `gate_decisions` and the audit event. */
export const gate2DecideSchema = z.strictObject({
  exceptionId: uuidV7Schema,
  decision: gate2HumanDecisionSchema,
  /** `state_version` the decider saw; a stale value fails with `GATE2_ALREADY_DECIDED` semantics. */
  expectedStateVersion: z.int().nonnegative().max(LIMITS.int32Max).optional(),
  reason: z.string().trim().min(1).max(LIMITS.reasonMax),
});
export type Gate2Decide = z.input<typeof gate2DecideSchema>;

/** A persisted exception, as the API returns it. */
export const gate2ExceptionSchema = z.strictObject({
  id: uuidV7Schema,
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  sessionId: z.string(),
  subtaskId: uuidV7Schema.nullable(),
  testCaseId: uuidV7Schema.nullable(),
  toolName: z.string(),
  proposedAction: gate2ProposedActionSchema,
  envelopeReason: z.string(),
  intrusiveness: intrusivenessClassSchema,
  batch: z.boolean(),
  state: gate2StateSchema,
  stateVersion: z.int().nonnegative(),
  requesterId: uuidV7Schema.nullable(),
  planApproverId: uuidV7Schema.nullable(),
  decidedBy: uuidV7Schema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  timeoutAt: isoDateTimeSchema,
  idempotencyKey: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Gate2Exception = z.output<typeof gate2ExceptionSchema>;

/** Stable machine codes of the Gate 2 refusals; each is registered in `@blackwing/errors`. */
export const GATE2_ERROR_CODES = [
  'GATE2_ILLEGAL_TRANSITION',
  'GATE2_ALREADY_DECIDED',
  'GATE2_SOD_VIOLATION',
  'GATE2_DESTRUCTIVE_FORBIDDEN',
] as const;
export type Gate2ErrorCode = (typeof GATE2_ERROR_CODES)[number];

/**
 * Longest redacted action summary the broker stores (`proposedAction`, §8.7). A longer summary is cut to this
 * many UTF-8 bytes and marked `truncated`; the call's body stays with its evidence, never in the exception row.
 */
export const GATE2_ACTION_SUMMARY_MAX = 4096;
/** Largest summary the broker accepts before truncating (the body is refused above it). */
export const GATE2_ACTION_SUMMARY_INPUT_MAX = 65_536;

/**
 * Signal the broker sends to the run's workflow after it persists an exception (GATE2-002). The payload names the
 * exception only; the workflow reads the state back through the API, never trusts the signal for a decision.
 */
export const GATE2_EXCEPTION_RAISED_SIGNAL = 'gate2ExceptionRaised';

/**
 * `POST /internal/broker/gate2/exceptions` body, sent by the PDP `PreToolUse` hook when it defers a call (§3.3).
 * The run and tenant come from the run-scoped token, never from the body. The `Idempotency-Key` header is required
 * (§9); a retry with the same key returns the existing exception and never duplicates it.
 */
export const brokerGate2ExceptionRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(LIMITS.shortTextMax),
  subtaskId: uuidV7Schema.nullish(),
  testCaseId: uuidV7Schema.nullish(),
  toolName: z.string().min(1).max(GATE2_TOOL_NAME_MAX),
  proposedActionSummary: z.string().max(GATE2_ACTION_SUMMARY_INPUT_MAX),
  envelopeReason: z.string().min(1).max(GATE2_ENVELOPE_REASON_MAX),
  intrusiveness: intrusivenessClassSchema,
  batch: z.boolean().default(false),
});
export type BrokerGate2ExceptionRequest = z.output<typeof brokerGate2ExceptionRequestSchema>;

/** `POST /internal/broker/gate2/exceptions` answer: the exception and its state (`pending` on creation). */
export const brokerGate2ExceptionResponseSchema = z.strictObject({
  exceptionId: uuidV7Schema,
  state: gate2StateSchema,
});
export type BrokerGate2ExceptionResponse = z.infer<typeof brokerGate2ExceptionResponseSchema>;
