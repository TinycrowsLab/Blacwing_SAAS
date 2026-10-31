import { headerCookieParamsSchema } from '@blackwing/contracts';

import { INVALID_PARAMS, NO_OBSERVATION, probeExchange } from './shared.js';

import type { OracleEvaluator } from '../dispatch.js';
import type { ObservedHeader, OracleVerdict } from '../oracle.js';

type HeaderCookieAssertion = ReturnType<
  typeof headerCookieParamsSchema.parse
>['assertions'][number];

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

/** Judges one assertion against the probe's headers. Header names and values compare case-insensitively, trimmed. */
function judge(
  headers: readonly ObservedHeader[],
  assertion: HeaderCookieAssertion,
): OracleVerdict {
  if (assertion.target === 'cookie') {
    const attribute = assertion.attribute?.toLowerCase() ?? '';
    const cookies = headers
      .filter((header) => header.name === 'set-cookie')
      .map((header) => parseSetCookie(header.value))
      .filter((cookie) => cookie.name === assertion.name);
    // A cookie the probe did not set has no attributes to judge, so it never fires.
    if (cookies.length === 0) return { matched: false, reason: 'cookie_not_set' };
    if (assertion.expectation === 'present') {
      return cookies.some((cookie) => !cookie.attributes.has(attribute))
        ? { matched: true, reason: 'cookie_attribute_missing' }
        : { matched: false, reason: 'cookie_attribute_set' };
    }
    return cookies.some((cookie) => cookie.attributes.has(attribute))
      ? { matched: true, reason: 'cookie_attribute_present' }
      : { matched: false, reason: 'cookie_attribute_unset' };
  }

  const name = assertion.name.toLowerCase();
  const values = headers
    .filter((header) => header.name === name)
    .map((header) => header.value.trim().toLowerCase());
  if (assertion.expectation === 'present') {
    return values.length === 0
      ? { matched: true, reason: 'header_missing' }
      : { matched: false, reason: 'header_present' };
  }
  if (assertion.expectation === 'absent') {
    return values.length > 0
      ? { matched: true, reason: 'header_present' }
      : { matched: false, reason: 'header_absent' };
  }
  const disallowed = assertion.disallowedValue?.trim().toLowerCase() ?? '';
  return values.includes(disallowed)
    ? { matched: true, reason: 'header_value_disallowed' }
    : { matched: false, reason: 'header_value_allowed' };
}

/**
 * Security header or cookie attribute (WSTG-SESS-02, CWE-614, CWE-1004, CWE-942, CWE-693). The check fires when any
 * declared assertion fails: a required header is missing, a forbidden header is present, a header carries a
 * disallowed value (for example `*` on `Access-Control-Allow-Origin`), or a cookie set by the probe lacks a required
 * attribute. The first failing assertion names the verdict.
 */
export const evaluateHeaderCookie: OracleEvaluator = (observation, params) => {
  const parsed = headerCookieParamsSchema.safeParse(params);
  if (!parsed.success) return INVALID_PARAMS;
  const exchange = probeExchange(observation);
  if (exchange?.headers === undefined) return NO_OBSERVATION;

  for (const assertion of parsed.data.assertions) {
    const verdict = judge(exchange.headers, assertion);
    if (verdict.matched) return verdict;
  }
  return { matched: false, reason: 'all_assertions_hold' };
};
