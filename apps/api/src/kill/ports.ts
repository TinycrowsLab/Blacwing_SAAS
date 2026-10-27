import type {
  AuditActor,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
  KillApiScope,
  KillEvent,
  KillTargetSet,
} from '@blackwing/contracts';
import type { KillTargetReader } from '@blackwing/domain';

/**
 * The ports the kill service composes (KILL-003). Each adapter is owned elsewhere: the Postgres store
 * and target reader by the tenant data-access layer (`withTenant`, #95), audit persistence and the
 * hash chain by AUDIT-002, the propagation workflow by KILL-004 (#174). The service never reaches past
 * these interfaces, so swapping an adapter cannot change a safety decision.
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface KillPrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id); the `actorRef` recorded on the kill event. */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  /** The API token used, when the caller is not on a console session. Recorded in audit only. */
  readonly tokenId?: string;
}

/** The asset ownership the Cedar check needs. `null` when the asset is unknown in the tenant. */
export interface KillAssetRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserIds: readonly string[];
}

/** A run the caller names, as the Cedar check needs it. `null` when unknown in the tenant. */
export interface KillRunRecord {
  readonly id: string;
  readonly tenantId: string;
}

/** Reads the resources a kill names. Tenant-scoped: never returns another tenant's row. */
export interface KillResourceReader {
  getRun(tenantId: string, runId: string): Promise<KillRunRecord | null>;
  getAsset(tenantId: string, assetId: string): Promise<KillAssetRecord | null>;
}

/** Opens a tenant-scoped (RLS) read transaction for the KILL-002 resolver. */
export interface KillTargetReaderFactory {
  withTenantReader<T>(tenantId: string, fn: (reader: KillTargetReader) => Promise<T>): Promise<T>;
}

/** What the store needs to dedupe one insert atomically. */
export interface KillEventInsert {
  readonly event: KillEvent;
  /** `Idempotency-Key` header and the request fingerprint it was first used with. */
  readonly idempotency: { readonly key: string; readonly fingerprint: string } | null;
}

/** Outcome of an insert: either our row, or the row that already answered this request. */
export type KillEventInsertResult =
  | { readonly kind: 'created'; readonly event: KillEvent }
  | { readonly kind: 'idempotent_replay'; readonly event: KillEvent; readonly fingerprint: string }
  | { readonly kind: 'in_flight'; readonly event: KillEvent };

/** Kill-event persistence. Every method is tenant-scoped. */
export interface KillEventStore {
  /** The event a previous request with this key created, and that request's fingerprint. */
  findByIdempotencyKey(
    tenantId: string,
    key: string,
  ): Promise<{ readonly event: KillEvent; readonly fingerprint: string } | null>;
  /**
   * Atomically: if the key is already bound, return that event (`idempotent_replay`); else if an open
   * (`initiated`/`propagating`) event exists for the same scope and ref, return it (`in_flight`); else
   * insert. The check and the insert must be one critical section (DB: unique index + lock).
   */
  insertOrGet(input: KillEventInsert): Promise<KillEventInsertResult>;
  get(tenantId: string, killEventId: string): Promise<KillEvent | null>;
}

/** The message KILL-004's `KillPropagationWorkflow` receives. */
export interface KillPropagationRequest {
  readonly killEventId: string;
  readonly tenantId: string;
  readonly scope: KillApiScope;
  readonly scopeRefId: string | null;
  readonly targets: KillTargetSet;
  readonly triggeredAt: string;
}

/** Enqueues propagation. Must not wait for propagation to finish. */
export interface KillPropagationSignaler {
  signal(request: KillPropagationRequest): Promise<void>;
}

/** Audit actions of the SOC kill link (KILL-007). */
export type SocKillAuditAction =
  'soc_kill.link_minted' | 'soc_kill.triggered' | 'soc_kill.rejected';

/** An audit event before the ledger assigns its sequence number and hash (AUDIT-002). */
export interface KillAuditRecord {
  readonly action: 'kill.triggered' | 'kill.forbidden' | SocKillAuditAction;
  readonly severity: AuditSeverity;
  readonly outcome: AuditOutcome;
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface: an unaudited kill is a defect. */
export interface KillAuditSink {
  append(record: KillAuditRecord): Promise<void>;
}
