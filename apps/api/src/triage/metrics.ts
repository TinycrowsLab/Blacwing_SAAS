import { Counter, Histogram, type Registry } from 'prom-client';

/** The four triage decisions, as the route names them. */
export type TriageAction = 'release' | 'reject' | 'duplicate' | 'accept-risk';

/**
 * The outcome of one decision: `ok` committed it; `refused` was a rule of the request or the finding (reason, expiry,
 * canonical, status, precondition); `conflict` lost a concurrent write (412); `denied` failed RBAC; `not_found` was hidden.
 */
export type TriageResult = 'ok' | 'refused' | 'conflict' | 'denied' | 'not_found';

/** Triage metrics. Labels are bounded enums, never ids. */
export interface TriageMetrics {
  decision(action: TriageAction, result: TriageResult, durationMs: number): void;
}

/** `triage_decision_total{action,result}` and `triage_decision_ms{action}` on the app's registry. */
export function createTriageMetrics(registry: Registry): TriageMetrics {
  const counter = new Counter({
    name: 'triage_decision_total',
    help: 'Gate 3 triage decisions by action and result.',
    labelNames: ['action', 'result'],
    registers: [registry],
  });
  const histogram = new Histogram({
    name: 'triage_decision_ms',
    help: 'Duration of Gate 3 triage decisions in milliseconds.',
    labelNames: ['action'],
    registers: [registry],
  });
  return {
    decision: (action, result, durationMs) => {
      counter.inc({ action, result });
      histogram.observe({ action }, durationMs);
    },
  };
}
