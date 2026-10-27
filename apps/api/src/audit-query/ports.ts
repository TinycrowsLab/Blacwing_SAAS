import type { AuditEventInput } from '@blackwing/audit';
import type {
  AuditAction,
  AuditActor,
  AuditMetadata,
  AuditMetadataRef,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
} from '@blackwing/contracts';

/**
 * The ports of the audit query API (#86). The Postgres adapter (`postgres.ts`) runs every call inside
 * `withTenant`, so RLS is in force; the service never reaches past these interfaces.
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface AuditQueryPrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id). */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  readonly tokenId?: string;
}

/** The filters a query may carry. Every field is optional; an absent field does not filter. */
export interface AuditEventFilters {
  readonly actorId?: string;
  readonly action?: AuditAction;
  readonly targetId?: string;
  readonly runId?: string;
  readonly outcome?: AuditOutcome;
  /** Inclusive lower bound on `occurredAt`, ISO-8601 UTC. */
  readonly from?: string;
  /** Inclusive upper bound on `occurredAt`, ISO-8601 UTC. */
  readonly to?: string;
}

/** Position of the last row of a page: rows strictly older than it (in `(occurredAt, seq)` order) follow. */
export interface AuditEventPosition {
  readonly occurredAt: Date;
  readonly seq: number;
}

/** One ledger row as the store returns it (the `audit_events` columns; bytes are `Uint8Array`). */
export interface AuditEventRecord {
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly action: string;
  readonly severity: AuditSeverity;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly outcome: AuditOutcome;
  readonly reason: string | null;
  readonly metadata: AuditMetadata;
  readonly metadataRef: AuditMetadataRef | null;
  readonly traceId: string | null;
  readonly runId: string | null;
  readonly hash: Uint8Array;
  readonly prevHash: Uint8Array | null;
}

/** What the store is asked for: the filters, the cursor position and the rows to fetch (`limit + 1`). */
export interface AuditEventsPlan {
  readonly filters: AuditEventFilters;
  readonly before?: AuditEventPosition;
  readonly fetchLimit: number;
}

/** Reads the tenant's ledger rows, newest first: `ORDER BY occurred_at DESC, seq DESC`. */
export interface AuditEventReader {
  list(plan: AuditEventsPlan): Promise<readonly AuditEventRecord[]>;
}

/** Appends the `audit.queried` event that records a query, inside the same transaction as the read. */
export interface AuditQueryRecorder {
  queried(input: AuditEventInput): Promise<void>;
}

/** The tenant-scoped transaction a query runs in. */
export interface AuditQueryTx {
  readonly events: AuditEventReader;
  readonly audit: AuditQueryRecorder;
}

/** Opens a tenant-scoped (RLS) transaction for one query. */
export interface AuditQueryStore {
  withTenant<T>(tenantId: string, fn: (tx: AuditQueryTx) => Promise<T>): Promise<T>;
}
