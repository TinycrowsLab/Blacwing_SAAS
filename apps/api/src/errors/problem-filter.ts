import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import {
  containsStackTrace,
  createProblemDetailsMapper,
  type ErrorEnvironment,
  isAppError,
  PROBLEM_JSON_CONTENT_TYPE,
  redactBuiltinSecrets,
  serializeErrorForLog,
  UNKNOWN_TRACE_ID,
} from '@blackwing/errors';
import { type Logger, redactText } from '@blackwing/logger';

import { ApiProblemError } from './problem-errors.js';
import { problemRegistry, type ProblemRegistry, wireCodeFor } from './registry.js';
import { UNMATCHED_ROUTE, type HttpMetrics } from '../bootstrap/metrics.js';
import { currentTraceId, requestLogger } from '../bootstrap/request-context.js';
import {
  API_CONFIG,
  API_LOGGER,
  API_METRICS,
  API_PROBLEM_REGISTRY,
  API_SECURITY_EVENT_SINK,
} from '../bootstrap/tokens.js';

import type { ApiConfig } from '../config.js';
import type { Problem, ProblemFieldError } from '@blackwing/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** At most this many `errors[]` items are rendered; the rest are dropped (huge payload guard). */
export const MAX_FIELD_ERRORS = 100;
const MAX_FIELD_PATH_LENGTH = 256;
const MAX_FIELD_MESSAGE_LENGTH = 512;
const MAX_FIELD_CODE_LENGTH = 64;
const MAX_DETAIL_LENGTH = 1024;
const FIRST_SERVER_ERROR_STATUS = 500;
const FIRST_CLIENT_ERROR_STATUS = 400;
const LAST_HTTP_ERROR_STATUS = 599;
const STATUS_RATE_LIMITED = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;
/** `409 idempotency_in_progress` tells the client when to retry (API-008). */
const STATUS_CONFLICT = 409;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LAST_CLIENT_ERROR_STATUS = 499;
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A security decision surfaced by the filter (AUDIT's `emitAudit` is wired behind this sink). */
export interface SecurityErrorEvent {
  readonly code: string;
  readonly status: number;
  readonly traceId: string;
  readonly tenantId?: string;
}

/** Receives security-relevant errors (`permission_denied`, `tenant_context_missing`). Failures are swallowed. */
export type SecurityEventSink = (event: SecurityErrorEvent) => void | Promise<void>;

/** Wire codes whose occurrence is a security decision worth auditing. */
const SECURITY_CODES: ReadonlySet<string> = new Set([
  'permission_denied',
  'tenant_context_missing',
]);

/** HTTP status -> wire code for `HttpException`s and Fastify errors. */
const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  412: 'precondition_failed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  428: 'precondition_required',
  429: 'rate_limited',
  503: 'service_unavailable',
};

interface Resolved {
  readonly code: string;
  readonly detail?: string;
  readonly errors?: ProblemFieldError[];
  readonly retryAfterSeconds?: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) end -= 1;
  return `${text.slice(0, end)}…`;
}

function transportStatusOf(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  // Fastify's own errors (oversized body, malformed JSON, unsupported media type) carry `statusCode`.
  if (error instanceof Error) {
    const status: unknown = (error as { statusCode?: unknown }).statusCode;
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= FIRST_CLIENT_ERROR_STATUS &&
      status <= LAST_HTTP_ERROR_STATUS
    )
      return status;
  }
  return undefined;
}

function wireCodeForStatus(status: number): string {
  const known = HTTP_STATUS_CODES[status];
  if (known !== undefined) return known;
  if (status >= FIRST_CLIENT_ERROR_STATUS && status <= LAST_CLIENT_ERROR_STATUS)
    return 'bad_request';
  return 'internal_error';
}

/**
 * Global exception filter (API-004): renders EVERY error as RFC 9457 `application/problem+json` with a
 * stable registry `code`, the request's `traceId`, no stack and no internals (§8.7).
 *
 * Register it as `APP_FILTER` so it also catches pipe/guard/interceptor errors. Nest installs the
 * resulting handler as Fastify's error handler too, so it wins over Fastify's default serializer.
 */
