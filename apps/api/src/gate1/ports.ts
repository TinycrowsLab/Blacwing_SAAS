import type {
  AuditActor,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
  Gate1Decision,
  Gate1DecisionResponse,
  Gate1TestCase,
  RunState,
} from '@blackwing/contracts';

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

/** Gate 1 persistence. Every method is tenant-scoped. */
export interface Gate1Store {
  getRun(tenantId: string, runId: string): Promise<Gate1RunRecord | null>;
  /** The stored decision that answered `key` in this tenant, if any. */
  findDecision(tenantId: string, key: string): Promise<Gate1StoredDecision | null>;
  /**
   * Atomically: if the key is already bound, answer from it (`replayed` or `mismatch`); else check that the
   * run is still awaiting Gate 1 at the expected state and plan versions, then record the decision and bind
   * the key. The check and the write must be one critical section (DB: row lock plus unique index).
   */
  recordDecision(write: Gate1DecisionWrite): Promise<Gate1WriteOutcome>;
}

/** What the append-only audit trail records for a Gate 1 decision or a refusal of one (§8.8). */
export interface Gate1AuditRecord {
  readonly action: 'gate1.decided';
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
