import { errorSignatureParamsSchema } from '@blackwing/contracts';

import { INVALID_PARAMS, NO_OBSERVATION, nfc, probeExchange } from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';

/**
 * Error signature (WSTG-ERRH-01, CWE-209). Fires when one declared, catalogued signature (a literal, case-sensitive
 * token, never a payload) appears in the body or, for `scope: 'header'`, in a response header value. The first
 * declared signature that matches names the verdict. The verdict never echoes the surrounding response.
 */
export const evaluateErrorSignatureBinding: OracleEvaluator = (observation, params) => {
  const parsed = errorSignatureParamsSchema.safeParse(params);
  if (!parsed.success) return INVALID_PARAMS;
  const exchange = probeExchange(observation);
  if (exchange === undefined) return NO_OBSERVATION;

  const { signatures, scope } = parsed.data;
  if (scope === 'header' && exchange.headers === undefined) return NO_OBSERVATION;
  const headerValues = (exchange.headers ?? []).map((header) => nfc(header.value));
  const body = nfc(exchange.body);
  const matched = signatures.find((signature) =>
    scope === 'header'
      ? headerValues.some((value) => value.includes(signature))
      : body.includes(signature),
  );
  return matched === undefined
    ? { matched: false, reason: 'error_signature_absent' }
    : { matched: true, signature: matched, reason: 'error_signature_present' };
};
