import type { KillEventState, KillStageColumn, KillStageName } from './types.js';
import type {
  KillAffected,
  KillEgressIdentity,
  KillEgressOutcome,
  KillEventStatus,
} from '@blackwing/contracts';


/**
 * Ports the kill activities depend on. The Postgres repository (tenant data access, #95) and the audit
 * ledger writer (AUDIT-002) are owned elsewhere; the egress client below is the real HTTP adapter.
 */

/** Persistence for `kill_events`. Every method is tenant-scoped (RLS) and every write is idempotent. */
export interface KillEventRepo {
  get(tenantId: string, killEventId: string): Promise<KillEventState | null>;
  /** Compare-and-set: writes `at` only while the column is null. Returns false when already set. */
  markStage(
    tenantId: string,
    killEventId: string,
    column: KillStageColumn,
    at: Date,
  ): Promise<boolean>;
  /** Sets `status` only while the current status is one of `from`. Returns false when it was not. */
  transition(
    tenantId: string,
    killEventId: string,
    to: KillEventStatus,
    from: readonly KillEventStatus[],
  ): Promise<boolean>;
  /** Shallow-merges into `affected`. */
  mergeAffected(tenantId: string, killEventId: string, patch: Partial<KillAffected>): Promise<void>;
  /** Compare-and-set completion: only while `completed_at` is null. Returns false when already complete. */
  complete(
    tenantId: string,
    killEventId: string,
    input: { status: KillEventStatus; completedAt: Date; haltMs: number },
  ): Promise<boolean>;
}

/** One identity's answer from the gateway. `already_blocked` is the idempotent no-op ack. */
export interface EgressAck {
  readonly identity: KillEgressIdentity;
  readonly outcome: KillEgressOutcome;
}

/**
 * The egress gateway control API, `POST /control/kill` (EGRESS owns the blocking internals). A resolved
 * call means the gateway is now failing closed for every identity with a non-`failed` outcome. A thrown
 * error means the gateway could not be reached or answered no.
 */
export interface EgressControlClient {
  block(
    request: { readonly killEventId: string; readonly identities: readonly KillEgressIdentity[] },
    signal: AbortSignal,
  ): Promise<readonly EgressAck[]>;
}

/** An audit record before the ledger assigns its sequence number and hash (AUDIT-002). */
export interface KillStageAuditRecord {
  readonly action: 'kill.egress_blocked';
  readonly severity: 'critical';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly killEventId: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface so Temporal retries it. */
export interface KillStageAuditSink {
  append(record: KillStageAuditRecord): Promise<void>;
}

/** Metrics sink; the default implementation is OpenTelemetry. */
export interface KillStageMetrics {
  stageLatency(stage: KillStageName, ms: number): void;
  stageResult(stage: KillStageName, result: string): void;
  /** Alert counter: a stage finished `partially_halted`. */
  partialHalt(stage: KillStageName): void;
}
