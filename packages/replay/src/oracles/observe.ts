import { log, markSpanError, tracer } from '../telemetry.js';

import type { OracleEvaluator } from '../dispatch.js';

/**
 * Observability for the signal evaluators (VALIDATE-003). Each evaluation runs in a `validation.oracle.b` span tagged
 * with its oracle type, records one `oracle_eval_total{type,fired}` observation on the metrics port and logs its stable
 * reason code. Labels stay bounded to the oracle type and the fired flag; candidate and replay ids stay off metrics.
 * The wrapper never changes a verdict.
 */

const ORACLE_EVAL_SPAN = 'validation.oracle.b';

/** Metrics port. A caller that exports metrics supplies it; the default records nothing. */
export interface OracleMetrics {
  evaluated(labels: { readonly oracleType: string; readonly fired: 'true' | 'false' }): void;
}

export const noopOracleMetrics: OracleMetrics = {
  evaluated: () => undefined,
};

export function observeEvaluator(
  oracleType: string,
  evaluator: OracleEvaluator,
  metrics: OracleMetrics = noopOracleMetrics,
): OracleEvaluator {
  return (observation, params) =>
    tracer.startActiveSpan(ORACLE_EVAL_SPAN, (span) => {
      span.setAttribute('oracleType', oracleType);
      try {
        const verdict = evaluator(observation, params);
        span.setAttribute('fired', verdict.matched);
        metrics.evaluated({ oracleType, fired: verdict.matched ? 'true' : 'false' });
        log.info(
          { oracleType, fired: verdict.matched, reason: verdict.reason },
          'oracle evaluated',
        );
        return verdict;
      } catch (error) {
        markSpanError(span, error instanceof Error ? error.name : 'unknown');
        throw error;
      } finally {
        span.end();
      }
    });
}
