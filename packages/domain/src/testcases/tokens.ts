/**
 * Name and path helpers shared by the catalogue predicates (WEBAPI-001, INFRASPEC-002). They turn a parameter
 * name, a path or a product name into lowercase word tokens so a predicate can match on meaning, not spelling.
 */

/** Lowercase word tokens of a name or path: `returnUrl`, `return_url` and `return-url` all give return, url. */
export function tokens(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The path of a URL, or the input unchanged when it does not parse as an absolute URL. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
