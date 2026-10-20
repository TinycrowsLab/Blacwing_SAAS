import { type AppError, isAppError } from "./app-error.js";
import { ERROR_CODES, type ErrorCode, problemTypeFor } from "./codes.js";
import { composeRedactor, containsStackTrace, type Redactor } from "./redaction.js";
import { type SerializedError, serializeWithRedactor } from "./serialize.js";

/** Media type of every error response (RFC 9457 §3). */
export const PROBLEM_JSON_CONTENT_TYPE = "application/problem+json";

/** Deployment environments, as in `@blackwing/config` `NODE_ENV`. */
export type ErrorEnvironment = "development" | "test" | "staging" | "production";

/**
 * The problem+json body every API error returns (RFC 9457; CONTEXT_PACK §9). It never contains a
 * stack, a `cause`, an unredacted secret or an internal message.
 */
export interface ProblemDetails {
  /** `https://errors.blackwing.dev/<code>`. */
  readonly type: string;
  /** Registry title for `code` (English, v1). Same for every occurrence of the code. */
  readonly title: string;
  /** HTTP status, equal to the response status. */
  readonly status: number;
  /** Redacted, occurrence-specific explanation. Absent when there is nothing safe to say. */
  readonly detail?: string;
  /** Stable machine key. Clients branch on this, never on `title` or `detail`. */
  readonly code: ErrorCode;
  /** Trace id of the failed request, for support and log correlation. */
  readonly traceId: string;
}

/** What the boundary logs, exactly once per mapped error. */
export interface ErrorLogEntry {
  /** `error` for 5xx (a server fault), `warn` for 4xx (a client or policy outcome). */
  readonly level: "error" | "warn";
  readonly code: ErrorCode;
  readonly status: number;
  readonly traceId: string;
  readonly retryable: boolean;
  /** Full redacted error with its cause chain and stacks. Server-side only. */
  readonly err: SerializedError;
}

/** Receives the boundary log entry; wire it to `@blackwing/logger` (FOUND-008). */
export type ErrorLogSink = (entry: ErrorLogEntry) => void;

/** How the mapper behaves. Every default is the safe (production) choice. */
export interface ProblemDetailsOptions {
  /**
   * `development` and `test` also show `detail` for 5xx `AppError`s. Anything else, including an
   * absent value, behaves as production. Pass `config.NODE_ENV`; this package never reads the env.
   */
  readonly environment?: ErrorEnvironment;
  /**
   * Value redactor from the logger's secret registry. The built-in credential patterns always run too.
   * Outside development/test it is required for any `detail` to be shown: without it every `detail`
   * is dropped (fail closed).
   */
  readonly redact?: Redactor;
  /** Boundary log sink, called once per mapped error. Its failures are swallowed. */
  readonly log?: ErrorLogSink;
  /** Longest `detail`, in characters, after redaction. Default {@link DEFAULT_MAX_DETAIL_LENGTH}. */
  readonly maxDetailLength?: number;
}

/** Default cap on `detail` length. */
export const DEFAULT_MAX_DETAIL_LENGTH = 1024;

/** Used when the caller has no usable trace id, so the field is always present. */
export const UNKNOWN_TRACE_ID = "unknown";

/** Trace ids are W3C hex ids in practice; anything outside this charset/length is not echoed. */
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Headers the boundary sets on an error response. */
export interface ProblemResponseHeaders {
  readonly "content-type": typeof PROBLEM_JSON_CONTENT_TYPE;
  /** Errors are per-request outcomes and may mention the caller's resources: never cache them. */
  readonly "cache-control": "no-store";
  /** Whole seconds, for `RATE_LIMITED` when the limiter knows the wait (§9). */
  readonly "retry-after"?: string;
}

/** Everything an HTTP boundary needs to answer with problem+json. */
export interface ProblemResponse {
  readonly status: number;
  readonly headers: ProblemResponseHeaders;
  readonly body: ProblemDetails;
}

/** The bound mapper returned by {@link createProblemDetailsMapper}. */
export interface ProblemDetailsMapper {
  toProblemDetails(err: unknown, traceId: string): ProblemDetails;
  toProblemResponse(err: unknown, traceId: string): ProblemResponse;
}

function exposesServerDetail(environment: ErrorEnvironment | undefined): boolean {
  return environment === "development" || environment === "test";
}

/**
 * Whether an `AppError`'s `detail` may reach the client at all (it is still redacted afterwards).
 *
 * - development/test: always (the built-in credential pass still runs).
 * - anywhere else (production, staging, or no environment): never for 5xx, and for 4xx only when the
 *   registry redactor was injected. Without it this package cannot know the registered secret values,
 *   so it fails closed (§8.7) instead of trusting the built-in patterns alone.
 */
function mayExposeDetail(status: number, options: ProblemDetailsOptions): boolean {
  if (exposesServerDetail(options.environment)) return true;
  return status < 500 && options.redact !== undefined;
}

