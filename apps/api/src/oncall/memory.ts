import type {
  OncallAuditRecord,
  OncallAuditSink,
  OncallConflictReason,
  OncallExceptionContext,
  OncallExceptionReader,
  OncallInsertResult,
  OncallStore,
  OncallUpdateResult,
} from './ports.js';
import type { OncallRoster } from '@blackwing/contracts';

const clone = (roster: OncallRoster): OncallRoster => structuredClone(roster);

/**
 * In-process `OncallStore` for unit/integration tests and the API's local dev wiring until the
 * Postgres adapter lands with the tenant data-access layer (`withTenant`, RLS). Every method is
 * synchronous inside, so on one event loop each is a single critical section: the same guarantee the
 * DB adapter gets from the one-active-roster unique index and `WHERE state_version = ?`. Every read is
 * filtered by tenant, like RLS, and returns a copy, so a caller cannot edit stored state.
 */
export class InMemoryOncallStore implements OncallStore {
  private readonly rosters = new Map<string, OncallRoster>();

  list(tenantId: string): Promise<readonly OncallRoster[]> {
    const rows = [...this.rosters.values()]
      .filter((roster) => roster.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return Promise.resolve(rows.map(clone));
  }

  get(tenantId: string, rosterId: string): Promise<OncallRoster | null> {
    const roster = this.rosters.get(rosterId);
    return Promise.resolve(roster?.tenantId === tenantId ? clone(roster) : null);
  }

  getActive(tenantId: string): Promise<OncallRoster | null> {
    const roster = [...this.rosters.values()].find((r) => r.tenantId === tenantId && r.active);
    return Promise.resolve(roster === undefined ? null : clone(roster));
  }

  insert(roster: OncallRoster): Promise<OncallInsertResult> {
    const conflict = this.conflictOf(roster);
    if (conflict !== null) return Promise.resolve({ kind: 'conflict', reason: conflict });
    this.rosters.set(roster.id, clone(roster));
    return Promise.resolve({ kind: 'created', roster: clone(roster) });
  }

  update(roster: OncallRoster, expectedVersion: number): Promise<OncallUpdateResult> {
    const current = this.rosters.get(roster.id);
    if (current?.tenantId !== roster.tenantId || current.stateVersion !== expectedVersion) {
      return Promise.resolve({ kind: 'stale' });
    }
    const conflict = this.conflictOf(roster);
    if (conflict !== null) return Promise.resolve({ kind: 'conflict', reason: conflict });
    const next: OncallRoster = { ...clone(roster), stateVersion: expectedVersion + 1 };
    this.rosters.set(roster.id, next);
    return Promise.resolve({ kind: 'updated', roster: clone(next) });
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

/** Collects audit records in memory; `failNext` makes the next append reject (to test the failure path). */
export class InMemoryOncallAuditSink implements OncallAuditSink {
  readonly records: OncallAuditRecord[] = [];
  private failing = false;

  failNext(): void {
    this.failing = true;
  }

  append(record: OncallAuditRecord): Promise<void> {
    if (this.failing) {
      this.failing = false;
      return Promise.reject(new Error('audit ledger unavailable'));
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
    const { tenantId: _tenantId, ...context } = row;
    return Promise.resolve(context);
  }
}
