import { headerCookieParamsSchema } from '@blackwing/contracts';

import { INVALID_PARAMS, NO_OBSERVATION, probeExchange } from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';
import type { ObservedHeader } from '../oracle.js';

interface ParsedCookie {
  readonly name: string;
  readonly attributes: ReadonlySet<string>;
}

/** Reads one `Set-Cookie` value: the cookie name and the lowercased names of its attributes. The value is never kept. */
export function parseSetCookie(value: string): ParsedCookie {
  const [pair = '', ...attributes] = value.split(';');
  const equals = pair.indexOf('=');
  const name = (equals === -1 ? pair : pair.slice(0, equals)).trim();
  const names = attributes.map(
    (attribute) => attribute.split('=', 1)[0]?.trim().toLowerCase() ?? '',
  );
  return { name, attributes: new Set(names) };
}

/**
 * Security header or cookie attribute (WSTG-SESS-02, CWE-614, CWE-1004, CWE-942). A header assertion fires when a
 * required header is missing, when a forbidden header is present, or when its value equals `disallowedValue` (for
 * example `*` on `Access-Control-Allow-Origin`). A cookie assertion fires when a cookie set by the probe lacks its
 * required attribute. A cookie the probe did not set never fires.
 */
export const evaluateHeaderCookie: OracleEvaluator = (observation, params) => {
  const parsed = headerCookieParamsSchema.safeParse(params);
  if (!parsed.success) return INVALID_PARAMS;
  const exchange = probeExchange(observation);
  if (exchange?.headers === undefined) {
    return NO_OBSERVATION;
  }
  const assertion = parsed.data;
  const headers: readonly ObservedHeader[] = exchange.headers;

  if (assertion.target === 'cookie') {
    const attribute = assertion.attribute?.toLowerCase() ?? '';
    const cookies = headers
      .filter((header) => header.name === 'set-cookie')
      .map((header) => parseSetCookie(header.value))
      .filter((cookie) => cookie.name === assertion.name);
    if (cookies.length === 0) return { matched: false, reason: 'cookie_not_set' };
    const hasAttribute = (cookie: ParsedCookie): boolean => cookie.attributes.has(attribute);
    if (assertion.expectation === 'present') {
      return cookies.some((cookie) => !hasAttribute(cookie))
        ? { matched: true, reason: 'cookie_attribute_missing' }
        : { matched: false, reason: 'cookie_attribute_set' };
    }
    return cookies.some((cookie) => hasAttribute(cookie))
      ? { matched: true, reason: 'cookie_attribute_present' }
      : { matched: false, reason: 'cookie_attribute_unset' };
  }

  const name = assertion.name.toLowerCase();
  const values = headers
    .filter((header) => header.name === name)
    .map((header) => header.value.trim());
  const present = values.length > 0;
  if (assertion.expectation === 'absent') {
    return present
      ? { matched: true, reason: 'header_present' }
      : { matched: false, reason: 'header_absent' };
  }
  if (!present) return { matched: true, reason: 'header_missing' };
  const disallowed = assertion.disallowedValue?.toLowerCase();
  if (disallowed !== undefined && values.some((value) => value.toLowerCase() === disallowed)) {
    return { matched: true, reason: 'header_value_disallowed' };
  }
  return { matched: false, reason: 'header_present' };
};
