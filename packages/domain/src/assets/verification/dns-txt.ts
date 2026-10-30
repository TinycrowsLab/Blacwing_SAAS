/**
 * DNS TXT ownership proof (ASSET-005, CONTEXT_PACK §8.10): the pure rules a DNS probe applies to what it observed.
 * The network lookup lives in the worker; this file only decides what an answer means.
 *
 * The challenge `token` is the full `blackwing-site-verification=<base32>` record value (the prefix is part of the
 * token, see `VERIFICATION_TOKEN_PREFIX`), so a TXT value proves control when it equals that token.
 */

/** The bounds the probe runs under (`bw.asset.dns.*`). The worker reads its overrides from config. */
export const DNS_TXT_DEFAULTS = Object.freeze({
  /** `bw.asset.dns.timeoutMs`: per resolver query. */
  timeoutMs: 5_000,
  /** `bw.asset.dns.retries`: retries after a resolver failure (SERVFAIL, timeout), before a retryable error. */
  retries: 2,
  /** `bw.asset.dns.maxRecords`: TXT values considered per lookup. Larger sets are cut, never trusted past the cap. */
  maxRecords: 50,
});

/** Case and surrounding whitespace are noise in a published TXT value; the token itself is not otherwise changed. */
export function normaliseTxtValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Whether one of the observed TXT values is the challenge token. Any single match passes (a zone may hold many
 * TXT records); an empty set never matches.
 */
export function matchesDnsTxt(token: string, observedValues: readonly string[]): boolean {
  const expected = normaliseTxtValue(token);
  return observedValues.some((value) => normaliseTxtValue(value) === expected);
}

/**
 * Keeps at most `maxRecords` values, in resolver order. `truncated` is set when values were dropped, so the record
 * can say that the answer was partial.
 */
export function capDnsTxtValues(
  values: readonly string[],
  maxRecords: number,
): { readonly values: readonly string[]; readonly truncated: boolean } {
  return { values: values.slice(0, maxRecords), truncated: values.length > maxRecords };
}
