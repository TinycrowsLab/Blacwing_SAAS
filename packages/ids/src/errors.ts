import { ValidationError } from '@blackwing/errors';

/**
 * Why an identifier was rejected. Stable machine keys: callers and tests match on these,
 * never on the human-readable message.
 */
export type IdValidationReason =
  /** The value is not a string. */
  | 'not_a_string'
  /** No `_` separator, empty prefix or empty body, or the prefix is not lowercase `a-z`. */
  | 'malformed'
  /** The prefix is well-formed but not in the registry (`ID_PREFIXES`). */
  | 'unknown_prefix'
  /** The prefix is registered but is not the one the caller asked for. */
  | 'prefix_mismatch'
  /** The body is not exactly 26 characters long. */
  | 'invalid_length'
  /** The body contains a character outside lowercase Crockford base32 (uppercase, `i`, `l`, `o`, `u`, ...). */
  | 'invalid_base32'
  /** The first body character is above `7`: the value would not fit in 128 bits. */
  | 'non_canonical'
  /** The value is not a canonical 8-4-4-4-12 hex UUID. */
  | 'invalid_uuid'
  /** The UUID is well-formed but is not version 7 with the RFC 9562 variant. */
  | 'not_uuidv7';

/**
 * Raised for every malformed identifier.
 *
 * A `ValidationError` from `@blackwing/errors`: code `VALIDATION_FAILED`, HTTP 422, not retryable,
 * so the problem+json mapper answers 422 with the message as `detail`.
 *
 * The message never echoes the rejected value: identifiers arrive from untrusted input and a caller
 * may pass something sensitive (a token, say) by mistake. Only the reason and the expected prefix
 * are reported, which is why the message is also safe to use as the client-facing `detail`.
 */
export class IdValidationError extends ValidationError {
  /** Machine-readable reason for the rejection. */
  readonly reason: IdValidationReason;

  constructor(reason: IdValidationReason, message: string) {
    super(message, { detail: message });
    this.name = 'ValidationError';
    this.reason = reason;
  }
}

/** Type guard for {@link IdValidationError}. */
export function isIdValidationError(value: unknown): value is IdValidationError {
  return value instanceof IdValidationError;
}
