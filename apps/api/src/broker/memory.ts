import type {
  BrokerAuditEvent,
  BrokerAuditSink,
  BrokerRunReader,
  BrokerRunRecord,
} from './ports.js';

// OFFLINE-STUB(online-porting #895): in-memory run reader and audit sink stand in for the withTenant
// Postgres reader and the AUDIT ledger; see the porting issue referenced in the commit.

/** Tenant-scoped in-memory run reader: a run of another tenant is indistinguishable from a missing one. */
export class InMemoryBrokerRunReader implements BrokerRunReader {
  private readonly runs = new Map<string, BrokerRunRecord>();

  set(run: BrokerRunRecord): void {
    this.runs.set(run.id, run);
  }

  getRun(tenantId: string, runId: string): Promise<BrokerRunRecord | null> {
    const run = this.runs.get(runId);
    return Promise.resolve(run?.tenantId === tenantId ? run : null);
  }
}

/** Records audit events for tests and the offline dev stack. */
export class InMemoryBrokerAuditSink implements BrokerAuditSink {
  readonly events: BrokerAuditEvent[] = [];

  record(event: BrokerAuditEvent): void {
    this.events.push(event);
  }
}
