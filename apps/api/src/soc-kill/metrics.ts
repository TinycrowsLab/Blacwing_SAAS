import { Counter, Registry } from 'prom-client';

/** SOC kill link metrics (KILL-007). One private registry per instance. */
export interface SocKillMetrics {
  readonly registry: Registry;
  /** `bw_soc_kill_total{result}`: previewed, triggered, or the reason a link was refused. */
  readonly total: Counter<'result'>;
  /** `bw_soc_kill_ratelimited_total{op}`: requests answered 429. */
  readonly ratelimited: Counter<'op'>;
  /** Audit appends that failed; pages (a link minted or refused without a ledger entry). */
  readonly auditFailures: Counter<'action'>;
}

export function createSocKillMetrics(registry: Registry = new Registry()): SocKillMetrics {
  return {
    registry,
    total: new Counter({
      name: 'bw_soc_kill_total',
      help: 'SOC kill link requests by result.',
      labelNames: ['result'],
      registers: [registry],
    }),
    ratelimited: new Counter({
      name: 'bw_soc_kill_ratelimited_total',
      help: 'SOC kill link requests refused with 429.',
      labelNames: ['op'],
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'bw_soc_kill_audit_failures_total',
      help: 'SOC kill audit events that could not be appended to the ledger.',
      labelNames: ['action'],
      registers: [registry],
    }),
  };
}
