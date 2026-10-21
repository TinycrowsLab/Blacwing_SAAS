import type { Gate3Decision, ReporterRole, ValidatorVerdict } from './types.js';
import type { RunStatus } from '@blackwing/domain';

/**
 * Ports the post-execution phases depend on. Tenant data access (findings, runs), the VALIDATE replay
 * engine, the reporter/remediation session manager, the coverage manifest, RBAC and paging own the real
 * adapters; each is a seam here so the orchestration is testable and fails closed. A port that throws
 * means "could not answer": the activity is retried.
 */

export type FindingFactStatus =
  | 'candidate'
  | 'validating'
  | 'confirmed'
  | 'suspected'
  | 'released'
  | 'rejected_false_positive'
  | 'duplicate'
  | 'accepted_risk';

export interface FindingFact {
  readonly findingId: string;
  readonly status: FindingFactStatus;
}

export interface OutcomeRecord {
  readonly findingId: string;
  readonly status: 'confirmed' | 'suspected';
  readonly evidenceBundleId?: string;
  readonly reproArtifactId?: string;
  readonly suspectedReason?: string;
}

export interface DecisionRecord {
  readonly findingId: string;
  readonly decision: Gate3Decision;
  readonly actorId: string;
  readonly at: string;
  readonly reason?: string;
  readonly expiresAt?: string;
}

/** Findings of a run, tenant-scoped (RLS). Implemented over the findings repository (#739). */
export interface PostExecutionFindingRepo {
  /** Findings still `candidate` or `validating` (submitted via `submit_candidate`). */
  listUnresolved(tenantId: string, runId: string): Promise<readonly string[]>;
  list(tenantId: string, runId: string): Promise<readonly FindingFact[]>;
  /** Compare-and-set from `candidate`/`validating`/`suspected` only; returns false when already resolved. */
  recordOutcome(tenantId: string, runId: string, outcome: OutcomeRecord): Promise<boolean>;
  /**
   * Compare-and-set from `confirmed` to the decided status, writing `released_by/released_at` for
   * `released`. Returns false when the finding is not `confirmed` (already decided or not releasable).
   */
  applyDecision(tenantId: string, runId: string, decision: DecisionRecord): Promise<boolean>;
}

export interface RunStateFacts {
  readonly status: RunStatus;
  /** User who requested the run (SoD, §8.4). */
  readonly requestedBy: string | null;
  readonly envelopeValid: boolean;
}

export interface PostExecutionRunState {
  load(tenantId: string, runId: string): Promise<RunStateFacts | null>;
  /** Optimistic write on `state_version`; false means a lost race (the activity retries). */
  save(tenantId: string, runId: string, expectedVersion: number, next: RunStatus): Promise<boolean>;
}

/** VALIDATE: deterministic replay against the pre-declared oracle with negative controls. */
export interface Validator {
  validate(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly findingId: string;
  }): Promise<ValidatorVerdict>;
  /** Tears down any validation sandbox of the run (kill/cancel). */
  abortRun(tenantId: string, runId: string): Promise<void>;
}

/** Starts a reporter or remediation session with structured output over the released findings. */
export interface WriteUpSessions {
  run(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly role: ReporterRole;
    readonly findingIds: readonly string[];
  }): Promise<void>;
}

export interface CoverageManifest {
  finalise(tenantId: string, runId: string): Promise<void>;
  isFinalised(tenantId: string, runId: string): Promise<boolean>;
}

/** RBAC check for the Gate 3 permission (`finding:release`) in the tenant. */
export interface Gate3Permissions {
  canRelease(tenantId: string, userId: string): Promise<boolean>;
}

export interface Pager {
  page(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly message: string;
  }): Promise<void>;
}

export interface PostExecutionAuditRecord {
  readonly action:
    | 'validation.started'
    | 'finding.confirmed'
    | 'finding.suspected'
    | 'gate3.decided'
    | 'finding.released'
    | 'run.state_changed'
    | 'report.generated';
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
export interface PostExecutionAuditSink {
  append(record: PostExecutionAuditRecord): Promise<void>;
}

export interface PostExecutionMetrics {
  /** `blackwing_candidates_total{result}`. */
  candidate(result: 'confirmed' | 'suspected'): void;
  /** `blackwing_gate3_decisions_total{decision}`. */
  gate3Decision(decision: Gate3Decision): void;
  /** `blackwing_findings_released_total`. */
  released(): void;
}
