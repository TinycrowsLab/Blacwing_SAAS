import { trace, type Tracer } from '@opentelemetry/api';

import { createLogger, type Logger } from '@blackwing/logger';

/**
 * Observability for evidence binding (#724). One `validation.bind_evidence` span per binding, carrying `findingId`
 * and `evidenceCount`, and the counters `evidence_bound_total` and `evidence_integrity_failures_total`. Metric labels
 * stay empty: the counts are the signal, and ids belong on the span and the logs only.
 */
export const EVIDENCE_TRACER = '@blackwing/evidence';

export const tracer: Tracer = trace.getTracer(EVIDENCE_TRACER);
export const log: Logger = createLogger(EVIDENCE_TRACER);

/** Metrics port. A caller that exports metrics supplies it; the default records nothing. */
export interface EvidenceMetrics {
  /** `evidence_bound_total`: one per chain bound to a finding occurrence. */
  bound(): void;
  /** `evidence_integrity_failures_total`: one per binding refused on an integrity check. */
  integrityFailed(): void;
}

export const noopEvidenceMetrics: EvidenceMetrics = {
  bound: () => undefined,
  integrityFailed: () => undefined,
};