@Catch()
@Injectable()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  readonly #mapper;
  readonly #registry: ProblemRegistry;
  readonly #environment: ErrorEnvironment | undefined;

  constructor(
    @Inject(API_CONFIG) config: Readonly<ApiConfig>,
    @Inject(API_LOGGER) private readonly logger: Logger,
    @Inject(API_METRICS) private readonly metrics: HttpMetrics,
    @Optional() @Inject(API_PROBLEM_REGISTRY) registry?: ProblemRegistry,
    @Optional() @Inject(API_SECURITY_EVENT_SINK) private readonly securitySink?: SecurityEventSink,
  ) {
    this.#environment = config.NODE_ENV;
    this.#registry = registry ?? problemRegistry;
    this.#mapper = createProblemDetailsMapper({
      environment: config.NODE_ENV,
      redact: redactText,
      maxDetailLength: MAX_DETAIL_LENGTH,
    });
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const traceId = this.#traceIdOf(request);

    let code = 'internal_error';
    let status = 500;
    let log = requestLogger(this.logger);
    try {
      const resolved = this.#resolve(exception, traceId);
      const { code: finalCode, entry } = this.#registry.resolve(resolved.code);
      code = finalCode;
      status = entry.status;
      const exposeDetail = status < FIRST_SERVER_ERROR_STATUS || this.#detailInDev();
      const body: Problem = {
        type: this.#registry.typeFor(entry),
        title: entry.title,
        status,
        ...(exposeDetail && resolved.detail !== undefined ? { detail: resolved.detail } : {}),
        code,
        traceId,
        ...(resolved.errors !== undefined && resolved.errors.length > 0
          ? { errors: resolved.errors }
          : {}),
      };
      log = requestLogger(this.logger);
      this.#observe(exception, code, status, traceId, log, request);
      if (this.#responseStarted(reply)) {
        // Headers already sent (SSE / streaming): cannot render a problem. End the stream cleanly.
        this.#endStream(reply);
        return;
      }
      void reply
        .status(status)
        .header('content-type', PROBLEM_JSON_CONTENT_TYPE)
        .header('cache-control', 'no-store');
      if (
        resolved.retryAfterSeconds !== undefined &&
        (status === STATUS_RATE_LIMITED ||
          status === STATUS_SERVICE_UNAVAILABLE ||
          status === STATUS_CONFLICT)
      ) {
        void reply.header('retry-after', String(resolved.retryAfterSeconds));
      }
      void reply.send(JSON.stringify(body));
    } catch (renderError) {
      this.#fallback(reply, traceId, renderError, log);
    }
  }

  #detailInDev(): boolean {
    return this.#environment === 'development' || this.#environment === 'test';
  }

  #traceIdOf(request: FastifyRequest): string {
    const candidates: unknown[] = [currentTraceId(), request.id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && TRACE_ID.test(candidate)) return candidate;
    }
    return UNKNOWN_TRACE_ID;
  }

  #resolve(exception: unknown, traceId: string): Resolved {
    if (isAppError(exception)) {
      const details = this.#mapper.toProblemResponse(exception, traceId);
      const retry = details.headers['retry-after'];
      const errors = this.#fieldErrors(exception);
      return {
        code: wireCodeFor(exception.code),
        ...(details.body.detail === undefined ? {} : { detail: details.body.detail }),
        ...(errors === undefined ? {} : { errors }),
        ...(retry === undefined ? {} : { retryAfterSeconds: Number(retry) }),
      };
    }
    if (exception instanceof ApiProblemError) {
      // An unregistered code renders as internal_error, which never carries a caller-written detail.
      if (!this.#registry.has(exception.problemCode)) return { code: 'internal_error' };
      const detail = this.#safeText(exception.detail, MAX_DETAIL_LENGTH);
      return {
        code: exception.problemCode,
        ...(detail === undefined ? {} : { detail }),
        ...(exception.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: exception.retryAfterSeconds }),
      };
    }
    const status = transportStatusOf(exception);
    // Transport errors never expose their message: it is framework text, not written for the caller.
    if (status !== undefined) return { code: wireCodeForStatus(status) };
    return { code: 'internal_error' };
  }

  /** Redacts, drops stack-like text and truncates; `undefined` when nothing safe remains. */
  #safeText(text: string | undefined, max: number): string | undefined {
    if (text === undefined) return undefined;
    try {
      const redacted = redactBuiltinSecrets(redactText(text));
      if (redacted.trim() === '' || containsStackTrace(redacted)) return undefined;
      return truncate(redacted, max);
    } catch {
      return undefined;
    }
  }

  #fieldErrors(error: unknown): ProblemFieldError[] | undefined {
    const raw: unknown = (error as { errors?: unknown }).errors;
    if (!Array.isArray(raw)) return undefined;
    const out: ProblemFieldError[] = [];
    for (const item of raw.slice(0, MAX_FIELD_ERRORS) as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { path, message, code } = item as Record<string, unknown>;
      if (typeof path !== 'string' || typeof message !== 'string' || typeof code !== 'string')
        continue;
      const safeMessage = this.#safeText(message, MAX_FIELD_MESSAGE_LENGTH);
      if (safeMessage === undefined) continue;
      out.push({
        path: truncate(this.#safeText(path, MAX_FIELD_PATH_LENGTH) ?? '', MAX_FIELD_PATH_LENGTH),
        message: safeMessage,
        code: truncate(code, MAX_FIELD_CODE_LENGTH),
      });
    }
    return out;
  }

  #observe(
    exception: unknown,
    code: string,
    status: number,
    traceId: string,
    log: Logger,
    request: FastifyRequest,
  ): void {
    try {
      this.metrics.errors.inc({ code, status: String(status) });
      if (code === 'precondition_failed') {
        this.metrics.optimisticConflicts.inc({
          route: request.routeOptions.url ?? UNMATCHED_ROUTE,
        });
      }
    } catch {
      // Metrics must never turn an error response into a crash.
    }
    try {
      const fields = {
        code,
        status,
        traceId,
        method: request.method,
        err: serializeErrorForLog(exception, redactText),
      };
      if (status >= FIRST_SERVER_ERROR_STATUS) log.error(fields, 'http.error');
      else log.warn(fields, 'http.error');
    } catch {
      // Logging must never turn an error response into a crash.
    }
    if (SECURITY_CODES.has(code) && this.securitySink !== undefined) {
      try {
        const tenantId = (request as { tenantId?: unknown }).tenantId;
        const result = this.securitySink({
          code,
          status,
          traceId,
          ...(typeof tenantId === 'string' ? { tenantId } : {}),
        });
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Auditing a refusal must not change the refusal.
      }
    }
  }

  #responseStarted(reply: FastifyReply): boolean {
    return reply.sent || reply.raw.headersSent || reply.raw.writableEnded;
  }

  #endStream(reply: FastifyReply): void {
    try {
      if (!reply.raw.writableEnded) reply.raw.end();
    } catch {
      // The socket is already gone.
    }
  }

  /** Last resort when rendering itself failed: a fixed, minimal `internal_error` body. */
  #fallback(reply: FastifyReply, traceId: string, cause: unknown, log: Logger): void {
    try {
      log.error(
        { traceId, err: serializeErrorForLog(cause, redactText) },
        'http.error.render_failed',
      );
    } catch {
      // nothing left to do
    }
    try {
      if (this.#responseStarted(reply)) {
        this.#endStream(reply);
        return;
      }
      const { entry } = this.#registry.resolve('internal_error');
      const body: Problem = {
        type: this.#registry.typeFor(entry),
        title: entry.title,
        status: entry.status,
        code: 'internal_error',
        traceId,
      };
      void reply
        .status(entry.status)
        .header('content-type', PROBLEM_JSON_CONTENT_TYPE)
        .send(JSON.stringify(body));
    } catch {
      this.#endStream(reply);
    }
  }
}
