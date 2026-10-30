import { benignSentinelIdSchema, oracleParamsSchemas } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import type { RawObservation } from '../engine.js';
import type { OracleVerdict } from '../oracle.js';

/**
 * The `file_read` evaluator (CWE-22, WSTG-ATHZ/INPV). It asserts only on a declared benign marker: a harmless,
 * in-scope sentinel the lab placed in a file that must not be reachable by the probe. It never reads a file itself,
 * and it never reads sensitive system files as a technique (§8.11). The marker is validated as a sentinel id by the
 * binding contract at spec time, so a path, a traversal sequence or a credential-shaped value is refused before any
 * replay runs. Evaluation re-checks it, so a malformed binding can never reach the comparison.
 */

/** Success is any 2xx status. */
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

export const FILE_READ_REASONS = {
  sentinelAbsent: 'sentinel_absent',
  sentinelReturned: 'sentinel_returned',
  truncatedBeforeSentinel: 'truncated_before_sentinel',
} as const;

/** Throws when `marker` is not a benign sentinel id. Used at spec validation and again before evaluation. */
export function assertBenignSentinel(marker: string): void {
  if (!benignSentinelIdSchema.safeParse(marker).success) {
    throw new ValidationError(
      'file_read marker must be a benign sentinel id, not a path or a value',
    );
  }
}

export function fileReadEvaluator(observation: RawObservation, params: unknown): OracleVerdict {
  const parsed = oracleParamsSchemas.file_read.safeParse(params);
  if (!parsed.success) throw new ValidationError('file_read params are invalid');
  assertBenignSentinel(parsed.data.marker);
  const { marker } = parsed.data;

  // Only successful responses count: a 404 or an error page that happens to echo the marker is not a file read.
  const served = observation.exchanges.filter(
    (exchange) =>
      exchange.status !== null &&
      exchange.status >= HTTP_SUCCESS_MIN &&
      exchange.status < HTTP_SUCCESS_MAX,
  );
  if (served.some((exchange) => exchange.body.includes(marker))) {
    return { matched: true, reason: FILE_READ_REASONS.sentinelReturned };
  }
  // A truncated body may hold the marker past the cut, so its absence is not evidence of absence.
  if (observation.exchanges.some((exchange) => exchange.truncated)) {
    return { matched: false, reason: FILE_READ_REASONS.truncatedBeforeSentinel };
  }
  return { matched: false, reason: FILE_READ_REASONS.sentinelAbsent };
}
