import type { AuditActor, AuditTarget, RetentionDataClass } from '@blackwing/contracts';
import type { RetentionPolicyRow } from '@blackwing/domain';

/**
 * The ports the retention policy service composes (RETAIN-001). The Postgres adapter (`postgres.ts`)
 * runs them inside `withTenant`, so RLS confines every statement. The audit writer is injected: the
 * ledger's owner (AUDIT-002) appends the event on the same transaction, so a policy change that cannot
 * be audited does not happen (§8.8).
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface RetentionPrincipal {
  readonly type: 'user' | 'service';
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  /** The API token used, when the caller is not on a console session. Recorded in audit only. */
  readonly tokenId?: string;
}

/** A stored policy row with its last write time. Rows exist only for classes a tenant has written. */
export interface StoredRetentionPolicy extends RetentionPolicyRow {
  /** ISO-8601 UTC of the last write (`updated_at`). */
  readonly updatedAt: string;
}

/** A row the service writes: the effective values of one class after a successful `PUT`. */
export interface RetentionPolicyWrite {
  readonly tenantId: string;
  readonly dataClass: RetentionDataClass;
  readonly retentionDays: number;
  readonly minRetentionDays: number;
  readonly enabled: boolean;
}

/** One audit event for one changed class, before the ledger assigns its sequence and hash (AUDIT-002). */
export interface RetentionAuditRecord {
  readonly action: 'config.changed';
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly outcome: 'success';
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** What a `PUT` may do inside its transaction. */
export interface RetentionTx {
  /**
   * Serialises concurrent writers of one tenant (the tenant row is locked) and returns the tenant's
   * stored rows. Every other method is valid only after this call.
   */
  lockAndLoad(): Promise<readonly StoredRetentionPolicy[]>;
  upsert(writes: readonly RetentionPolicyWrite[]): Promise<void>;
  appendAudit(record: RetentionAuditRecord): Promise<void>;
}

/** Tenant-scoped policy persistence. Every method is confined to one tenant. */
export interface RetentionStore {
  /** The tenant's stored rows (possibly none: the platform defaults apply). */
  read(tenantId: string): Promise<readonly StoredRetentionPolicy[]>;
  /** Runs `fn` in one transaction; a throw rolls back every write and every audit event. */
  transact<T>(tenantId: string, fn: (tx: RetentionTx) => Promise<T>): Promise<T>;
}
