// Typed message catalogue accessor (#272, CONTEXT_PACK §5: next-intl-ready, English only v1).
//
// Every user-facing shell string lives in `src/messages/en.json` and is read through `t()`. The keys
// are the JSON's own keys, so a key that is not in the catalogue is a TypeScript error. Templates use
// `{name}` placeholders; the message format is ICU-compatible (see docs/architecture/i18n.md), so a
// future `next-intl` provider can take the same catalogue without moving keys.

import en from '../messages/en.json';

/** Any key of the English catalogue. Passing an unknown key is a compile error. */
export type MessageKey = keyof typeof en;

export type MessageParams = Readonly<Record<string, string | number>>;

/** Active locale for `Intl` formatting. Only English ships in v1. */
export const DEFAULT_LOCALE = 'en';

const CATALOGUE: Readonly<Record<string, string>> = en;

/** Replaces `{name}` placeholders. A placeholder without a param is left visible, so a gap shows. */
export function formatMessage(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * The message for `key`. A missing key (only reachable through an unchecked cast) renders the key
 * itself: developer-authored text, never user data, and visibly wrong during development. The
 * console does not log it (the repo bans console in web code); see docs/architecture/i18n.md.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  if (!Object.hasOwn(CATALOGUE, key)) return key;
  return formatMessage(CATALOGUE[key] ?? key, params);
}

/** Dates in the active locale. Callers pass options such as `timeZone`; never concatenate parts. */
export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, options).format(value);
}

/** Numbers in the active locale. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, options).format(value);
}
