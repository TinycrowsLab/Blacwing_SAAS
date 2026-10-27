import type {
  AuditEventFilters,
  AuditEventRecord,
  AuditEventsPlan,
  AuditQueryStore,
} from './ports.js';
import type { AuditEventInput } from '@blackwing/audit';

/**
 * In-memory audit query store for unit tests. It mirrors the Postgres adapter's semantics: rows are
 * per tenant, filters are AND-ed, the page is `ORDER BY occurredAt DESC, seq DESC`, the cursor
 * predicate is strict, and a query records `audit.queried` into `recorded`.
 */
export interface MemoryAuditQueryStore extends AuditQueryStore {
  /** Adds a row to a tenant's ledger, as the chain appender would. */
  insert(tenantId: string, row: AuditEventRecord): void;
  /** Every `audit.queried` record written, in order. */
  readonly recorded: AuditEventInput[];
  /** Every tenant id a transaction was opened for, in order. */
  readonly transactions: string[];
}

function matches(row: AuditEventRecord, filters: AuditEventFilters): boolean {
  const actorId = 'id' in row.actor ? row.actor.id : undefined;
  if (filters.actorId !== undefined && actorId !== filters.actorId) return false;
  if (filters.action !== undefined && row.action !== filters.action) return false;
  if (filters.targetId !== undefined && row.target.id !== filters.targetId) return false;
  if (filters.runId !== undefined && row.runId !== filters.runId) return false;
  if (filters.outcome !== undefined && row.outcome !== filters.outcome) return false;
  if (filters.from !== undefined && row.occurredAt.getTime() < Date.parse(filters.from))
    return false;
  if (filters.to !== undefined && row.occurredAt.getTime() > Date.parse(filters.to)) return false;
  return true;
}

function sortNewestFirst(rows: readonly AuditEventRecord[]): AuditEventRecord[] {
  return [...rows].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.seq - a.seq);
}

function list(rows: readonly AuditEventRecord[], plan: AuditEventsPlan): AuditEventRecord[] {
  const after = plan.before;
  return sortNewestFirst(rows)
    .filter((row) => matches(row, plan.filters))
    .filter(
      (row) =>
        after === undefined ||
        row.occurredAt.getTime() < after.occurredAt.getTime() ||
        (row.occurredAt.getTime() === after.occurredAt.getTime() && row.seq < after.seq),
    )
    .slice(0, plan.fetchLimit);
}

export function createMemoryAuditQueryStore(): MemoryAuditQueryStore {
  const ledgers = new Map<string, AuditEventRecord[]>();
  const recorded: AuditEventInput[] = [];
  const transactions: string[] = [];
  return {
    recorded,
    transactions,
    insert(tenantId, row) {
      const rows = ledgers.get(tenantId) ?? [];
      rows.push(row);
      ledgers.set(tenantId, rows);
    },
    withTenant(tenantId, fn) {
      transactions.push(tenantId);
      const rows = ledgers.get(tenantId) ?? [];
      const staged: AuditEventInput[] = [];
      return fn({
        events: { list: (plan) => Promise.resolve(list(rows, plan)) },
        audit: {
          queried(input) {
            staged.push(input);
            return Promise.resolve();
          },
        },
      }).then((value) => {
        recorded.push(...staged);
        return value;
      });
    },
  };
}
