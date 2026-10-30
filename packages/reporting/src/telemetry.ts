import { trace, type Tracer } from '@opentelemetry/api';

import { createLogger, type Logger } from '@blackwing/logger';

/**
 * Observability for report assembly (REPORT-001). One `report.assemble` span per assembly, the counter
 * `report_assemble_total{result}` and the histogram `report_assemble_ms`. Ids go on the span and the log only; metric
 * labels stay low-cardinality.
 */
const REPORTING_TRACER = '@blackwing/reporting';

export const tracer: Tracer = trace.getTracer(REPORTING_TRACER);
export const log: Logger = createLogger(REPORTING_TRACER);

/** Outcome of one assembly, as the `result` label of `report_assemble_total`. */
export type ReportAssembleResult = 'ok' | 'not_found' | 'refused' | 'error';

/** Metrics port. A caller that exports metrics supplies it; the default records nothing. */
export interface ReportMetrics {
  assembled(result: ReportAssembleResult): void;
  durationMs(ms: number): void;
}

export const noopReportMetrics: ReportMetrics = {
  assembled: () => undefined,
  durationMs: () => undefined,
};
