import {
  type AcceptedRisk,
  type AssetType,
  type FindingStatus,
  type GateDecision,
  type GateDecisionInput,
  LIMITS,
  uuidV7Schema,
} from '@blackwing/contracts';
import { AppError, type AppErrorOptions, ValidationError } from '@blackwing/errors';
import { fromIso, toIso } from '@blackwing/time';

import { nextVersion } from '../run/state.js';

/**
 * Finding triage transitions (TRIAGE-001, CONTEXT_PACK §3.4, §8.4, §8.8, §8.11). Pure and side-effect free: the
 * caller passes the facts it loaded (inside the tenant's transaction), the request and the clock, and gets back the
 * next state, the Gate 3 decision row and the audit intent to write. The database layer (`@blackwing/db`,
 * `FindingTriageRepository`) applies them with a `state_version` compare-and-set, so two writers cannot both release
 * the same finding.
 *
 *   confirmed --released------------> released              (needs a scored severity and bound evidence)
 *   confirmed --rejected_false_positive--> rejected_false_positive
 *   confirmed --duplicate------------> duplicate            (needs a canonical finding of the same asset class)
 *   confirmed --accepted_risk--------> accepted_risk        (needs a reason and a future expiry)
 *
 * Every target needs a reason. Every decision is deterministic: no model output is an input (§8.11). Separation of
 * duties for Gate 3 is not required (§8.4), but the SoD hook point (`assertTriageActor` in the caller's ports) is
 * where TRIAGE-004 adds its check without changing these signatures.
 *
 * Kill switch: a run that is `killed` does not block triage. The guards read no run state, so a Confirmed finding of a
 * killed run can still be released, rejected, marked duplicate or accepted (the kill stops traffic, not review).
 */

/** The four targets of triage. Every other status change is outside this module (validation, remediation, baseline). */
export const TRIAGE_TARGETS = [
  'released',
  'rejected_false_positive',
  'duplicate',
  'accepted_risk',
] as const;
export type TriageTarget = (typeof TRIAGE_TARGETS)[number];

/** Statuses a canonical finding of a duplicate may have: a real, not rejected, finding. */
const CANONICAL_STATUSES: readonly FindingStatus[] = [
  'confirmed',
  'released',
  'accepted_risk',
  'fixed',
  'returned',
];

/** Gate 3 outcome of each target: a release or an accepted risk is an approval; the other two are rejections. */
export const TRIAGE_GATE_DECISION: Readonly<
  Record<TriageTarget, Extract<GateDecision, 'approved' | 'rejected'>>
> = Object.freeze({
  released: 'approved',
  accepted_risk: 'approved',
  rejected_false_positive: 'rejected',
  duplicate: 'rejected',
});

/** The audit action each target writes (§8.8), in addition to its gate decision row. */
export const TRIAGE_AUDIT_ACTION: Readonly<Record<TriageTarget, TriageAuditAction>> = Object.freeze(
  {
    released: 'finding.released',
    accepted_risk: 'finding.risk_accepted',
    rejected_false_positive: 'finding.rejected',
    duplicate: 'finding.marked_duplicate',
  },
);

export type TriageAuditAction =
  'finding.released' | 'finding.risk_accepted' | 'finding.rejected' | 'finding.marked_duplicate';

/** Gate of every triage decision (`gate_decisions.gate`). */
export const TRIAGE_GATE = 3;

/** Metric counted for every accepted triage transition: `triage_transition_total{to}`. */
export const TRIAGE_TRANSITION_METRIC = 'triage_transition_total';
/** Label names of {@link TRIAGE_TRANSITION_METRIC}. */
export const TRIAGE_TRANSITION_METRIC_LABELS = ['to'] as const;

/** The finding fields the guards read. The caller loads them in the tenant's transaction. */
export interface TriageFindingFacts {
  readonly id: string;
  readonly status: FindingStatus;
  /** `findings.state_version` at read time: the next state carries `nextVersion(stateVersion)`. */
  readonly stateVersion: number;
  /** The asset class of the finding's asset, or null when the asset is not visible (fails duplicates closed). */
  readonly assetType: AssetType | null;
  /** True when a severity is recorded (the validator scored the finding, FINDING-005). */
  readonly scored: boolean;
  /** True when the finding has a bound evidence chain (an occurrence with an evidence chain head). */
  readonly evidenceBound: boolean;
  /** True when another finding already names this one as its canonical finding. */
  readonly hasDuplicates: boolean;
}

/** The canonical finding a duplicate points at. `null` (not passed) when it is not visible in this tenant. */
export interface TriageCanonicalFacts {
  readonly id: string;
  readonly status: FindingStatus;
  readonly assetType: AssetType | null;
}

