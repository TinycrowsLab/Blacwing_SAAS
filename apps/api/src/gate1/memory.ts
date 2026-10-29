import type {
  Gate1AuditRecord,
  Gate1AuditSink,
  Gate1DecisionWrite,
  Gate1RunRecord,
  Gate1Store,
  Gate1StoredDecision,
  Gate1WriteOutcome,
} from './ports.js';

/**
 * In-process `Gate1Store` for unit/integration tests and local development until the Postgres adapter lands
 * with the tenant data-access layer (`withTenant`). `recordDecision` contains no `await`, so on one event loop
 * it is a single critical section, the same guarantee the database adapter gets from a row lock plus a unique
 * `(tenant_id, idempotency_key)` index. Every read is filtered by tenant, like RLS.
 */
// OFFLINE-STUB(online-porting #877): the Postgres-backed Gate 1 store replaces this once the tenant data layer lands.
export class InMemoryGate1Store implements Gate1Store {
  private readonly runs = new Map<string, Gate1RunRecord>();
  private readonly decisions = new Map<string, Gate1StoredDecision>();

  constructor(runs: readonly Gate1RunRecord[] = []) {
    for (const run of runs) this.runs.set(runKey(run.tenantId, run.id), run);
  }

  /** Test and local seeding: replaces the run row for its tenant and public id. */
  put(run: Gate1RunRecord): void {
    this.runs.set(runKey(run.tenantId, run.id), run);
  }

  getRun(tenantId: string, runId: string): Promise<Gate1RunRecord | null> {
    return Promise.resolve(this.runs.get(runKey(tenantId, runId)) ?? null);
  }

  findDecision(tenantId: string, key: string): Promise<Gate1StoredDecision | null> {
    return Promise.resolve(this.decisions.get(decisionKey(tenantId, key)) ?? null);
  }

  recordDecision(write: Gate1DecisionWrite): Promise<Gate1WriteOutcome> {
    const bound = this.decisions.get(decisionKey(write.tenantId, write.idempotency.key));
    if (bound !== undefined) {
      return Promise.resolve(
        bound.fingerprint === write.idempotency.fingerprint
          ? { kind: 'replayed', response: bound.response }
          : { kind: 'mismatch' },
      );
    }
    const run = this.runs.get(runKey(write.tenantId, write.runId));
    if (run === undefined) return Promise.resolve({ kind: 'not_found' });
    if (run.state !== write.expectedState || run.stateVersion !== write.expectedStateVersion) {
      return Promise.resolve({ kind: 'not_pending', state: run.state });
    }
    if (run.plan.planVersion !== write.expectedPlanVersion) {
      return Promise.resolve({ kind: 'plan_stale', planVersion: run.plan.planVersion });
    }
    this.runs.set(runKey(write.tenantId, write.runId), {
      ...run,
      state: write.nextState,
      stateVersion: write.nextStateVersion,
    });
    this.decisions.set(decisionKey(write.tenantId, write.idempotency.key), {
      key: write.idempotency.key,
      fingerprint: write.idempotency.fingerprint,
      response: write.response,
    });
    return Promise.resolve({ kind: 'decided', response: write.response });
  }
}

/** Append-only in-memory audit sink; keeps every record in order. */
export class InMemoryGate1AuditSink implements Gate1AuditSink {
  readonly records: Gate1AuditRecord[] = [];

  append(record: Gate1AuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

const runKey = (tenantId: string, runId: string): string => `${tenantId}|${runId}`;
const decisionKey = (tenantId: string, key: string): string => `${tenantId}|${key}`;
