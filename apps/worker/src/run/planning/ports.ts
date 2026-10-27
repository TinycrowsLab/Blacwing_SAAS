import type { Gate1DecisionSignal } from './types.js';
import type { RunStateFacts } from '../postexec/ports.js';
import type { PlannedTestCase, StandingAuthorisation } from '@blackwing/contracts';
import type { RunStatus } from '@blackwing/domain';

/**
 * Ports the planning phase depends on. Tenant data access (plans, runs, gate decisions, envelopes), the
 * planner agent session, RBAC and paging own the real adapters; each is a seam here so the orchestration
 * is testable and fails closed. A port that throws means "could not answer": the activity is retried.
 */

export interface PlanningRunFacts extends RunStateFacts {
  readonly saId: string;
  /** Pinned versions (§8.9) as name -> version/digest; `null` until the run manifest is written. */
  readonly runManifest: Readonly<Record<string, string>> | null;
}

export interface PlanningRunState {
  load(tenantId: string, runId: string): Promise<PlanningRunFacts | null>;
  /** Optimistic write on `state_version`; false means a lost race (the activity retries). */
  save(tenantId: string, runId: string, expectedVersion: number, next: RunStatus): Promise<boolean>;
}

/** The slice of the standing authorisation planning needs. */
export type PlanningSa = Pick<
  StandingAuthorisation,
  'id' | 'status' | 'expiresAt' | 'maxIntrusiveness' | 'preApprovedTestClasses' | 'defaultBudgets'
>;

export interface StandingAuthorisations {
  load(tenantId: string, saId: string): Promise<PlanningSa | null>;
}

export interface StoredPlan {
  readonly planId: string;
  /** Plan version, assigned by the store; later rounds get a higher one. */
  readonly version: number;
  /** True once Gate 1 approved this version: it is immutable from then on. */
  readonly frozen: boolean;
  readonly testCases: readonly PlannedTestCase[];
}

/** `test_plans` and `test_cases`, tenant-scoped (RLS). */
export interface PlanStore {
  /**
   * Persists a new plan version and its test cases (`status = 'proposed'`, every §7 field). Idempotent
   * per `(runId, round)`: a retry returns the plan already saved for that round (`created: false`).
   */
  save(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly round: number;
    readonly testCases: readonly PlannedTestCase[];
  }): Promise<{ readonly planId: string; readonly version: number; readonly created: boolean }>;
  /** The newest plan version of the run. */
  latest(tenantId: string, runId: string): Promise<StoredPlan | null>;
  /**
   * Compare-and-set on `test_plans.version`: freezes the plan and moves its test cases to `approved`
   * only while `expectedVersion` is still the newest version. Freezing the same version again is a no-op
   * (`frozen`), so a retried activity is safe.
   */
  freeze(
    tenantId: string,
    runId: string,
    planId: string,
    expectedVersion: number,
  ): Promise<'frozen' | 'conflict'>;
  /** Marks the plan rejected at Gate 1 (it is kept for the audit trail, never executed). */
  reject(tenantId: string, runId: string, planId: string): Promise<void>;
}

export interface Gate1DecisionRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly decision: 'approved' | 'rejected';
  /** `null` for an auto-approval (the SA is the authority). */
  readonly actorId: string | null;
  readonly auto: boolean;
  /** For an auto-approval: `approved under SA-<id>`. */
  readonly reason: string;
  readonly decidedAt: string;
}

/** `gate_decisions` rows for gate 1. */
export interface GateDecisions {
  /** Appends the decision. First wins: false when this plan already has a gate 1 decision. */
  record(decision: Gate1DecisionRecord): Promise<boolean>;
}

/** The approved run envelope (§8.9): the frozen plan version, the SA and the pinned versions. */
export interface RunEnvelopeRecord {
  readonly tenantId: string;
  readonly runId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly saId: string;
  readonly pins: Readonly<Record<string, string>>;
  readonly approvedBy: string | null;
  readonly auto: boolean;
  readonly frozenAt: string;
  /** `sha256(JCS(envelope without this field))`, hex. */
  readonly envelopeHash: string;
}

export interface RunEnvelopes {
  /** Writes the immutable envelope. First wins: freezing again is a no-op, never an overwrite. */
  freeze(envelope: RunEnvelopeRecord): Promise<void>;
}

/** What the activity asks the planner session for. */
export interface PlannerRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly round: number;
  readonly attempt: number;
  /** Why the previous attempt's output was rejected (paths and messages only). */
  readonly feedback?: string;
  /** Structured output: the planner answers with JSON matching `schema`. */
  readonly outputFormat: { readonly type: 'json_schema'; readonly schema: Record<string, unknown> };
}

/**
 * The planner persona (`deep`, structured output) run as an `AgentSessionWorkflow` child. Returns the
 * session's raw `structured_output`: it is untrusted and validated by the caller.
 */
export interface PlannerSessions {
  propose(request: PlannerRequest): Promise<unknown>;
  /** Stops the planner session of the run (kill/cancel). */
  abort(tenantId: string, runId: string): Promise<void>;
}

/** RBAC check for the Gate 1 permissions (`testplan:approve`, `gate:decide`) in the tenant. */
export interface Gate1Permissions {
  canApprove(tenantId: string, userId: string): Promise<boolean>;
}

export interface PlanningAuditRecord {
  readonly action: 'plan.proposed' | 'gate1.requested' | 'gate1.decided' | 'run.state_changed';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly runId: string;
  readonly actorId: string | null;
  readonly occurredAt: string;
  /** Stable per run and event, so a retried activity cannot append a duplicate. */
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface so Temporal retries the activity. */
export interface PlanningAuditSink {
  append(record: PlanningAuditRecord): Promise<void>;
}

export interface PlanningMetrics {
  /** `blackwing_plan_testcases_total{class}`. */
  testCases(testClass: string, count: number): void;
  /** `blackwing_gate1_decisions_total{decision,auto}`. */
  gate1Decision(decision: Gate1DecisionSignal['decision'], auto: boolean): void;
  /** `blackwing_gate1_wait_seconds`. */
  gate1Wait(seconds: number): void;
}
