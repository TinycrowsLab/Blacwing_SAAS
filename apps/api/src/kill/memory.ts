import type {
  KillAssetRecord,
  KillAuditRecord,
  KillAuditSink,
  KillEventInsert,
  KillEventInsertResult,
  KillEventStore,
  KillPropagationRequest,
  KillPropagationSignaler,
  KillResourceReader,
  KillRunRecord,
} from './ports.js';
import type { KillEvent } from '@blackwing/contracts';

const OPEN_STATUSES: ReadonlySet<KillEvent['status']> = new Set(['initiated', 'propagating']);

const scopeKey = (event: KillEvent): string =>
  `${event.tenantId ?? ''}|${event.scope}|${event.scopeRefId ?? ''}`;

/**
 * In-process `KillEventStore` for unit/integration tests and the API's local dev wiring until the
 * Postgres adapter lands with the tenant data-access layer (#95). `insertOrGet` contains no `await`,
 * so on one event loop it is a single critical section, the same guarantee the DB adapter gets from a
 * unique `(tenant_id, idempotency_key)` index plus a per-scope advisory lock. Every read is filtered
 * by tenant, like RLS.
 */
export class InMemoryKillEventStore implements KillEventStore {
  private readonly events = new Map<string, KillEvent>();
  private readonly keys = new Map<string, { readonly id: string; readonly fingerprint: string }>();

  findByIdempotencyKey(
    tenantId: string,
    key: string,
  ): Promise<{ readonly event: KillEvent; readonly fingerprint: string } | null> {
    return Promise.resolve(this.lookupKey(tenantId, key));
  }

  insertOrGet(input: KillEventInsert): Promise<KillEventInsertResult> {
    const { event, idempotency } = input;
    const tenantId = event.tenantId ?? '';
    if (idempotency !== null) {
      const bound = this.lookupKey(tenantId, idempotency.key);
      if (bound !== null) return Promise.resolve({ kind: 'idempotent_replay', ...bound });
    }
    const open = [...this.events.values()].find(
      (e) => scopeKey(e) === scopeKey(event) && OPEN_STATUSES.has(e.status),
    );
    if (open !== undefined) {
      if (idempotency !== null) this.bind(tenantId, idempotency, open.id);
      return Promise.resolve({ kind: 'in_flight', event: open });
    }
    this.events.set(event.id, event);
    if (idempotency !== null) this.bind(tenantId, idempotency, event.id);
    return Promise.resolve({ kind: 'created', event });
  }

  get(tenantId: string, killEventId: string): Promise<KillEvent | null> {
    const event = this.events.get(killEventId);
    return Promise.resolve(event?.tenantId === tenantId ? event : null);
  }

  recent(tenantId: string, limit: number): Promise<readonly KillEvent[]> {
    const rows = [...this.events.values()]
      .filter((e) => e.tenantId === tenantId)
      .reverse()
      .sort((a, b) => Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt))
      .slice(0, limit);
    return Promise.resolve(rows);
  }

  /** Test helper: every stored event of one tenant. */
  list(tenantId: string): readonly KillEvent[] {
    return [...this.events.values()].filter((e) => e.tenantId === tenantId);
  }

  private bind(
    tenantId: string,
    idempotency: { readonly key: string; readonly fingerprint: string },
    id: string,
  ): void {
    this.keys.set(`${tenantId}|${idempotency.key}`, { id, fingerprint: idempotency.fingerprint });
  }

  private lookupKey(
    tenantId: string,
    key: string,
  ): { readonly event: KillEvent; readonly fingerprint: string } | null {
    const bound = this.keys.get(`${tenantId}|${key}`);
    if (bound === undefined) return null;
    const event = this.events.get(bound.id);
    if (event?.tenantId !== tenantId) return null;
    return { event, fingerprint: bound.fingerprint };
  }
}

/** Collects audit records in memory (tests; AUDIT-002 provides the ledger writer). */
export class InMemoryKillAuditSink implements KillAuditSink {
  readonly records: KillAuditRecord[] = [];

  append(record: KillAuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

/** Records propagation requests instead of signalling Temporal (tests and a worker-less dev API). */
export class RecordingKillSignaler implements KillPropagationSignaler {
  readonly requests: KillPropagationRequest[] = [];

  signal(request: KillPropagationRequest): Promise<void> {
    this.requests.push(request);
    return Promise.resolve();
  }
}

/** A tenant-filtered `KillResourceReader` over fixed rows (tests and local dev wiring). */
export function createInMemoryKillResources(world: {
  readonly runs: readonly KillRunRecord[];
  readonly assets: readonly KillAssetRecord[];
}): KillResourceReader {
  return {
    getRun: (tenantId, runId) =>
      Promise.resolve(world.runs.find((r) => r.id === runId && r.tenantId === tenantId) ?? null),
    getAsset: (tenantId, assetId) =>
      Promise.resolve(
        world.assets.find((a) => a.id === assetId && a.tenantId === tenantId) ?? null,
      ),
  };
}
