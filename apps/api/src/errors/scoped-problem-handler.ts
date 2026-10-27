import { randomBytes } from 'node:crypto';

import { trace } from '@opentelemetry/api';

import { isAppError, type ProblemDetailsMapper, ValidationError } from '@blackwing/errors';

import type { FastifyInstance } from 'fastify';

/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;

/** The active span's trace id, or a fresh random one when there is no span. */
export function traceIdOfActiveSpan(): string {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx?.traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
}

/**
 * Turns Fastify's own body-parse errors into a `ValidationError` with a fixed message. The parser's
 * message can quote the offending bytes, so it must never reach the client (a secret value could be in it).
 */
export function translateTransportError(error: unknown): unknown {
  const code = (error as { code?: unknown }).code;
  return code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ? new ValidationError('request body is not valid JSON', {
        detail: 'request body is not valid JSON',
      })
    : error;
}

/**
 * Installs the RFC 9457 error handler of a feature route scope (`kill`, `secrets`): every error becomes
 * `application/problem+json`, with `translate` (default {@link translateTransportError}) applied to
 * errors that are not `AppError`s first.
 */
export function installProblemHandler(
  scope: FastifyInstance,
  problems: ProblemDetailsMapper,
  translate: (error: unknown) => unknown = translateTransportError,
): void {
  scope.setErrorHandler((error: unknown, _request, reply) => {
    const response = problems.toProblemResponse(
      isAppError(error) ? error : translate(error),
      traceIdOfActiveSpan(),
    );
    void reply
      .status(response.status)
      .headers({ ...response.headers })
      .send(response.body);
  });
}
