import type {
  AuditActor,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
  Gate1Decision,
  Gate1DecisionResponse,
  Gate1TestCase,
  RunEnvelope,
  RunState,
} from '@blackwing/contracts';
import type { EnvelopeSigningKey } from '@blackwing/crypto';

/**
 * The ports the Gate 1 service composes (#877, built on the Gate 1 decision contract of #398). The Postgres
 * adapter belongs to the tenant data-access layer (`withTenant`, RLS); until it lands the in-memory adapter in
 * `memory.ts` serves local development and tests. The service never reaches past these interfaces, so
 * swapping an adapter cannot change a separation-of-duties or state decision.
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface Gate1Principal {
  readonly type: 'user' | 'service';
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
}

/** One version of a test plan at Gate 1. */
export interface Gate1Plan {
  readonly planVersion: number;
  readonly requestedAt: string;
  /** Instant after which the approval window is closed; `null` when the plan carries no window. */
  readonly expiresAt: string | null;
  readonly testCases: readonly Gate1TestCase[];
}

/**
 * The standing authorisation a run is approved under: the facts the approved run envelope is built from (#399).
 * A run without one cannot be approved, because its envelope would have nothing to authorise.
 */
export type Gate1AuthorisationSource = Pick<
  RunEnvelope,
  | 'saId'
  | 'saExpiresAt'
  | 'assetIds'
  | 'scopeRules'
  | 'testWindows'
  | 'maxIntrusiveness'
  | 'budgets'
  | 'runWindowEndsAt'
>;

/**
 * The run envelope an approval pinned (#399, §8.9): the signed token by reference, plus the hash and key id the
 * run manifest carries. Re-approval after request-changes replaces the pin with a new `envelopeVersion`.
 */
export interface Gate1PinnedEnvelope {
  readonly jws: string;
  readonly envelopeHash: string;
  readonly signingKeyId: string;
  readonly envelopeVersion: number;
  readonly saId: string;
}

/** A run as the Gate 1 flow needs it. Tenant-scoped: a store never returns another tenant's run. */
export interface Gate1RunRecord {
  /** Public run id (`run_…`). */
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
  /** Monotonic run state version (`runs.state_version`); a transition must match it. */
  readonly stateVersion: number;
  /** The user who requested the run's plan. `null` is unknown and fails closed (§8.4). */
  readonly requesterId: string | null;
  readonly plan: Gate1Plan;
  /** The version the current plan replaced, for the diff the approver sees; `null` for a first version. */
  readonly priorPlan: Gate1Plan | null;
  /** The standing authorisation the run is approved under; `null` when it has none (approval then fails closed). */
  readonly authorisation?: Gate1AuthorisationSource | null;
  /** The envelope the last approval pinned on the run manifest; absent or `null` before the first approval. */
  readonly pinnedEnvelope?: Gate1PinnedEnvelope | null;
}

/** The `Idempotency-Key` a decision was first made with, and the request fingerprint it was made with. */
interface Gate1Idempotency {
  readonly key: string;
  readonly fingerprint: string;
}

/** A decision that already answered a key, as stored. */
export interface Gate1StoredDecision extends Gate1Idempotency {
  readonly response: Gate1DecisionResponse;
}

/** One decision to write. The store applies it only if the run is still in the state the check names. */
export interface Gate1DecisionWrite {
  readonly tenantId: string;
  readonly runId: string;
  readonly expectedState: 'awaiting_gate1';
  readonly expectedStateVersion: number;
  readonly expectedPlanVersion: number;
  readonly nextState: RunState;
  readonly nextStateVersion: number;
  readonly decision: Gate1Decision;
  readonly decidedBy: string;
  readonly reason: string | null;
  readonly idempotency: Gate1Idempotency;
  readonly response: Gate1DecisionResponse;
  /** The envelope an approval signed; written with the decision, never on its own. Absent for other decisions. */
  readonly envelope?: Gate1PinnedEnvelope;
}

/**
 * What the store did with a write. `replayed` answers a key that already decided this request. `mismatch`
 * is a key reused with a different request. The rest are refusals that changed nothing.
 */
export type Gate1WriteOutcome =
  | { readonly kind: 'decided'; readonly response: Gate1DecisionResponse }
  | { readonly kind: 'replayed'; readonly response: Gate1DecisionResponse }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_pending'; readonly state: RunState }
  | { readonly kind: 'plan_stale'; readonly planVersion: number };

/** One submit-for-Gate-1 write: `planning` to `awaiting_gate1`, recording the submitter as the requester (#398). */
export interface Gate1SubmitWrite {
  readonly tenantId: string;
  readonly runId: string;
  readonly expectedStateVersion: number;
  readonly expectedPlanVersion: number;
  readonly submittedBy: string;
  readonly nextStateVersion: number;
}

