import {
  type GateDecision,
  type GateDecisionInput,
  gateDecisionInputSchema,
  type GateNumber,
  type GateSubjectType,
} from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { assertDifferentActors, type SodWarnSink } from '../sod/index.js';

/**
 * Gate decision write path (AUTHZ, CONTEXT_PACK §8.4, §8.8). Gate 1, Gate 2, Gate 3 and the SA approval all record
 * their outcome here. The separation-of-duties predicate and its error are RBAC-011's (`@blackwing/domain/sod`):
 * this module only calls them. Storage is a port, so the caller decides the transaction (the db package binds it to
 * `withTenant`, so the tenant context and RLS apply); the audit event is emitted through the same port inside that
 * transaction, so a decision that cannot be audited is not recorded.
 */

/** Gates whose manual approvals are separation-of-duties gated (§8.4). Gate 3 is not. */
const SOD_GATES: readonly GateNumber[] = [1, 2];

/** Metric counted for every recorded decision: `authz_gate_decisions_total{gate,decision}`. */
export const GATE_DECISION_METRIC = 'authz_gate_decisions_total';
/** Label names of {@link GATE_DECISION_METRIC}. */
export const GATE_DECISION_METRIC_LABELS = ['gate', 'decision'] as const;
/** Audit action written for every recorded decision. */
export const GATE_DECISION_AUDIT_ACTION = 'authz.gate.decision';

/** One stored decision (the `gate_decisions` row, without the tenant, which the storage port owns). */
export interface GateDecisionRow {
  readonly id: string;
  readonly gate: GateNumber;
  readonly subjectType: GateSubjectType;
  readonly subjectId: string;
  readonly decision: GateDecision;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly decidedAt: Date | null;
  readonly timeoutAt: Date | null;
  readonly auto: boolean;
}

/** Payload of `authz.gate.decision`. Ids only: no reason text, no secrets. */
export interface GateDecisionAuditEvent {
  readonly action: typeof GATE_DECISION_AUDIT_ACTION;
  readonly decisionId: string;
  readonly gate: GateNumber;
  readonly subjectType: GateSubjectType;
  readonly subjectId: string;
  readonly decision: GateDecision;
  /** Null for an automatic decision (the system principal). */
  readonly actorId: string | null;
  readonly auto: boolean;
}

export interface GateDecisionPorts {
  /** Inserts the row inside the caller's tenant transaction. A violated unique index rejects. */
  readonly insert: (row: GateDecisionRow) => Promise<void>;
  /** Appends the audit event inside the same transaction. A rejection rolls the decision back. */
  readonly audit: (event: GateDecisionAuditEvent) => Promise<void>;
  /** Counts the decision (optional). */
  readonly metrics?: {
    decided(labels: { readonly gate: GateNumber; readonly decision: GateDecision }): void;
  };
  /** Receives the SoD warning on a refusal (optional). */
  readonly logger?: SodWarnSink;
}

/**
 * Validates and records one gate decision.
 *
 * - An automatic decision (`auto: true`, decision `auto_approved`) has no actor and skips SoD; it is still audited.
 * - A manual Gate 1 or Gate 2 approval requires a requester and an actor who differ (`assertDifferentActors`:
 *   `SodViolationError`, reason `requester_equals_approver`, or `null_actor` when either id is missing).
 * - Gate 3 is not SoD-gated (§8.4), but a manual decision still needs an actor for the audit trail.
 *
 * Throws `ValidationError` for input that fails the contract. Nothing is written when a check refuses.
 */
export async function recordGateDecision(
  ports: GateDecisionPorts,
  rawInput: GateDecisionInput,
): Promise<GateDecisionRow> {
  const parsed = gateDecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('gate decision input is invalid', {
      detail: 'The gate decision does not match its contract.',
    });
  }
  const input = parsed.data;

  if (input.auto !== (input.decision === 'auto_approved')) {
    throw new ValidationError('auto decisions must be auto_approved, and only they are');
  }
  if (input.auto) {
    if (input.actorId !== null) {
      throw new ValidationError('an automatic decision carries no actor (system principal)');
    }
  } else if (SOD_GATES.includes(input.gate) && input.decision === 'approved') {
    assertDifferentActors(input.requesterId, input.actorId, `gate${input.gate}.approve`, {
      ...(ports.logger ? { logger: ports.logger } : {}),
    });
  } else if (input.actorId === null) {
    throw new ValidationError('a manual gate decision needs an actor');
  }

  const row: GateDecisionRow = {
    id: newId(),
    gate: input.gate,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    decision: input.decision,
    actorId: input.actorId,
    reason: input.reason,
    decidedAt: input.decidedAt,
    timeoutAt: input.timeoutAt,
    auto: input.auto,
  };
  await ports.insert(row);
  await ports.audit({
    action: GATE_DECISION_AUDIT_ACTION,
    decisionId: row.id,
    gate: row.gate,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    decision: row.decision,
    actorId: row.actorId,
    auto: row.auto,
  });
  ports.metrics?.decided({ gate: row.gate, decision: row.decision });
  return row;
}
