import type { z } from "zod";

/**
 * Marker placed in `params` of issues whose message is a fixed string written by this package (or by
 * an app through {@link safeMessage}). Only those messages are copied into a `ConfigValidationError`;
 * every other message is rebuilt from the issue's structural fields, so an error can never echo an
 * input value.
 */
const SAFE_MESSAGE_PARAM = "blackwingConfigSafeMessage";

/**
 * Builds the `{ message, params }` argument for `.refine()`/`ctx.addIssue()` that tells the loader
 * the message is a constant and may be shown as-is. Never interpolate the input into `message`.
 *
 * @example z.string().refine((v) => v.startsWith("bwk_"), safeMessage("must start with bwk_"))
 */
export function safeMessage(message: string): { message: string; params: Record<string, true> } {
  return { message, params: { [SAFE_MESSAGE_PARAM]: true } };
}

function hasSafeMessage(issue: z.core.$ZodIssue): boolean {
  return issue.code === "custom" && issue.params?.[SAFE_MESSAGE_PARAM] === true;
}

function describeBound(
  origin: string,
  bound: number | bigint,
  inclusive: boolean | undefined,
  side: "min" | "max",
): string {
  const bigger = side === "min";
  const value = String(bound);
  switch (origin) {
    case "string":
      return `must be ${bigger ? "at least" : "at most"} ${value} characters long`;
    case "array":
    case "set":
      return `must have ${bigger ? "at least" : "at most"} ${value} items`;
    default: {
      const op = bigger ? (inclusive === false ? ">" : ">=") : inclusive === false ? "<" : "<=";
      return `must be ${op} ${value}`;
    }
  }
}

/** Reads a schema-supplied string field (`prefix`, `suffix`, `includes`) of a string-format issue. */
function formatParam(issue: z.core.$ZodIssueInvalidStringFormat, field: "prefix" | "suffix" | "includes"): string {
  // Zod's issue union only types these fields on the format-specific subtypes, so read them structurally.
  const value: unknown = Reflect.get(issue, field);
  return typeof value === "string" ? JSON.stringify(value) : "the required text";
}

/**
 * Describes a string-format issue. Prefix/suffix/substring constraints come from the schema, so they
 * are safe to show. A regex is not printed: a pattern can be specific enough to narrow the value down.
 */
function describeFormat(issue: z.core.$ZodIssueInvalidStringFormat): string {
  switch (issue.format) {
    case "starts_with":
      return `must start with ${formatParam(issue, "prefix")}`;
    case "ends_with":
      return `must end with ${formatParam(issue, "suffix")}`;
    case "includes":
      return `must include ${formatParam(issue, "includes")}`;
    case "regex":
      return "must match the required pattern";
    default:
      return `must be a valid ${issue.format}`;
  }
}

/**
 * Describes one Zod issue without reading `issue.input` or any free-form message, so the text is safe
 * to put in an error or a log line. Option lists (`z.enum`) and bounds come from the schema, never
 * from the environment.
 */
export function describeIssue(issue: z.core.$ZodIssue): string {
  if (hasSafeMessage(issue)) {
    return issue.message;
  }
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "too_small":
      return describeBound(issue.origin, issue.minimum, issue.inclusive, "min");
    case "too_big":
      return describeBound(issue.origin, issue.maximum, issue.inclusive, "max");
    case "invalid_format":
      return describeFormat(issue);
    case "invalid_value":
      return `must be one of: ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "not_multiple_of":
      return `must be a multiple of ${String(issue.divisor)}`;
    case "unrecognized_keys":
      return `has unrecognised keys: ${issue.keys.join(", ")}`;
    case "invalid_union":
      return "does not match any accepted form";
    case "invalid_key":
    case "invalid_element":
      return `has an invalid ${issue.code === "invalid_key" ? "key" : "element"}`;
    case "custom":
      return "failed validation";
  }
}

/** Renders a nested issue path (below the top-level key) as `[2]` / `.field`. */
export function describeSubPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => (typeof segment === "number" ? `[${String(segment)}]` : `.${String(segment)}`)).join("");
}