/**
 * What a submit write did. `not_planning` and `version_conflict` change nothing: the run moved or another writer
 * won the race (the loser answers 409).
 */
export type Gate1SubmitOutcome =
  | { readonly kind: 'submitted' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_planning'; readonly state: RunState }
  | { readonly kind: 'version_conflict' }
  | { readonly kind: 'plan_stale'; readonly planVersion: number };

/** Gate 1 persistence. Every method is tenant-scoped. */
export interface Gate1Store {
  getRun(tenantId: string, runId: string): Promise<Gate1RunRecord | null>;
  /**
   * Compare-and-set from `planning`: moves the run to `awaiting_gate1`, records the submitter as the requester
   * (the one person Gate 1 may not be decided by, §8.4) and bumps `state_version`.
   */
  submit(write: Gate1SubmitWrite): Promise<Gate1SubmitOutcome>;
  /** The stored decision that answered `key` in this tenant, if any. */
  findDecision(tenantId: string, key: string): Promise<Gate1StoredDecision | null>;
  /**
   * Atomically: if the key is already bound, answer from it (`replayed` or `mismatch`); else check that the
   * run is still awaiting Gate 1 at the expected state and plan versions, then record the decision and bind
   * the key. The check and the write must be one critical section (DB: row lock plus unique index).
   */
  recordDecision(write: Gate1DecisionWrite): Promise<Gate1WriteOutcome>;
  /** The envelope pinned by the run's last approval in this tenant, if any. */
  getPinnedEnvelope(tenantId: string, runId: string): Promise<Gate1PinnedEnvelope | null>;
}

/**
 * Signs the approved run envelope (#399). The key is OpenBao Transit's signing key: only signatures leave the
 * signer. A failure is `AUTHZ_SIGNER_UNAVAILABLE` and the approval is refused, so no traffic can start unsigned.
 */
export interface Gate1EnvelopeSigner {
  envelopeSigningKey(): Promise<EnvelopeSigningKey>;
}

/**
 * The verdict of PLAN-006 validation of one plan version. Submit is refused with the violations when it is not
 * valid (`GATE1_PLAN_INVALID`); the verdict never lets an invalid plan reach the approver.
 */
export type Gate1PlanVerdict =
  { readonly valid: true } | { readonly valid: false; readonly violations: readonly string[] };

/** Validates one plan version of a run before it may be submitted for Gate 1. */
export interface Gate1PlanValidator {
  validate(tenantId: string, runId: string, planVersion: number): Promise<Gate1PlanVerdict>;
}

/**
 * The messages the run workflow receives. `decided` mirrors the planning workflow's Gate 1 decision signal, so a
 * decision is applied by the workflow exactly once (idempotent on the run state).
 */
export type Gate1WorkflowSignal =
  | {
      readonly kind: 'plan_submitted';
      readonly actorId: string;
      readonly planVersion: number;
    }
  | {
      readonly kind: 'decided';
      readonly decision: 'approved' | 'rejected';
      readonly next?: 'replan' | 'cancel';
      readonly actorId: string;
      readonly planVersion: number;
      readonly reason?: string;
    };

/**
 * Signals the run's workflow and resolves only once Temporal has accepted the signal (the acknowledgement). A
 * rejection means nothing was applied, so the caller records nothing and the client may retry.
 */
export interface Gate1Signaler {
  send(tenantId: string, runId: string, signal: Gate1WorkflowSignal): Promise<void>;
}

/** Input to the Gate 1 authorisation policy: the RBAC permission fact, the tenant and the plan's requester. */
export interface Gate1PolicyInput {
  readonly principal: {
    readonly id: string;
    readonly tenantId: string;
    readonly canApprove: boolean;
  };
  readonly resource: {
    readonly runId: string;
    readonly tenantId: string;
    readonly requesterId: string | null;
  };
}

/** The Cedar decision. Anything but `allow` is a refusal. */
export interface Gate1PolicyEngine {
  authorize(input: Gate1PolicyInput): 'allow' | 'deny';
}

/** What the append-only audit trail records for a Gate 1 decision or a refusal of one (§8.8). */
export interface Gate1AuditRecord {
  readonly action:
    | 'gate1.submitted'
    | 'gate1.approved'
    | 'gate1.changes_requested'
    | 'gate1.rejected'
    | 'gate1.decided'
    | 'run.envelope_signed';
  readonly severity: AuditSeverity;
  readonly outcome: AuditOutcome;
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer. A failure must surface: an unaudited Gate 1 decision is a defect. */
export interface Gate1AuditSink {
  append(record: Gate1AuditRecord): Promise<void>;
}
