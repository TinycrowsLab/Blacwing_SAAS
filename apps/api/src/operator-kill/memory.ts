import type {
  OperatorKillAuditRecord,
  OperatorKillAuditSink,
  OperatorKillEventStore,
  OperatorKillPropagationRequest,
  OperatorKillSignaler,
  OperatorTenantDirectory,
  OperatorTenantRecord,
} from './ports.js';
import type { KillEventInsert, KillEventInsertResult } from '../kill/ports.js';
import type { KillEvent } from '@blackwing/contracts';

const OPEN_STATUSES: ReadonlySet<KillEvent['status']> = new Set(['initiated', 'propagating']);

const scopeKey = (event: KillEvent): string => `${event.scope}|${event.tenantId ?? ''}`;

/**
 * In-process `OperatorKillEventStore` for tests and a database-less dev API until the operator-role
 * Postgres adapter lands. `insertOrGet` contains no `await`, so on one event loop it is one critical
 * section, the guarantee the database adapter gets from a unique key index plus an advisory lock.
 */
export class InMemoryOperatorKillEventStore implements OperatorKillEventStore {
  private readonly events = new Map<string, KillEvent>();
  private readonly keys = new Map<string, { readonly id: string; readonly fingerprint: string }>();

  findByIdempotencyKey(
    key: string,
  ): Promise<{ readonly event: KillEvent; readonly fingerprint: string } | null> {
    return Promise.resolve(this.lookup(key));
  }

  insertOrGet(input: KillEventInsert): Promise<KillEventInsertResult> {
    const { event, idempotency } = input;
    if (idempotency !== null) {
      const bound = this.lookup(idempotency.key);
      if (bound !== null) return Promise.resolve({ kind: 'idempotent_replay', ...bound });
    }
    const open = [...this.events.values()].find(
      (e) => scopeKey(e) === scopeKey(event) && OPEN_STATUSES.has(e.status),
    );
    if (open !== undefined) return Promise.resolve({ kind: 'in_flight', event: open });
    this.events.set(event.id, event);
    if (idempotency !== null) {
      this.keys.set(idempotency.key, { id: event.id, fingerprint: idempotency.fingerprint });
    }
    return Promise.resolve({ kind: 'created', event });
  }

  get(killEventId: string): Promise<KillEvent | null> {
    return Promise.resolve(this.events.get(killEventId) ?? null);
  }

  list(limit: number): Promise<readonly KillEvent[]> {
    return Promise.resolve(
      [...this.events.values()]
        .filter((e) => e.source === 'operator')
        .sort((a, b) =>
          a.triggeredAt < b.triggeredAt ? 1 : a.triggeredAt > b.triggeredAt ? -1 : 0,
        )
        .slice(0, limit),
    );
  }

  /** Test helper: replaces a stored event, as the kill path does when a phase completes. */
  put(event: KillEvent): void {
    this.events.set(event.id, event);
  }

  private lookup(key: string): { readonly event: KillEvent; readonly fingerprint: string } | null {
    const bound = this.keys.get(key);
    const event = bound === undefined ? undefined : this.events.get(bound.id);
    return bound === undefined || event === undefined
      ? null
      : { event, fingerprint: bound.fingerprint };
  }
}

/** Collects audit records in memory (tests; AUDIT-002 provides the ledger writer). */
export class InMemoryOperatorKillAuditSink implements OperatorKillAuditSink {
  readonly records: OperatorKillAuditRecord[] = [];

  append(record: OperatorKillAuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

/** Records propagation requests instead of starting the kill path (tests and a worker-less dev API). */
export class RecordingOperatorKillSignaler implements OperatorKillSignaler {
  readonly requests: OperatorKillPropagationRequest[] = [];

  signal(request: OperatorKillPropagationRequest): Promise<void> {
    this.requests.push(request);
    return Promise.resolve();
  }
}

/** A fixed tenant directory (tests and local dev wiring). */
export function createInMemoryTenantDirectory(
  tenants: readonly OperatorTenantRecord[],
): OperatorTenantDirectory {
  return { get: (tenantId) => Promise.resolve(tenants.find((t) => t.id === tenantId) ?? null) };
}
