import { Counter, Registry } from 'prom-client';

/** On-call metrics (GATE2-003 observability). One private registry per instance. */
export interface OncallMetrics {
  readonly registry: Registry;
  /** `oncall_resolve_total{outcome}`: `resolved`, `no_oncall_configured` or `no_eligible_approver`. */
  readonly resolve: Counter<'outcome'>;
  /** `oncall_sod_skips_total`: escalation levels skipped because every member was SoD-ineligible. */
  readonly sodSkips: Counter;
  /** `oncall_empty_roster_total`: resolves or preflights that found no roster or nobody on call. */
  readonly emptyRoster: Counter;
  /** Audit appends that failed after the change was persisted; pages. */
  readonly auditFailures: Counter<'action'>;
}

export function createOncallMetrics(registry: Registry = new Registry()): OncallMetrics {
  return {
    registry,
    resolve: new Counter({
      name: 'oncall_resolve_total',
      help: 'On-call responder resolutions, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    sodSkips: new Counter({
      name: 'oncall_sod_skips_total',
      help: 'Escalation levels skipped because every member was separation-of-duties ineligible.',
      registers: [registry],
    }),
    emptyRoster: new Counter({
      name: 'oncall_empty_roster_total',
      help: 'Resolutions or preflights that found no roster, no member or nobody on call.',
      registers: [registry],
    }),
    auditFailures: new Counter({
      name: 'oncall_audit_failures_total',
      help: 'On-call audit events that could not be appended to the ledger.',
      labelNames: ['action'],
      registers: [registry],
    }),
  };
}