function normaliseTraceId(traceId: unknown): string {
  return typeof traceId === "string" && TRACE_ID.test(traceId) ? traceId : UNKNOWN_TRACE_ID;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never split a surrogate pair: a lone surrogate is not valid UTF-8 on the wire.
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function detailLimit(max: number | undefined): number {
  return max !== undefined && Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_DETAIL_LENGTH;
}

/** `Retry-After` seconds of a `RATE_LIMITED` error (works across package copies), if valid. */
function retryAfterOf(error: AppError): number | undefined {
  if (error.code !== "RATE_LIMITED") return undefined;
  const value: unknown = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

interface Mapped {
  readonly body: ProblemDetails;
  readonly retryAfterSeconds?: number;
}

/** Generic body used when mapping itself fails: no input is trusted. */
function fallbackBody(traceId: string): ProblemDetails {
  const spec = ERROR_CODES.INTERNAL;
  return { type: problemTypeFor("INTERNAL"), title: spec.title, status: spec.status, code: "INTERNAL", traceId };
}

function mapError(err: unknown, rawTraceId: unknown, options: ProblemDetailsOptions): Mapped {
  const traceId = normaliseTraceId(rawTraceId);
  const redact = composeRedactor(options.redact);
  let mapped: Mapped;
  let retryable = false;
  try {
    const appError = isAppError(err) ? err : undefined;
    // Status and title always come from the registry by code, never from the thrown object, so a
    // forged or inconsistent `httpStatus` cannot change what the client sees.
    const code: ErrorCode = appError?.code ?? "INTERNAL";
    const spec = ERROR_CODES[code];
    retryable = appError?.retryable ?? false;

    let detail: string | undefined;
    // A non-AppError is never described to the client: its message is internal by definition.
    const rawDetail = appError?.detail;
    if (typeof rawDetail === "string" && mayExposeDetail(spec.status, options)) {
      const redacted = redact(rawDetail);
      if (redacted !== undefined && redacted.trim() !== "" && !containsStackTrace(redacted)) {
        detail = truncate(redacted, detailLimit(options.maxDetailLength));
      }
    }

    const body: ProblemDetails = {
      type: problemTypeFor(code),
      title: spec.title,
      status: spec.status,
      ...(detail === undefined ? {} : { detail }),
      code,
      traceId,
    };
    const seconds = appError === undefined ? undefined : retryAfterOf(appError);
    mapped = seconds === undefined ? { body } : { body, retryAfterSeconds: seconds };
  } catch {
    mapped = { body: fallbackBody(traceId) };
  }

  if (options.log !== undefined) {
    try {
      options.log({
        level: mapped.body.status >= 500 ? "error" : "warn",
        code: mapped.body.code,
        status: mapped.body.status,
        traceId,
        retryable,
        err: serializeWithRedactor(err, redact),
      });
    } catch {
      // Logging must never turn an error response into a crash at the boundary.
    }
  }
  return mapped;
}

/**
 * Maps anything thrown to an RFC 9457 problem+json body. Never throws.
 *
 * - `AppError`: `code`, `status` and `title` from the registry; `detail` from the error, redacted,
 *   dropped if it contains a stack trace, and withheld for 5xx outside development/test. Outside
 *   development/test a 4xx `detail` is shown only when `options.redact` (the registry redactor) is set.
 * - Anything else (a plain `Error`, a string, `undefined`, ...): `INTERNAL` (500) with the generic
 *   title and no detail. The real cause reaches only the log sink, redacted.
 * - The `cause` chain and every stack stay server-side.
 */
export function toProblemDetails(err: unknown, traceId: string, options: ProblemDetailsOptions = {}): ProblemDetails {
  return mapError(err, traceId, options).body;
}

/** {@link toProblemDetails} plus the status and headers (`application/problem+json`, `Retry-After`). */
export function toProblemResponse(err: unknown, traceId: string, options: ProblemDetailsOptions = {}): ProblemResponse {
  const { body, retryAfterSeconds } = mapError(err, traceId, options);
  const headers: ProblemResponseHeaders =
    retryAfterSeconds === undefined
      ? { "content-type": PROBLEM_JSON_CONTENT_TYPE, "cache-control": "no-store" }
      : { "content-type": PROBLEM_JSON_CONTENT_TYPE, "cache-control": "no-store", "retry-after": String(retryAfterSeconds) };
  return { status: body.status, headers, body };
}

/**
 * Binds the options once at bootstrap: the API exception filter (API epic) builds one mapper from
 * config (`environment`), the logger's redactor and its log sink, then calls it per error.
 */
export function createProblemDetailsMapper(options: ProblemDetailsOptions = {}): ProblemDetailsMapper {
  const bound = Object.freeze({ ...options });
  return Object.freeze({
    toProblemDetails: (err: unknown, traceId: string) => toProblemDetails(err, traceId, bound),
    toProblemResponse: (err: unknown, traceId: string) => toProblemResponse(err, traceId, bound),
  });
}