/** What the caller asks for. `reason`, `expiresAt` and `canonicalFindingId` are validated here, never trusted. */
export interface TriageInput {
  readonly to: TriageTarget;
  /** The authenticated user who decides. Recorded as the gate decision's actor (and as `released_by`). */
  readonly actorId: string;
  /** Required for every target. Trimmed; must not be blank. */
  readonly reason: string;
  /** The caller's clock: used by the accepted-risk expiry guard and as the decision time. */
  readonly now: Date;
  /** Required for `accepted_risk`: an ISO-8601 instant with an offset or `Z`, strictly in the future. */
  readonly expiresAt?: string | undefined;
  /** Required for `duplicate`: the canonical finding's id (same tenant, same asset class). */
  readonly canonicalFindingId?: string | undefined;
}

/** The fields a triage transition writes to `findings` (besides `state_version`). */
export interface TriageState {
  readonly status: FindingStatus;
  readonly stateVersion: number;
  /** Set exactly for `accepted_risk` (`findings.accepted_risk`). */
  readonly acceptedRisk: AcceptedRisk | null;
  /** Set exactly for `duplicate` (`findings.duplicate_of`). */
  readonly duplicateOf: string | null;
  /** Set for `released` (`findings.released_by`). */
  readonly releasedBy: string | null;
  /** Set for `released` (`findings.released_at`). */
  readonly releasedAt: Date | null;
}

/** What the caller writes to `audit_events`, in the same transaction as the change (§8.8). Ids and statuses only. */
export interface TriageAuditIntent {
  readonly action: TriageAuditAction;
  readonly findingId: string;
  readonly from: FindingStatus;
  readonly to: TriageTarget;
  readonly actorId: string;
}

export interface TriageTransitionResult {
  readonly next: TriageState;
  /** The Gate 3 `gate_decisions` row, ready for `recordGateDecision` (`subjectType: finding`, not auto). */
  readonly gate: GateDecisionInput;
  readonly auditIntent: TriageAuditIntent;
}

/** An event the finding lifecycle does not allow from the finding's status (`FINDING_ILLEGAL_TRANSITION`, 409). */
export class IllegalFindingTransitionError extends AppError {
  declare readonly code: 'FINDING_ILLEGAL_TRANSITION';
  /** Status the finding was in. */
  readonly from: string;
  /** Status that was requested. */
  readonly to: string;

  constructor(from: string, to: string, options: AppErrorOptions = {}) {
    super('FINDING_ILLEGAL_TRANSITION', `Illegal finding transition: ${from} to ${to}`, {
      detail: `A finding in status "${from}" cannot take this triage decision.`,
      ...options,
    });
    this.from = from;
    this.to = to;
  }
}

/** The refusals of triage other than the illegal transition. Each carries its own stable code. */
export class FindingTriageError extends AppError {
  declare readonly code:
    | 'TRIAGE_REASON_REQUIRED'
    | 'TRIAGE_EXPIRY_INVALID'
    | 'TRIAGE_CANONICAL_INVALID'
    | 'TRIAGE_PRECONDITION_FAILED';

  constructor(code: FindingTriageError['code'], detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { detail, ...options });
  }
}

/** The state after a refused transition is never produced: the function throws before it returns anything. */
function refuse(code: FindingTriageError['code'], detail: string): never {
  throw new FindingTriageError(code, detail);
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (reason === '') {
    refuse('TRIAGE_REASON_REQUIRED', 'Give a reason for this triage decision.');
  }
  if (reason.length > LIMITS.reasonMax) {
    throw new ValidationError('The triage reason is too long.', {
      detail: `A triage reason is at most ${LIMITS.reasonMax} characters.`,
    });
  }
  return reason;
}

/**
 * Parses the accepted-risk expiry. Only an RFC 3339 instant with an explicit offset (or `Z`) is accepted; it is
 * normalised to canonical UTC milliseconds. A missing, unparsable, offsetless or past instant is refused.
 */
function requireFutureExpiry(raw: string | undefined, now: Date): Date {
  if (raw === undefined) {
    refuse('TRIAGE_EXPIRY_INVALID', 'An accepted risk needs an expiry.');
  }
  let expiry: Date;
  try {
    expiry = fromIso(raw, { accept: 'rfc3339' });
  } catch {
    refuse(
      'TRIAGE_EXPIRY_INVALID',
      'The accepted-risk expiry must be an ISO-8601 instant with an offset.',
    );
  }
  // Written as a negation so an invalid `now` (NaN) also refuses instead of accepting an expiry.
  if (!(expiry.getTime() > now.getTime())) {
    refuse('TRIAGE_EXPIRY_INVALID', 'The accepted-risk expiry must be in the future.');
  }
  return expiry;
}

