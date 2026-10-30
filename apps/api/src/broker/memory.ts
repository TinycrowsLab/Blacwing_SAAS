import type { PdpFacts, PdpFactsReader, PdpRef } from './pdp.js';
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

// OFFLINE-STUB(online-porting #895): the PDP's facts (envelope, scope, journal) come from an in-memory
// table until the withTenant Postgres reader that loads the signed standing authorisation lands.
/**
 * Facts per run for the PDP (RUNTIME-005). Tests seed it; a run with no seeded facts has no envelope, so every
 * decision for it denies (fail closed).
 */
export class InMemoryPdpFactsReader implements PdpFactsReader {
  private readonly runs = new Map<
    string,
    { readonly tenantId: string; readonly facts: PdpFacts }
  >();

  set(ref: PdpRef, facts: PdpFacts): void {
    this.runs.set(ref.runId, { tenantId: ref.tenantId, facts });
  }

  load(ref: PdpRef): Promise<PdpFacts> {
    const run = this.runs.get(ref.runId);
    if (run?.tenantId !== ref.tenantId) {
      return Promise.resolve({
        envelope: null,
        sessionCeiling: 'passive',
        testCaseClass: null,
        reversalJournalPresent: false,
        inScope: () => false,
      });
    }
    return Promise.resolve(run.facts);
  }
}
