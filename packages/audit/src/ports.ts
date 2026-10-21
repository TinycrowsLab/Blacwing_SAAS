import type { AuditAction, AuditMetadata, AuditMetadataRef } from '@blackwing/contracts';

/**
 * The slice of a transaction the audit helper needs. A `pg` `PoolClient` (or any client that runs
 * inside the caller's open transaction on the app role, with `app.tenant_id` set) satisfies it. The
 * helper never opens a connection or a transaction of its own: atomicity with the caller's data
 * depends on using the caller's.
 */
export interface AuditSqlTx {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: Record<string, unknown>[] }>;
}

/** The `type` of the outbox rows this package produces; the relay (WORKFLOW-012) routes on it. */
export const AUDIT_OUTBOX_TYPE = 'audit.event';

/** One outbox row to write, as the audit helper describes it. */
export interface AuditOutboxMessage {
  readonly tenantId: string;
  readonly type: typeof AUDIT_OUTBOX_TYPE;
  /** Events of one aggregate must be relayed in order; the aggregate is the audited target. */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /**
   * The audit event id. It is unique per event and fixed at emit time, so the outbox adapter must
   * treat a second enqueue with the same `(tenantId, dedupeKey)` as a no-op.
   */
  readonly dedupeKey: string;
  /** An `AuditOutboxPayload` (see `outbox-payload.ts`): the event without its chain fields. */
  readonly payload: unknown;
}

/**
 * Transactional outbox (WORKFLOW-011): `enqueue` writes one `pending` row atomically. When `tx` is
 * given the row joins that transaction; otherwise the adapter commits it on its own. It must fail
 * (reject) rather than drop a message.
 */
export interface AuditOutbox {
  enqueue(message: AuditOutboxMessage, options?: { readonly tx?: AuditSqlTx }): Promise<void>;
}

/** Where an event was written. */
export type AuditEmitPath = 'sync' | 'outbox';

/** Metrics sink (`audit_emit_total{action,path}`, `audit_emit_failures_total`). */
export interface AuditMetrics {
  emitted(labels: { readonly action: AuditAction; readonly path: AuditEmitPath }): void;
  failed(labels: { readonly path: AuditEmitPath }): void;
}

/** Wraps `fn` in a trace span (`audit.emit`). */
export type AuditSpanRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Stores metadata that exceeds the inline cap (evidence store) and returns its key. The helper
 * computes the digest and size itself; it only asks where the bytes went.
 */
export type AuditMetadataSpill = (request: {
  readonly tenantId: string;
  readonly metadata: AuditMetadata;
  readonly sha256: string;
  readonly sizeBytes: number;
}) => Promise<AuditMetadataRef['evidenceKey']>;
