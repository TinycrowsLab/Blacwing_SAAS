import { isAppError } from './app-error.js';
import { composeRedactor, REDACTED, type Redactor } from './redaction.js';

import type { ErrorCode } from './codes.js';

/**
 * Server-side form of a thrown value, for the structured log written at the boundary. It keeps the
 * whole `cause` chain and the stacks (logs are internal), with every string redacted. It is never
 * sent to a client: clients only ever get a `ProblemDetails`.
 */
export interface SerializedError {
  /** `Error.name`, or `typeof` for a thrown non-Error (`"string"`, `"object"`, `"undefined"`, ...). */
  readonly name: string;
  /** Redacted message, or the redacted rendering of a thrown non-Error value. */
  readonly message: string;
  /** Registry code, for `AppError`s. */
  readonly code?: ErrorCode;
  /** Redacted client-facing detail, for `AppError`s that carry one. */
  readonly detail?: string;
  /** Redacted stack. */
  readonly stack?: string;
  /** The next link of the cause chain. */
  readonly cause?: SerializedError;
  /** Set when the chain was cut: `"cycle"` (a cause refers back up the chain) or `"depth"`. */
  readonly truncated?: 'cycle' | 'depth';
}

/** Longest cause chain kept in a log entry. */
export const MAX_CAUSE_DEPTH = 8;

/** Longest rendering of a thrown non-Error value, in characters, before redaction. */
const MAX_VALUE_LENGTH = 2048;

type Redact = (text: string) => string | undefined;

function safeRedact(redact: Redact, text: string): string {
  return redact(text) ?? REDACTED;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || typeof value !== 'object') return String(value);
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string'
      ? json.slice(0, MAX_VALUE_LENGTH)
      : Object.prototype.toString.call(value);
  } catch {
    // Circular structures, throwing getters, BigInt members: fall back to the tag.
    return Object.prototype.toString.call(value);
  }
}

function readProperty(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function serializeLink(
  value: unknown,
  redact: Redact,
  seen: Set<unknown>,
  depth: number,
): SerializedError {
  if (!(value instanceof Error)) {
    return {
      name: value === null ? 'null' : typeof value,
      message: safeRedact(redact, renderValue(value)),
    };
  }
  seen.add(value);
  const nameValue = readProperty(value, 'name');
  const messageValue = readProperty(value, 'message');
  const stackValue = readProperty(value, 'stack');
  const causeValue = readProperty(value, 'cause');
  const hasCause = Object.hasOwn(value, 'cause');

  const entry: {
    name: string;
    message: string;
    code?: ErrorCode;
    detail?: string;
    stack?: string;
    cause?: SerializedError;
    truncated?: 'cycle' | 'depth';
  } = {
    name: typeof nameValue === 'string' ? nameValue : 'Error',
    message: safeRedact(
      redact,
      typeof messageValue === 'string' ? messageValue : renderValue(messageValue),
    ),
  };
  if (isAppError(value)) {
    entry.code = value.code;
    if (value.detail !== undefined) entry.detail = safeRedact(redact, value.detail);
  }
  if (typeof stackValue === 'string') entry.stack = safeRedact(redact, stackValue);
  if (hasCause) {
    if (seen.has(causeValue)) entry.truncated = 'cycle';
    else if (depth + 1 >= MAX_CAUSE_DEPTH) entry.truncated = 'depth';
    else entry.cause = serializeLink(causeValue, redact, seen, depth + 1);
  }
  return entry;
}

/** {@link serializeErrorForLog} with an already-composed redactor (used by the mapper). */
export function serializeWithRedactor(value: unknown, redact: Redact): SerializedError {
  try {
    return serializeLink(value, redact, new Set(), 0);
  } catch {
    return { name: 'Error', message: REDACTED };
  }
}

/**
 * Serialises any thrown value, and its `cause` chain, for a server-side log. Never throws. Every
 * string passes through `redact` (the logger's registry redactor) and the built-in credential
 * patterns; a string the redactor fails on is replaced by `[REDACTED]`.
 */
export function serializeErrorForLog(value: unknown, redact?: Redactor): SerializedError {
  return serializeWithRedactor(value, composeRedactor(redact));
}
