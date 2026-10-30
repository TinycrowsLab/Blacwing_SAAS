import { randomBytes } from 'node:crypto';

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginCallback,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import {
  type ErrorEnvironment,
  isAppError,
  NotFoundError,
  toProblemResponse,
} from '@blackwing/errors';
import { activeTraceFields, type Logger, redactText } from '@blackwing/logger';

import { isProtectedPath, PROTECTED_PREFIX, registerTokenAuth } from './auth.js';
import { SmBadRequestError } from './errors.js';
import { redactLogValue } from './redaction.js';

import type { SessionManagerMetrics } from './metrics.js';
import type { ReadinessMonitor } from './readiness.js';
import type { TokenVerifier } from './tokens.js';

const TRACE_ID_BYTES = 16;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface ServerOptions {
  readonly logger: Logger;
  readonly verifier: TokenVerifier;
  readonly readiness: ReadinessMonitor;
  readonly metrics: SessionManagerMetrics;
  readonly maxBodyBytes: number;
  readonly environment: ErrorEnvironment;
  /** Handlers mounted under `/internal/sessions`; every one sits behind the token hook. */
  readonly internalRoutes?: FastifyPluginCallback;
}

function traceIdOf(): string {
  return activeTraceFields()?.traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
}

/** Maps a Fastify body or parse rejection to SM_BAD_REQUEST; anything else passes through. */
function normalise(error: unknown, maxBodyBytes: number): unknown {
  if (isAppError(error)) return error;
  const fastifyError = error as Partial<FastifyError>;
  switch (fastifyError.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new SmBadRequestError(`Request body exceeds ${String(maxBodyBytes)} bytes.`);
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return new SmBadRequestError('Request body is not valid JSON.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new SmBadRequestError('Content-Type must be application/json.');
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return new SmBadRequestError('Content-Length does not match the body.');
    default:
      if (fastifyError.validation !== undefined) {
        return new SmBadRequestError('Request failed validation.');
      }
      return error;
  }
}

/** Child logger with the tenant and run fields of an internal request (never the token). */
export function requestLogger(logger: Logger, request: FastifyRequest): Logger {
  const principal = request.principal;
  return logger.child({
    component: 'api',
    ...(principal === null ? {} : { tenant_id: principal.tenantId }),
    ...(principal?.runId === undefined ? {} : { run_id: principal.runId }),
  });
}

/**
 * Builds the internal HTTP server: `/healthz`, `/readyz`, `/metrics` and the token-protected
 * `/internal/sessions/*` surface. Bodies, tokens and headers are never logged.
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const { logger, metrics, readiness, maxBodyBytes } = options;
  const app = Fastify({
    logger: false,
    bodyLimit: maxBodyBytes,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  // While draining, every response closes its connection, so a keep-alive socket that finishes its
  // in-flight request does not hold the drain open until the keep-alive timeout.
  let closing = false;
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (closing) void reply.header('connection', 'close');
    done(null, payload);
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new SmBadRequestError('Request body is not valid JSON.'), undefined);
    }
  });

  registerTokenAuth(app, options.verifier, (request, reason) => {
    metrics.authFailures.labels({ reason }).inc();
    logger.warn(
      { component: 'auth', reason, method: request.method, path: PROTECTED_PREFIX },
      'sm.auth.rejected',
    );
  });

  app.setErrorHandler((error: unknown, request, reply: FastifyReply) => {
    const mapped = normalise(error, maxBodyBytes);
    const response = toProblemResponse(mapped, traceIdOf(), {
      environment: options.environment,
      redact: redactText,
      log: (entry) => {
        if (entry.status >= HTTP_SERVER_ERROR) {
          requestLogger(logger, request).error(
            { problem: redactLogValue(entry) },
            'sm.request.failed',
          );
        }
      },
    });
    return reply
      .code(response.status)
      .headers({ ...response.headers })
      .send(response.body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const response = toProblemResponse(new NotFoundError(), traceIdOf());
    return reply
      .code(response.status)
      .headers({ ...response.headers })
      .send(response.body);
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (isProtectedPath(request.url) && request.principal !== null) {
      requestLogger(logger, request).info(
        {
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          status: reply.statusCode,
        },
        'sm.request',
      );
    }
    done();
  });

  app.get('/healthz', (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/readyz', (_request, reply) => {
    const ready = readiness.isReady();
    return reply
      .code(ready ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE)
      .header('cache-control', 'no-store')
      .send({ status: ready ? 'ready' : 'not_ready', checks: readiness.state() });
  });

  app.get('/metrics', async (_request, reply) => {
    const body = await metrics.registry.metrics();
    return reply.type(metrics.registry.contentType).send(body);
  });

  if (options.internalRoutes !== undefined) {
    void app.register(options.internalRoutes, { prefix: PROTECTED_PREFIX });
  }

  return app;
}
