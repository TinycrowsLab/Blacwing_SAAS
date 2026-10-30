import { statusDiffParamsSchema } from '@blackwing/contracts';

import {
  INVALID_PARAMS,
  isRecord,
  NO_OBSERVATION,
  OracleBaselineMissingError,
  probeExchange,
} from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';

/**
 * Status differential (WSTG-ATHZ-02, CWE-639). The probe must return the declared `expectedStatus`, which must differ
 * from the recorded `baselineStatus`. A missing baseline throws, so the candidate stays Suspected; malformed params
 * fail closed without firing.
 */
export const evaluateStatusDiff: OracleEvaluator = (observation, params) => {
  const parsed = statusDiffParamsSchema.safeParse(params);
  if (!parsed.success) {
    if (isRecord(params) && params.baselineStatus === undefined)
      throw new OracleBaselineMissingError();
    return INVALID_PARAMS;
  }
  const exchange = probeExchange(observation);
  if (exchange === undefined) return NO_OBSERVATION;
  return exchange.status === parsed.data.expectedStatus
    ? { matched: true, reason: 'status_matches_expected' }
    : { matched: false, reason: 'status_differs' };
};
