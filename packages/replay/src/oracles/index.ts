import { accessMatrixEvaluator } from './access-matrix.js';
import { evaluateErrorSignatureBinding } from './error-signature.js';
import { fileReadEvaluator } from './file-read.js';
import { evaluateHeaderCookie } from './header-cookie.js';
import { evaluateMarker } from './marker.js';
import { noopOracleMetrics, observeEvaluator, type OracleMetrics } from './observe.js';
import { oobEvaluator } from './out-of-band.js';
import { evaluateStatusDiff } from './status-diff.js';
import { timingBaselineEvaluator } from './timing-baseline.js';

import type { OracleEvaluator } from '../dispatch.js';
import type { SignalStore } from './signals.js';

export { assertBenignSentinel, FILE_READ_REASONS, fileReadEvaluator } from './file-read.js';
export { OracleBaselineMissingError } from './shared.js';
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
 * The four deterministic evaluators (VALIDATE-004), keyed by oracle type, each observed for span, metric and log
 * output. They are pure functions of the recorded response and the declared params (§8.11).
 */
export function createDeterministicEvaluators(
  metrics: OracleMetrics = noopOracleMetrics,
): ReadonlyMap<string, OracleEvaluator> {
  const raw = new Map<string, OracleEvaluator>([
    ['marker', evaluateMarker],
    ['status_diff', evaluateStatusDiff],
    ['error_signature', evaluateErrorSignatureBinding],
    ['header_cookie', evaluateHeaderCookie],
  ]);
  return new Map(
    [...raw].map(([type, evaluator]) => [type, observeEvaluator(type, evaluator, metrics)]),
  );
}

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
