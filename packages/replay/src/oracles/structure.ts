/**
 * Structural projection for the status differential (VALIDATE-004). Derived from swiftPentest `lib/oracle.py`
 * (MIT, Copyright (c) 2026 SwiftSaneAI): the order-independent canonical JSON and the HTML tag skeleton. The
 * per-request dynamic-token stripping and the difflib ratio are not ported; the decision here is a counted difference.
 */

const JSON_START = /^[{[]/;
const TAG = /<\s*(\/?)\s*([a-zA-Z][\w-]*)[^>]*>/g;
const WHITESPACE = /\s+/;

/** Recursively sorts object keys and array elements, so reordering them is not a structural difference. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalise(item))
      .sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalise(record[key])]),
    );
  }
  return value;
}

/**
 * The structural tokens of a body. A JSON body yields one token per canonical leaf path and value, so key order and
 * array order drop out. Any other body yields its tag skeleton (`<tag>` / `</tag>`) and its whitespace-separated words.
 * The body is already NFC-normalised and bounded by the engine.
 */
export function structuralTokens(body: string): string[] {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (JSON_START.test(text)) {
    try {
      return [JSON.stringify(canonicalise(JSON.parse(text)))];
    } catch {
      // Not JSON after all: fall through to the markup projection.
    }
  }
  const tags = [...text.matchAll(TAG)].map(
    (match) => `<${match[1] ?? ''}${(match[2] ?? '').toLowerCase()}>`,
  );
  const words = text
    .replace(TAG, ' ')
    .split(WHITESPACE)
    .filter((word) => word.length > 0);
  return [...tags, ...words];
}

/** The number of structural tokens that occur in only one of the two bodies, counting multiplicity. */
export function structuralDifference(left: string, right: string): number {
  const counts = new Map<string, number>();
  for (const token of structuralTokens(left)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of structuralTokens(right)) counts.set(token, (counts.get(token) ?? 0) - 1);
  let difference = 0;
  for (const count of counts.values()) difference += Math.abs(count);
  return difference;
}
