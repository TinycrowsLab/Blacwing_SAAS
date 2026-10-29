import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

import { createLogger, type Logger } from '@blackwing/logger';

/**
 * Observability for the replay engine (#719). The engine emits one `validation.replay` span per run, structured
 * logs for blocks, aborts and failures, and one `replay_runs_total` / `replay_duration_ms` observation per run.
 * Metric labels stay bounded: the oracle type and the result are the only labels. Candidate and sandbox ids go on
 * the span and the logs, never on metric labels.
 */

export const REPLAY_TRACER = '@blackwing/replay';

export const tracer: Tracer = trace.getTracer(REPLAY_TRACER);
export const log: Logger = createLogger(REPLAY_TRACER);

/** Metrics port. A caller that exports metrics supplies it; the default records nothing. */
export interface ReplayMetrics {
  runFinished(
    labels: { readonly oracleType: string; readonly result: string },
    durationMs: number,
  ): void;
}

export const noopReplayMetrics: ReplayMetrics = {
  runFinished: () => undefined,
};

/** A fixed span attribute value for an error, without its message (which may echo untrusted input). */
export function markSpanError(span: Span, errorName: string): void {
  span.setAttribute('replay.error', errorName);
  span.setStatus({ code: SpanStatusCode.ERROR });
}
