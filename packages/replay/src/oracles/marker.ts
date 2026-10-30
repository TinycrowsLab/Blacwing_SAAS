import { markerParamsSchema } from '@blackwing/contracts';

import { INVALID_PARAMS, NO_OBSERVATION, nfc, probeExchange } from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';
import type { ObservedHeader } from '../oracle.js';

/** Matches the visible text of an HTML body: script and style contents (also an unclosed one) and tags removed. */
const NON_VISIBLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<[^>]*>/g;

/** The text a browser would render: script and style blocks and tags removed, so a marker inside markup does not count. */
export function visibleText(html: string): string {
  return html.replace(NON_VISIBLE_BLOCK, ' ').replace(TAG, ' ');
}

/**
 * Marker reflection (WSTG-INPV-01, CWE-79). The declared token is a harmless unique string, never a payload. It fires
 * when the exact token (after NFC) appears in the declared location of the probe response. An encoded or partial
 * form does not match, so the verdict stays exact.
 */
export const evaluateMarker: OracleEvaluator = (observation, params) => {
  const parsed = markerParamsSchema.safeParse(params);
  if (!parsed.success) return INVALID_PARAMS;
  const exchange = probeExchange(observation);
  if (exchange === undefined) return NO_OBSERVATION;

  const { token, location } = parsed.data;
  const found = (() => {
    if (location === 'header') {
      if (exchange.headers === undefined) return undefined;
      return exchange.headers.some((header: ObservedHeader) => nfc(header.value).includes(token));
    }
    const body = nfc(exchange.body);
    return (location === 'dom' ? visibleText(body) : body).includes(token);
  })();
  if (found === undefined) return NO_OBSERVATION;
  return found
    ? { matched: true, reason: 'marker_reflected' }
    : { matched: false, reason: 'marker_absent' };
};
