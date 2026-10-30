import type { AuditEventInput } from '@blackwing/audit';
import type { OncallRoster } from '@blackwing/contracts';

/**
 * The ports the on-call service composes (GATE2-003). Each adapter is owned elsewhere: the Postgres
 * store and memberships by the tenant data-access layer (`withTenant`, RLS; tables in `@blackwing/db`),
 * the audit ledger by AUDIT-002 (`emitAuditInTx`), and the exception lookup by GATE2-001. The service
 * never reaches past these interfaces, so swapping an adapter cannot change a safety decision.
 */

/** The authenticated caller. Authentication happens before the handler. */
export interface OncallPrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id). */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  /** The API token used, when the caller is not on a console session. Recorded in audit only. */
  readonly tokenId?: string;
}

/** Why the store refused a write. */
export type OncallConflictReason = 'active_roster_exists' | 'name_taken';

/** Outcome of an insert. */
export type OncallInsertResult =
  | { readonly kind: 'created'; readonly roster: OncallRoster }
  | { readonly kind: 'conflict'; readonly reason: OncallConflictReason };

/** Outcome of a compare-and-set update. */
export type OncallUpdateResult =
  | { readonly kind: 'updated'; readonly roster: OncallRoster }
  /** The row is gone or its `stateVersion` is no longer the expected one (concurrent edit). */
  | { readonly kind: 'stale' }
  | { readonly kind: 'conflict'; readonly reason: OncallConflictReason };

/**
 * Roster persistence. Every method is tenant-scoped: a roster of another tenant is never returned,
 * written or counted (RLS in the DB adapter, a filter in the in-memory one). A write and its audit
 * event commit together or not at all (§8.8): the adapter appends `audit` in the same transaction.
 */
export interface OncallStore {
  list(tenantId: string): Promise<readonly OncallRoster[]>;
  get(tenantId: string, rosterId: string): Promise<OncallRoster | null>;
  /** The tenant's one active roster, if any. */
  getActive(tenantId: string): Promise<OncallRoster | null>;
  /** Inserts the roster; a second active roster or a duplicate name is a `conflict` (nothing is written). */
  insert(roster: OncallRoster, audit: AuditEventInput): Promise<OncallInsertResult>;
  /**
   * `UPDATE ... WHERE id = ? AND state_version = expectedVersion`, replacing the member and schedule
   * lists in the same transaction and bumping `stateVersion`. The caller passes the roster as it should
   * be stored (with the old `stateVersion`); the store returns it with the new one.
   */
  update(
    roster: OncallRoster,
    expectedVersion: number,
    audit: AuditEventInput,
  ): Promise<OncallUpdateResult>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface OncallMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}

/** What the resolver needs to know about a Gate 2 exception (GATE2-001 owns the record). */
export interface OncallExceptionContext {
  readonly exceptionId: string;
  readonly runId: string;
  /** The user who requested the run (or the exception): never a valid approver (§8.4). */
  readonly requesterId: string;
  /** The user who approved the plan at Gate 1, when there was one: never a valid approver (§8.4). */
  readonly planApproverId: string | null;
}

/** Reads the exception an escalation step belongs to. Tenant-scoped; `null` when unknown there. */
export interface OncallExceptionReader {
  get(tenantId: string, exceptionId: string): Promise<OncallExceptionContext | null>;
}

/** Append-only audit writer for events that are not part of a roster write (§8.8). */
export interface OncallAuditSink {
  append(record: AuditEventInput): Promise<void>;
}
