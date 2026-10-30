import { accessMatrixEvaluator } from './access-matrix.js';
import { fileReadEvaluator } from './file-read.js';
import { noopOracleMetrics, observeEvaluator, type OracleMetrics } from './observe.js';
import { oobEvaluator } from './out-of-band.js';
import { timingBaselineEvaluator } from './timing-baseline.js';

import type { OracleEvaluator } from '../dispatch.js';
import type { SignalStore } from './signals.js';

export { assertBenignSentinel, FILE_READ_REASONS, fileReadEvaluator } from './file-read.js';
export {
  ACCESS_MATRIX_AUDIT_EVENT,
  ACCESS_MATRIX_REASONS,
  accessMatrixEvaluator,
} from './access-matrix.js';
export { OOB_AUDIT_EVENT, OOB_REASONS, oobEvaluator } from './out-of-band.js';
export { noopOracleMetrics, type OracleMetrics } from './observe.js';
export { TIMING_REASONS, timingBaselineEvaluator } from './timing-baseline.js';
export type { OobSignal, ReplaySignals, RoleAccess, SignalStore, TimingSignal } from './signals.js';

/**
 * The four signal-backed evaluators, keyed by oracle type, ready for `createOracleDispatcher`. The signal store is the
 * only source of recorded timings, callbacks and role outcomes, so each evaluator is a pure function of its inputs.
 * Each one is wrapped for span, metric and log output; the wrapper never changes a verdict.
 */
export function createSignalEvaluators(
  signals: SignalStore,
  metrics: OracleMetrics = noopOracleMetrics,
): ReadonlyMap<string, OracleEvaluator> {
  const raw = new Map<string, OracleEvaluator>([
    ['timing_baseline', timingBaselineEvaluator(signals)],
    ['oob', oobEvaluator(signals)],
    ['access_matrix', accessMatrixEvaluator(signals)],
    ['file_read', fileReadEvaluator],
  ]);
  return new Map(
    [...raw].map(([type, evaluator]) => [type, observeEvaluator(type, evaluator, metrics)]),
  );
}
