/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON subset Blackwing signs and binds as AAD:
 * `null`, booleans, finite numbers, strings, arrays and plain objects. Member names sort by UTF-16
 * code units; strings and numbers serialise the way ECMAScript `JSON.stringify` does, which RFC 8785
 * adopts verbatim. Anything else (undefined members aside) throws rather than canonicalising wrongly.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('jcs: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`;
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError('jcs: not a plain object');
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`jcs: unsupported ${typeof value}`);
}
