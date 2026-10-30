import { errorSignatureParamsSchema } from '@blackwing/contracts';

import { INVALID_PARAMS, NO_OBSERVATION, nfc, probeExchange } from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';

/**
 * Error signature (WSTG-ERRH-01, CWE-209). Fires when the declared, catalogued signature (a literal, case-sensitive
 * token, never a payload) appears in the body or, for `scope: 'header'`, in a response header value. The verdict
 * names the matched signature, never the surrounding response.
 */
export const evaluateErrorSignatureBinding: OracleEvaluator = (observation, params) => {
  const parsed = errorSignatureParamsSchema.safeParse(params);
  if (!parsed.success) return INVALID_PARAMS;
  const exchange = probeExchange(observation);
  if (exchange === undefined) return NO_OBSERVATION;

  const { signature, scope } = parsed.data;
  const found = (() => {
    if (scope === 'header') {
      if (exchange.headers === undefined) return undefined;
      return exchange.headers.some((header) => nfc(header.value).includes(signature));
    }
    return nfc(exchange.body).includes(signature);
  })();
  if (found === undefined) return NO_OBSERVATION;
  return found
    ? { matched: true, signature, reason: 'error_signature_present' }
    : { matched: false, reason: 'error_signature_absent' };
};
