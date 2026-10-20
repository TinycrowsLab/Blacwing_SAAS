import { AppError } from "@blackwing/errors";

/**
 * Why a configuration key was rejected. Stable machine keys: match on these, never on the message.
 * - `missing`: the key is required and not set.
 * - `empty`: the key is required and set to the empty string, which counts as unset.
 * - `invalid`: the key is set but its value does not satisfy the schema.
 */
export type ConfigIssueReason = "missing" | "empty" | "invalid";

/** One problem with one key. Carries the key name and a schema-derived description, never the value. */
export interface ConfigIssue {
  /** Environment key, or `(root)` for a schema-level refinement. Nested paths use `KEY[0]` / `KEY.x`. */
  readonly key: string;
  readonly reason: ConfigIssueReason;
  /** Human-readable description built from the schema (bounds, accepted forms), never from the input. */
  readonly message: string;
}

function formatMessage(issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => {
    switch (issue.reason) {
      case "missing":
        return `  - ${issue.key}: required but not set`;
      case "empty":
        return `  - ${issue.key}: required but empty (an empty value counts as unset)`;
      case "invalid":
        return `  - ${issue.key}: ${issue.message}`;
    }
  });
  const count = issues.length;
  return `Invalid configuration: ${String(count)} problem${count === 1 ? "" : "s"}\n${lines.join("\n")}`;
}

function uniqueKeys(issues: readonly ConfigIssue[], match: (issue: ConfigIssue) => boolean): readonly string[] {
  return Object.freeze([...new Set(issues.filter(match).map((issue) => issue.key))]);
}

/**
 * Raised when the environment does not satisfy a config schema. Every failing key is reported at
 * once. The message, `issues` and every other property hold key names and schema-derived text only:
 * no environment value, and no `cause` (a `ZodError` could carry input).
 *
 * An `AppError` with registry code `CONFIG_INVALID`: HTTP status 500 (a misconfigured service is a
 * server fault, never the client's) and `retryable: false` (the environment does not change by
 * retrying). It sets no client `detail`, so the problem+json mapper answers with the generic title.
 */
export class ConfigValidationError extends AppError {
  /** Stable error code. */
  declare readonly code: "CONFIG_INVALID";
  /** Every problem, in schema order. */
  readonly issues: readonly ConfigIssue[];
  /** Keys that are required but unset or empty. */
  readonly missingKeys: readonly string[];
  /** Keys that are set but invalid. */
  readonly invalidKeys: readonly string[];

  constructor(issues: readonly ConfigIssue[]) {
    super("CONFIG_INVALID", formatMessage(issues));
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
    this.missingKeys = uniqueKeys(this.issues, (issue) => issue.reason !== "invalid");
    this.invalidKeys = uniqueKeys(this.issues, (issue) => issue.reason === "invalid");
  }
}

/** Type guard for {@link ConfigValidationError}. */
export function isConfigValidationError(value: unknown): value is ConfigValidationError {
  return value instanceof ConfigValidationError;
}
