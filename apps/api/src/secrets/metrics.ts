import { Counter, Registry } from 'prom-client';

export type SecretWriteOp = 'create' | 'update' | 'delete';
export type SecretWriteResult =
  'success' | 'denied' | 'not_found' | 'invalid' | 'conflict' | 'stale' | 'unavailable' | 'error';

/** Secret write metrics (SECRETS-004 observability). One private registry per instance. */
export interface SecretMetrics {
  readonly registry: Registry;
  /** `secret_write_total{op,result}`. Labels are fixed enums: no secret id, name or value ever. */
  readonly writes: Counter<'op' | 'result'>;
  /** Audit appends that failed after a denial; pages. (State changes audit in their transaction.) */
  readonly auditFailures: Counter<'action'>;
}

export function createSecretMetrics(registry: Registry = new Registry()): SecretMetrics {
  return {
    registry,
    writes: new Counter({
      name: 'secret_write_total',
      help: 'Secret write API calls by operation and result.',
      labelNames: ['op', 'result'],
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'secret_audit_failures_total',
      help: 'Secret audit events that could not be appended to the ledger.',
      labelNames: ['action'],
      registers: [registry],
    }),
  };
}
