import { statusDiffParamsSchema } from '@blackwing/contracts';

import {
  INVALID_PARAMS,
  isRecord,
  NO_OBSERVATION,
  nfc,
  OracleBaselineMissingError,
  probeExchange,
} from './shared.js';
import { structuralDifference } from './structure.js';

import type { OracleEvaluator } from '../dispatch.js';
/**
 * Status differential (WSTG-ATHZ-02, CWE-639). The probe is compared with the baseline exchange recorded earlier in
 * the same replay, named by `baselineRef`. `status` compares the HTTP status, `length` the NFC body length, and
 * `structural` the structural token difference (canonical JSON or markup skeleton). The verdict fires when the
 * difference exceeds the declared threshold. A missing baseline throws, so the candidate stays Suspected; malformed
 * params fail closed without firing.
 */
export const evaluateStatusDiff: OracleEvaluator = (observation, params) => {
  if (!isRecord(params)) return INVALID_PARAMS;
  const parsed = statusDiffParamsSchema.safeParse(params);
  if (!parsed.success) {
    if (params.baselineRef === undefined) throw new OracleBaselineMissingError();
    return INVALID_PARAMS;
  }
  const probe = probeExchange(observation);
  if (probe === undefined) return NO_OBSERVATION;

  const { baselineRef, compare, threshold } = parsed.data;
  // Only exchanges recorded before the probe can be the baseline: the probe never compares with itself.
  const baseline = observation.exchanges
    .slice(0, -1)
    .find((exchange) => exchange.evidenceRef === baselineRef && exchange.status !== null);
  if (baseline === undefined) throw new OracleBaselineMissingError();

  if (compare === 'status') {
    return probe.status === baseline.status
      ? { matched: false, reason: 'status_unchanged' }
      : { matched: true, reason: 'status_differs' };
  }
  if (compare === 'length') {
    const delta = Math.abs(nfc(probe.body).length - nfc(baseline.body).length);
    return delta > threshold
      ? { matched: true, reason: 'length_differs' }
      : { matched: false, reason: 'length_within_threshold' };
  }
  const difference = structuralDifference(nfc(probe.body), nfc(baseline.body));
  return difference > threshold
    ? { matched: true, reason: 'structure_differs' }
    : { matched: false, reason: 'structure_within_threshold' };
};
