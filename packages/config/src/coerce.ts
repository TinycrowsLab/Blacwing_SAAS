import { z } from "zod";

import { safeMessage } from "./issues.js";
import { markSecret, type Secret } from "./redaction.js";

/**
 * Coercion helpers for environment values. Environment values are always strings; these parse them
 * strictly and reject malformed input with a precise, value-free message.
 *
 * Whitespace policy ("trim only where declared"): no helper trims unless documented. `zString({ trim:
 * true })` and the items of `zCsv` are the only places surrounding whitespace is removed. Numbers,
 * booleans, ports, durations and URLs with surrounding whitespace are rejected, and secrets are kept
 * verbatim.
 */

const ISSUE_BOOL = safeMessage("must be one of: true, false, 1, 0");
const ISSUE_PORT = safeMessage("must be an integer port between 1 and 65535 (digits only)");
const ISSUE_DURATION = safeMessage(
  "must be a non-negative integer duration: plain milliseconds or a number with unit ms, s, m, h or d",
);
const ISSUE_DURATION_RANGE = safeMessage("is too large to represent as a safe integer number of milliseconds");
const ISSUE_URL = safeMessage("must be an absolute URL");
const ISSUE_URL_WHITESPACE = safeMessage("must not have leading or trailing whitespace");
const ISSUE_BLANK = safeMessage("must not be blank");

/** Options for {@link zString}. */
export interface StringOptions {
  /** Remove leading/trailing whitespace before validating. Off by default: values are kept verbatim. */
  readonly trim?: boolean;
}

/**
 * A required, non-empty string. With `trim: true` the value is trimmed first and a whitespace-only
 * value is rejected; otherwise it is kept verbatim.
 */
export function zString(options: StringOptions = {}): z.ZodType<string, string> {
  if (options.trim === true) {
    return z
      .string()
      .trim()
      .refine((value) => value.length > 0, ISSUE_BLANK);
  }
  return z.string().min(1);
}

/** Boolean flag: `true`/`false` (any letter case) or `1`/`0`. Anything else is rejected. */
export function zBool(): z.ZodType<boolean, string> {
  return z.string().transform((raw, ctx): boolean => {
    switch (raw.toLowerCase()) {
      case "true":
      case "1":
        return true;
      case "false":
      case "0":
        return false;
      default:
        ctx.addIssue({ code: "custom", ...ISSUE_BOOL });
        return z.NEVER;
    }
  });
}

/** TCP/UDP port: decimal digits only, no sign, no leading zero, 1..65535. */
export function zPort(): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    if (/^[1-9][0-9]{0,4}$/.test(raw)) {
      const port = Number(raw);
      if (port <= 65_535) {
        return port;
      }
    }
    ctx.addIssue({ code: "custom", ...ISSUE_PORT });
    return z.NEVER;
  });
}

const DURATION_UNITS_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type DurationUnit = keyof typeof DURATION_UNITS_MS;

function isDurationUnit(value: string): value is DurationUnit {
  return Object.hasOwn(DURATION_UNITS_MS, value);
}

/**
 * Duration in milliseconds. Accepts a plain non-negative integer (milliseconds) or an integer with a
 * unit: `250ms`, `30s`, `5m`, `2h`, `1d`. Fractions, signs, spaces and mixed units are rejected.
 */
export function zDurationMs(): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    const match = /^([0-9]+)(ms|s|m|h|d)?$/.exec(raw);
    const digits = match?.[1];
    if (digits === undefined) {
      ctx.addIssue({ code: "custom", ...ISSUE_DURATION });
      return z.NEVER;
    }
    const unit = match?.[2] ?? "ms";
    const factor = isDurationUnit(unit) ? DURATION_UNITS_MS[unit] : Number.NaN;
    const ms = Number(digits) * factor;
    if (!Number.isSafeInteger(ms)) {
      ctx.addIssue({ code: "custom", ...ISSUE_DURATION_RANGE });
      return z.NEVER;
    }
    return ms;
  });
}

/** Options for {@link zUrl} and {@link zSecretUrl}. */
export interface UrlOptions {
  /** Accepted schemes including the trailing colon, e.g. `["https:"]`. Any scheme when omitted. */
  readonly protocols?: readonly string[];
}

function urlIssue(protocols: readonly string[]): ReturnType<typeof safeMessage> {
  return safeMessage(`must use one of the schemes: ${protocols.join(", ")}`);
}

function registerUrlPassword(url: URL): void {
  if (url.password.length === 0) {
    return;
  }
  // Embedded credentials are always secret, even when the URL as a whole is not declared secret.
  markSecret(url.password);
  try {
    markSecret(decodeURIComponent(url.password));
  } catch {
    // A malformed percent-escape cannot be decoded; the raw form is already registered.
  }
}

function urlSchema(options: UrlOptions): z.ZodType<string, string> {
  const { protocols } = options;
  return z.string().transform((raw, ctx): string => {
    if (raw !== raw.trim()) {
      ctx.addIssue({ code: "custom", ...ISSUE_URL_WHITESPACE });
      return z.NEVER;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", ...ISSUE_URL });
      return z.NEVER;
    }
    registerUrlPassword(url);
    if (protocols !== undefined && !protocols.includes(url.protocol)) {
      ctx.addIssue({ code: "custom", ...urlIssue(protocols) });
      return z.NEVER;
    }
    return raw;
  });
}

/**
 * Absolute URL, returned verbatim as a string. The password of embedded credentials
 * (`scheme://user:pass@host`) is registered for redaction automatically. Use {@link zSecretUrl} when
 * the whole URL is sensitive (connection strings, URLs with tokens in the query).
 */
export function zUrl(options: UrlOptions = {}): z.ZodType<string, string> {
  return urlSchema(options);
}

/** Like {@link zUrl}, and the whole URL is registered for redaction and branded {@link Secret}. */
export function zSecretUrl(options: UrlOptions = {}): z.ZodType<Secret, string> {
  return urlSchema(options)
    .transform((value) => markSecret(value))
    .brand("Secret");
}

/**
 * A required secret: non-empty, kept verbatim (never trimmed or normalised), registered for value
 * redaction as soon as it parses, and branded {@link Secret}.
 */
export function zSecret(): z.ZodType<Secret, string> {
  return z
    .string()
    .min(1)
    .transform((value) => markSecret(value))
    .brand("Secret");
}

/**
 * Comma-separated list. Items are trimmed (declared here), and each item must be non-empty and pass
 * `item` (default: any non-empty string). The result is a frozen readonly array.
 */
export function zCsv(): z.ZodType<readonly string[], string>;
export function zCsv<T>(item: z.ZodType<T, string>): z.ZodType<readonly T[], string>;
export function zCsv<T>(item?: z.ZodType<T, string>): z.ZodType<readonly (T | string)[], string> {
  const element: z.ZodType<T | string, string> = item ?? z.string();
  return z
    .string()
    .transform((raw): readonly string[] => raw.split(",").map((part) => part.trim()))
    .pipe(z.array(z.string().min(1).pipe(element)).readonly());
}
