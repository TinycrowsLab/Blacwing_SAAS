import { Counter, exponentialBuckets, Histogram, Registry } from 'prom-client';

/** Halt-time buckets: 100 ms doubling up to about 51 s, around the §8.5 targets of 2 s and 10 s. */
const HALT_BUCKET_START_MS = 100;
const HALT_BUCKET_COUNT = 10;

/** Results of a fire attempt, as labelled on `bw_operator_kill_fired_total`. */
export type OperatorKillResult =
  'accepted' | 'forbidden' | 'invalid' | 'in_progress' | 'partial' | 'error';

/** Operator kill metrics. One private registry per instance. */
export interface OperatorKillMetrics {
  readonly registry: Registry;
  readonly fired: Counter<'scope' | 'result'>;
  /** Measured halt time of operator kills, observed once per kill when its final status is first read. */
  readonly haltMs: Histogram;
  /** Kills whose measured phases exceeded a §8.5 target. */
  readonly slaBreach: Counter<'target'>;
  readonly auditFailures: Counter<'action'>;
}

export function createOperatorKillMetrics(
  registry: Registry = new Registry(),
): OperatorKillMetrics {
  return {
    registry,
    fired: new Counter({
      name: 'bw_operator_kill_fired_total',
      help: 'Operator kill attempts by scope and result.',
      labelNames: ['scope', 'result'],
      registers: [registry],
    }),
    haltMs: new Histogram({
      name: 'bw_operator_kill_halt_ms',
      help: 'Measured halt time of operator kills in milliseconds.',
      buckets: exponentialBuckets(HALT_BUCKET_START_MS, 2, HALT_BUCKET_COUNT),
      registers: [registry],
    }),
    slaBreach: new Counter({
      name: 'bw_operator_kill_sla_breach_total',
      help: 'Operator kills that exceeded the gateway (2 s) or sandbox (10 s) halt target.',
      labelNames: ['target'],
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'bw_operator_kill_audit_failures_total',
      help: 'Operator kill audit events that could not be appended to the ledger.',
      labelNames: ['action'],
      registers: [registry],
    }),
  };
}
