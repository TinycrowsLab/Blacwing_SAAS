import type {
  OncallAuditSink,
  OncallConflictReason,
  OncallExceptionContext,
  OncallExceptionReader,
  OncallInsertResult,
  OncallMemberships,
  OncallStore,
  OncallUpdateResult,
} from './ports.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { OncallRoster } from '@blackwing/contracts';

const clone = (roster: OncallRoster): OncallRoster => structuredClone(roster);

/**
 * In-process `OncallStore` for unit tests and the local wiring without a database. Every method is
 * synchronous inside (no await before the write), so on one event loop each is a single critical
 * section: the guarantee the Postgres adapter gets from the one-active-roster unique index and the
 * `WHERE state_version = ?` guard. Every read is filtered by tenant, like RLS, and returns a copy.
 * The audit event is recorded in the same synchronous step as the write, or the write is refused.
 */
export class InMemoryOncallStore implements OncallStore {
  private readonly rosters = new Map<string, OncallRoster>();
  /** Audit events committed with the writes, in order. */
  readonly auditLog: AuditEventInput[] = [];
  private failAudit = false;

  /** Makes the next write's audit append fail; the write must then not happen (fail closed). */
  failNextAudit(): void {
    this.failAudit = true;
  }

  list(tenantId: string): Promise<readonly OncallRoster[]> {
    const rows = [...this.rosters.values()]
      .filter((roster) => roster.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return Promise.resolve(rows.map((roster) => clone(roster)));
  }

  get(tenantId: string, rosterId: string): Promise<OncallRoster | null> {
    const roster = this.rosters.get(rosterId);
    return Promise.resolve(roster?.tenantId === tenantId ? clone(roster) : null);
  }

  getActive(tenantId: string): Promise<OncallRoster | null> {
    const roster = [...this.rosters.values()].find((r) => r.tenantId === tenantId && r.active);
    return Promise.resolve(roster === undefined ? null : clone(roster));
  }

  insert(roster: OncallRoster, audit: AuditEventInput): Promise<OncallInsertResult> {
    const conflict = this.conflictOf(roster);
    if (conflict !== null) return Promise.resolve({ kind: 'conflict', reason: conflict });
    if (!this.commitAudit(audit)) return Promise.reject(auditUnavailable());
    this.rosters.set(roster.id, clone(roster));
    return Promise.resolve({ kind: 'created', roster: clone(roster) });
  }

  update(
    roster: OncallRoster,
    expectedVersion: number,
    audit: AuditEventInput,
  ): Promise<OncallUpdateResult> {
    const current = this.rosters.get(roster.id);
    if (current?.tenantId !== roster.tenantId || current.stateVersion !== expectedVersion) {
      return Promise.resolve({ kind: 'stale' });
    }
    const conflict = this.conflictOf(roster);
    if (conflict !== null) return Promise.resolve({ kind: 'conflict', reason: conflict });
    if (!this.commitAudit(audit)) return Promise.reject(auditUnavailable());
    const next: OncallRoster = { ...clone(roster), stateVersion: expectedVersion + 1 };
    this.rosters.set(roster.id, next);
    return Promise.resolve({ kind: 'updated', roster: clone(next) });
  }

  /** Records the audit event with its write; false when the ledger is (test-)unavailable. */
  private commitAudit(audit: AuditEventInput): boolean {
    if (this.failAudit) {
      this.failAudit = false;
      return false;
    }
    this.auditLog.push(audit);
    return true;
  }

  private conflictOf(roster: OncallRoster): OncallConflictReason | null {
    for (const other of this.rosters.values()) {
      if (other.tenantId !== roster.tenantId || other.id === roster.id) continue;
      if (other.name === roster.name) return 'name_taken';
      if (roster.active && other.active) return 'active_roster_exists';
    }
    return null;
  }
}

function auditUnavailable(): Error {
  return new Error('audit ledger unavailable');
}

/** Roles by tenant and user, as the Postgres memberships table answers them. */
export class InMemoryOncallMemberships implements OncallMemberships {
  constructor(
    private readonly roles: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
  ) {}

  rolesOf(tenantId: string, userId: string): Promise<readonly string[]> {
    return Promise.resolve(this.roles[tenantId]?.[userId] ?? []);
  }
}

/** Collects audit records in memory; `failNext` makes the next append reject (to test the failure path). */
export class InMemoryOncallAuditSink implements OncallAuditSink {
  readonly records: AuditEventInput[] = [];
  private failing = false;

  failNext(): void {
    this.failing = true;
  }

  append(record: AuditEventInput): Promise<void> {
    if (this.failing) {
      this.failing = false;
      return Promise.reject(auditUnavailable());
    }
    this.records.push(record);
    return Promise.resolve();
  }
}

/** A fixed set of exceptions, scoped by tenant like the real reader. */
export class InMemoryOncallExceptionReader implements OncallExceptionReader {
  private readonly rows = new Map<string, OncallExceptionContext & { readonly tenantId: string }>();

  add(tenantId: string, context: OncallExceptionContext): void {
    this.rows.set(context.exceptionId, { ...context, tenantId });
  }

  get(tenantId: string, exceptionId: string): Promise<OncallExceptionContext | null> {
    const row = this.rows.get(exceptionId);
    if (row?.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      exceptionId: row.exceptionId,
      runId: row.runId,
      requesterId: row.requesterId,
      planApproverId: row.planApproverId,
    });
  }
}
