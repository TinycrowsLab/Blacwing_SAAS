import type { KillEventInsert, KillEventInsertResult } from '../kill/ports.js';
import type {
  AuditActor,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
  KillTargetSet,
  OperatorKillScope,
  KillEvent,
} from '@blackwing/contracts';
import type { KillTargetReader } from '@blackwing/domain';

/**
 * The ports the operator kill service composes. Adapters are owned elsewhere: the operator-role data
 * access by the platform-operator database role, audit persistence by AUDIT-002, the global propagation
 * path by KILL. The service never reaches past these interfaces (§8.11: it triggers the deterministic
 * path and never performs a halt itself).
 */

/** The authenticated caller of `/operator/v1`. Authentication happens before any handler runs. */
export interface OperatorPrincipal {
  readonly id: string;
  /** Must be `platform_operator`; a tenant role never qualifies. */
  readonly role: string;
  /** Platform-scope permissions held (`platform:global_kill` is required). */
  readonly permissions: readonly string[];
  readonly email?: string;
  readonly tokenId?: string;
}

/** A tenant as the operator console needs it. */
export interface OperatorTenantRecord {
  readonly id: string;
  readonly slug: string;
}

/** Looks a tenant up on the platform-operator role. `null` when it does not exist. */
export interface OperatorTenantDirectory {
  get(tenantId: string): Promise<OperatorTenantRecord | null>;
}

/** Opens a read transaction on the platform-operator role for the KILL-002 resolver. */
export interface OperatorKillTargetReaderFactory {
  withOperatorReader<T>(
    operatorId: string,
    fn: (reader: KillTargetReader) => Promise<T>,
  ): Promise<T>;
}

/**
 * Kill-event persistence on the operator role (`tenant_id` is null for a global kill). `insertOrGet`
 * has the contract of `KillEventStore.insertOrGet`: key replay, else the open event of the same scope
 * (`in_flight`), else insert, as one critical section. Idempotency keys are one namespace, so two
 * operators submitting one key dedupe to one event.
 */
export interface OperatorKillEventStore {
  findByIdempotencyKey(
    key: string,
  ): Promise<{ readonly event: KillEvent; readonly fingerprint: string } | null>;
  insertOrGet(input: KillEventInsert): Promise<KillEventInsertResult>;
  get(killEventId: string): Promise<KillEvent | null>;
  /** Operator-fired kills (`source = 'operator'`), newest first, at most `limit`. */
  list(limit: number): Promise<readonly KillEvent[]>;
}

/** The message the global/tenant propagation path receives. `tenantId` is null for `global`. */
export interface OperatorKillPropagationRequest {
  readonly killEventId: string;
  readonly tenantId: string | null;
  readonly scope: OperatorKillScope;
  readonly targets: KillTargetSet;
  readonly triggeredAt: string;
}

/** Enqueues propagation. Must not wait for propagation to finish. */
export interface OperatorKillSignaler {
  signal(request: OperatorKillPropagationRequest): Promise<void>;
}

/**
 * An audit event before the ledger assigns sequence and hash. `tenantId` null is the operator stream;
 * a tenant id appends to that tenant's stream (§8.8).
 */
export interface OperatorKillAuditRecord {
  readonly action: 'operator.kill_previewed' | 'operator.kill_fired';
  readonly severity: AuditSeverity;
  readonly outcome: AuditOutcome;
  readonly tenantId: string | null;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly reason?: string;
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). */
export interface OperatorKillAuditSink {
  append(record: OperatorKillAuditRecord): Promise<void>;
}
