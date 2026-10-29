import { AppError } from '@blackwing/errors';

/**
 * Separation of duties (F31, CONTEXT_PACK §8.4, #352). This module is the single definition of the SoD
 * error and of the primitives that enforce `requester != approver`. SA approval, Gate 1, Gate 2, the
 * database generator and the Cedar condition all consume it. Nothing else may redefine it.
 */

/** Why a separation-of-duties check refused. Stable: it appears in logs, metrics and audit events. */
export const SOD_VIOLATION_REASONS = [
  'requester_equals_approver',
  'insufficient_approvers',
  'ineligible_approver',
  'null_actor',
] as const;

/** One of {@link SOD_VIOLATION_REASONS}. */
export type SodViolationReason = (typeof SOD_VIOLATION_REASONS)[number];

/** Structured log message for every refused check (logged at warn, with `{context, requesterId, actorId, reason}`). */
export const SOD_VIOLATION_LOG_MESSAGE = 'sod.violation';
/** Name of the counter incremented per refused check. */
export const SOD_VIOLATION_METRIC = 'sod_violations_total';
/** Label names of {@link SOD_VIOLATION_METRIC}. */
export const SOD_VIOLATION_METRIC_LABELS = ['context', 'reason'] as const;

/**
 * A separation-of-duties refusal (`code 'SOD_VIOLATION'`, HTTP 403). The client-facing `detail` names only the
 * reason, never the user ids; the ids go to the structured log instead.
 */
export class SodViolationError extends AppError {
  declare readonly code: 'SOD_VIOLATION';
  /** Why the check refused. */
  readonly reason: SodViolationReason;
  /** Caller-chosen name of the decision being checked (for example `sa.approve` or `gate1.approve`). */
  readonly context: string;

  constructor(reason: SodViolationReason, context: string, message?: string) {
    super('SOD_VIOLATION', message ?? `Separation of duties violated: ${reason}`, {
      detail: 'The approver is not allowed to approve this request.',
    });
    this.reason = reason;
    this.context = context;
  }
}