/**
 * A duplicate's canonical finding: a valid id that is not the finding itself, visible in this tenant, in a status a
 * canonical finding may have, of the same asset class. A finding that others already duplicate cannot itself become
 * a duplicate, so no chain or cycle can form (the canonical is never a duplicate, and nothing points at a duplicate).
 */
function requireCanonical(
  finding: TriageFindingFacts,
  canonicalFindingId: string | undefined,
  canonical: TriageCanonicalFacts | null | undefined,
): string {
  if (canonicalFindingId === undefined || !uuidV7Schema.safeParse(canonicalFindingId).success) {
    refuse('TRIAGE_CANONICAL_INVALID', 'A duplicate needs the id of its canonical finding.');
  }
  if (canonicalFindingId === finding.id) {
    refuse('TRIAGE_CANONICAL_INVALID', 'A finding cannot be a duplicate of itself.');
  }
  if (finding.hasDuplicates) {
    refuse(
      'TRIAGE_CANONICAL_INVALID',
      'A finding that other findings duplicate cannot be a duplicate.',
    );
  }
  // A missing canonical covers "another tenant's" too: RLS hides it, and the answer does not say which.
  if (canonical?.id !== canonicalFindingId) {
    refuse('TRIAGE_CANONICAL_INVALID', 'The canonical finding was not found.');
  }
  if (!CANONICAL_STATUSES.includes(canonical.status)) {
    refuse(
      'TRIAGE_CANONICAL_INVALID',
      'The canonical finding is not in a status that can be canonical.',
    );
  }
  if (finding.assetType === null || canonical.assetType !== finding.assetType) {
    refuse('TRIAGE_CANONICAL_INVALID', 'The canonical finding must be on the same asset class.');
  }
  return canonical.id;
}

/**
 * Applies one triage decision to a finding and returns the next state, the Gate 3 decision and the audit intent.
 *
 * Refusals, all before anything is returned (so nothing is written):
 * - a finding not in `confirmed`, or an unknown target: `FINDING_ILLEGAL_TRANSITION` (409);
 * - a blank reason: `TRIAGE_REASON_REQUIRED` (422); a reason over `LIMITS.reasonMax`: `VALIDATION_FAILED` (422);
 * - an `accepted_risk` without an offset-bearing expiry in the future: `TRIAGE_EXPIRY_INVALID` (422);
 * - a `duplicate` without a valid same-tenant canonical finding of the same asset class: `TRIAGE_CANONICAL_INVALID` (422);
 * - a `released` finding without a scored severity or bound evidence: `TRIAGE_PRECONDITION_FAILED` (409).
 *
 * `canonical` is the canonical finding as the caller loaded it (`null` when not visible). Only `duplicate` reads it.
 * The inputs are never mutated.
 */
export function transitionFinding(
  finding: TriageFindingFacts,
  input: TriageInput,
  canonical?: TriageCanonicalFacts | null,
): TriageTransitionResult {
  const target = TRIAGE_TARGETS.find((candidate) => candidate === input.to);
  if (target === undefined || finding.status !== 'confirmed') {
    throw new IllegalFindingTransitionError(finding.status, input.to);
  }

  const reason = requireReason(input.reason);
  const { now } = input;

  let acceptedRisk: AcceptedRisk | null = null;
  let duplicateOf: string | null = null;
  let releasedBy: string | null = null;
  let releasedAt: Date | null = null;

  switch (target) {
    case 'released':
      if (!finding.scored || !finding.evidenceBound) {
        refuse(
          'TRIAGE_PRECONDITION_FAILED',
          'A finding needs a scored severity and bound evidence before it is released.',
        );
      }
      releasedBy = input.actorId;
      releasedAt = now;
      break;
    case 'accepted_risk':
      acceptedRisk = {
        reason,
        expiresAt: toIso(requireFutureExpiry(input.expiresAt, now)),
      };
      break;
    case 'duplicate':
      duplicateOf = requireCanonical(finding, input.canonicalFindingId, canonical);
      break;
    case 'rejected_false_positive':
      break;
  }

  const gate: GateDecisionInput = {
    gate: TRIAGE_GATE,
    subjectType: 'finding',
    subjectId: finding.id,
    decision: TRIAGE_GATE_DECISION[target],
    requesterId: null,
    actorId: input.actorId,
    reason,
    decidedAt: now,
    timeoutAt: null,
    auto: false,
  };

  return {
    next: {
      status: target,
      stateVersion: nextVersion(finding.stateVersion),
      acceptedRisk,
      duplicateOf,
      releasedBy,
      releasedAt,
    },
    gate,
    auditIntent: {
      action: TRIAGE_AUDIT_ACTION[target],
      findingId: finding.id,
      from: finding.status,
      to: target,
      actorId: input.actorId,
    },
  };
}
