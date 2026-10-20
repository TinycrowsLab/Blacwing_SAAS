/**
 * Redaction applied to every string the mapper serialises or logs.
 *
 * The authoritative registry of known secret values belongs to `@blackwing/logger` (FOUND-008), fed
 * by `@blackwing/config` `markSecret` (FOUND-007). This package sits below both in the dependency
 * graph (both throw errors from here), so it cannot import them. Instead the
 * boundary passes the logger's value redactor in as a {@link Redactor}. A built-in pattern pass for
 * Blackwing's own credential formats always runs as well, so a missing redactor never means
 * unredacted output.
 */

/** Replaces every secret in `text` with a marker and returns the result. Must be pure and total. */
export type Redactor = (text: string) => string;

/** Marker that replaces a redacted value. Matches the logger's marker. */
export const REDACTED = '[REDACTED]';

interface Rule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Credential shapes that must never appear in an error body or error log, whatever the registry
 * holds: virtual model keys, personal access and CI tokens (§9), bearer/basic authorization values,
 * URL userinfo and PEM private keys.
 */
const BUILTIN_RULES: readonly Rule[] = Object.freeze([
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: REDACTED,
  },
  { pattern: /\b(?:bwk|bw_pat|bw_ci)_[A-Za-z0-9_-]+/g, replacement: REDACTED },
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, replacement: `$1${REDACTED}@` },
]);

/** Applies the built-in credential patterns only. */
export function redactBuiltinSecrets(text: string): string {
  let result = text;
  for (const rule of BUILTIN_RULES) result = result.replace(rule.pattern, rule.replacement);
  return result;
}

/**
 * Builds the redactor the mapper uses: the injected registry redactor first (exact secret values),
 * then the built-in patterns. If the injected redactor throws or returns a non-string, the result is
 * `undefined` and the caller must drop the text (fail closed).
 */
export function composeRedactor(
  registry: Redactor | undefined,
): (text: string) => string | undefined {
  return (text) => {
    let result: unknown = text;
    if (registry !== undefined) {
      try {
        result = registry(text);
      } catch {
        return undefined;
      }
      if (typeof result !== 'string') return undefined;
    }
    return redactBuiltinSecrets(result as string);
  };
}

/** End of a stack frame line: a `file:line:column` location (optionally in parentheses) or a V8 pseudo-location. */
const FRAME_LOCATION = /(?::\d+:\d+\)?|\(<anonymous>\)|\(native\))$/;

/**
 * Does `text` look like it contains a stack trace? True when any line is a V8 frame
 * (`    at fn (file.js:1:2)`, `    at file.js:1:2`, `    at new X (<anonymous>)`) or a
 * SpiderMonkey/JSC frame (`fn@file.js:1:2`). Checked line by line with anchored patterns so that
 * long or hostile input stays linear.
 */
export function containsStackTrace(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!FRAME_LOCATION.test(line)) continue;
    if (line.startsWith('at ')) return true;
    const at = line.indexOf('@');
    if (at >= 0 && !/\s/.test(line.slice(at))) return true;
  }
  return false;
}
