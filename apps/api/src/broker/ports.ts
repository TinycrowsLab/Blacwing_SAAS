import type { RunState } from '@blackwing/contracts';

/**
 * Ports of the Run Broker (API-014). Each adapter is owned elsewhere: the Postgres run reader by the
 * tenant data-access layer (`withTenant`, DB), audit persistence by AUDIT, the shared rate/revocation
 * state by RUNTIME/KILL. The broker never reaches past these interfaces.
 */

/** A run as the broker needs it. */
export interface BrokerRunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
}

/**
 * Reads a run inside the token's tenant context (§8.6). The production adapter opens `withTenant(tenantId)`
 * so RLS applies; it returns `null` for an unknown run AND for a run of another tenant, so the broker can
 * never tell the two apart.
 */
export interface BrokerRunReader {
  getRun(tenantId: string, runId: string): Promise<BrokerRunRecord | null>;
}

export type BrokerAuditOutcome = 'success' | 'denied' | 'rejected' | 'not_implemented' | 'error';

/** One audited broker action (§8.8). Carries ids only: never the token, never request content. */
export interface BrokerAuditEvent {
  readonly action: string;
  readonly endpoint: string;
  readonly outcome: BrokerAuditOutcome;
  readonly status: number;
  readonly code: string | null;
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly traceId: string;
}

/** AUDIT wires `emitAudit` behind this once it lands. A failure never changes the response. */
export interface BrokerAuditSink {
  record(event: BrokerAuditEvent): void | Promise<void>;
}
