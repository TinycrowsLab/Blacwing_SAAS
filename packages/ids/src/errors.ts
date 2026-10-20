/**
 * Why an identifier was rejected. Stable machine keys: callers and tests match on these,
 * never on the human-readable message.
 */
export type IdValidationReason =
  /** The value is not a string. */
  | "not_a_string"
  /** No `_` separator, empty prefix or empty body, or the prefix is not lowercase `a-z`. */
  | "malformed"
  /** The prefix is well-formed but not in the registry (`ID_PREFIXES`). */
  | "unknown_prefix"
  /** The prefix is registered but is not the one the caller asked for. */
  | "prefix_mismatch"
  /** The body is not exactly 26 characters long. */
  | "invalid_length"
  /** The body contains a character outside lowercase Crockford base32 (uppercase, `i`, `l`, `o`, `u`, ...). */
  | "invalid_base32"
  /** The first body character is above `7`: the value would not fit in 128 bits. */
  | "non_canonical"
  /** The value is not a canonical 8-4-4-4-12 hex UUID. */
  | "invalid_uuid"
  /** The UUID is well-formed but is not version 7 with the RFC 9562 variant. */
  | "not_uuidv7";

/**
 * Raised for every malformed identifier.
 *
 * It carries the `VALIDATION_FAILED` code and HTTP status 422 that the `@blackwing/errors`
 * registry (FOUND-009) assigns to `ValidationError`, so a boundary can map it to problem+json today.
 * TODO(#11): extend `ValidationError` from `@blackwing/errors` once that package lands.
 *
 * The message never echoes the rejected value: identifiers arrive from untrusted input and a caller
 * may pass something sensitive (a token, say) by mistake. Only the reason and the expected prefix
 * are reported.
 */
export class IdValidationError extends Error {
  /** Stable error code shared with `@blackwing/errors` `ValidationError`. */
  readonly code = "VALIDATION_FAILED" as const;
  /** HTTP status the API maps this error to. */
  readonly httpStatus = 422 as const;
  /** Malformed input never becomes valid on retry. */
  readonly retryable = false as const;
  /** Machine-readable reason for the rejection. */
  readonly reason: IdValidationReason;

  constructor(reason: IdValidationReason, message: string) {
    super(message);
    this.name = "ValidationError";
    this.reason = reason;
  }
}

/** Type guard for {@link IdValidationError}. */
export function isIdValidationError(value: unknown): value is IdValidationError {
  return value instanceof IdValidationError;
}
