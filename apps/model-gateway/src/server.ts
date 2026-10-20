import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';

import {
  type AnthropicErrorType,
  DEFAULT_ANTHROPIC_VERSION,
  messagesRequestSchema,
} from '@blackwing/contracts';

import { anthropicError, errorTypeForStatus } from './anthropic-error.js';
import { extractClientKey, type ClientKeyVerifier, type ClientPrincipal } from './auth.js';
import { forwardRequestHeaders, forwardResponseHeaders } from './headers.js';
import { HTTP_STATUS } from './http-status.js';
import { createGatewayMetrics, type GatewayMetrics, NO_PROVIDER_LABEL } from './metrics.js';
import { ProviderError } from './providers/errors.js';

import type { GatewayAuditSink } from './audit.js';
import type { GatewayConfig } from './config.js';
import type { ProviderAdapter, ProviderResponse } from './provider.js';
import type { Logger } from '@blackwing/logger';

export const MESSAGES_ROUTE = '/v1/messages';
const TRACER_NAME = '@blackwing/model-gateway';
const UNMATCHED_ROUTE = 'unmatched';
const INVALID_JSON_CODE = 'BW_GW_INVALID_JSON';
/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;

/** Parsed body of a JSON request: the exact bytes (forwarded upstream unchanged) and their parse. */
interface RawJsonBody {
  readonly raw: Buffer;
  readonly json: unknown;
}

export interface GatewayOptions {
  readonly config: Pick<GatewayConfig, 'GATEWAY_MAX_BODY_BYTES' | 'GATEWAY_UPSTREAM_TIMEOUT_MS'>;
  readonly adapter: ProviderAdapter;
  readonly logger: Logger;
  readonly metrics?: GatewayMetrics;
  /** Defaults to the global OTel tracer (a no-op until an SDK is registered). */
  readonly tracer?: Tracer;
  /**
   * Authenticates the sandbox's virtual key on `/v1/messages`. When set, a missing or unknown key gets an
   * Anthropic-shaped 401 and never reaches the provider. GATEWAY-002 (#405) supplies the real verifier.
   */
  readonly verifier?: ClientKeyVerifier;
  /** Receives one `gateway.request` audit event per model request, with the provider id. */
  readonly audit?: GatewayAuditSink;
}

type FinalStatus = number | 'client_closed';

const propagator = new W3CTraceContextPropagator();

/** Wraps an upstream body so a silence longer than `ms` between chunks calls `onIdle`. */
async function* withIdleTimeout(
  body: AsyncIterable<Uint8Array>,
  ms: number,
  onIdle: () => void,
): AsyncGenerator<Uint8Array> {
  let timer = setTimeout(onIdle, ms);
  try {
    for await (const chunk of body) {
      clearTimeout(timer);
      yield chunk;
      timer = setTimeout(onIdle, ms);
    }
  } finally {
    clearTimeout(timer);
  }
}

function sendError(
  reply: FastifyReply,
  status: number,
  type: AnthropicErrorType,
  message: string,
): FastifyReply {
  return reply.code(status).type('application/json').send(anthropicError(type, message));
}

/** Client-facing message for a request rejected before the handler. Never echoes request content. */
function rejectionMessage(error: FastifyError, maxBodyBytes: number): string {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return `Request body exceeds the maximum size of ${String(maxBodyBytes)} bytes.`;
    case INVALID_JSON_CODE:
      return 'Request body is not valid JSON.';
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return 'Request body must not be empty.';
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return 'Content-Type must be application/json.';
    default:
      return 'Invalid request.';
  }
}

function newTraceId(): string {
  return randomBytes(TRACE_ID_BYTES).toString('hex');
}

/**
 * Builds the model gateway HTTP server (GATEWAY-001, #HTTP_STATUS.notFound): an Anthropic-Messages-compatible streaming
 * passthrough on `POST /v1/messages`, plus `/healthz`, `/readyz` and Prometheus `/metrics`.
 * Request and response bodies are never logged.
 */
export function buildGateway(options: GatewayOptions): FastifyInstance {
  const { adapter, logger } = options;
  const maxBodyBytes = options.config.GATEWAY_MAX_BODY_BYTES;
  const timeoutMs = options.config.GATEWAY_UPSTREAM_TIMEOUT_MS;
  const metrics = options.metrics ?? createGatewayMetrics();
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  const ownedByHandler = new WeakSet<object>();
  let draining = false;

  const app = Fastify({ logger: false, bodyLimit: maxBodyBytes, return503OnClosing: true });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    try {
      done(null, { raw, json: JSON.parse(raw.toString('utf8')) as unknown } satisfies RawJsonBody);
    } catch {
      done(
        Object.assign(new Error('invalid JSON body'), {
          statusCode: HTTP_STATUS.badRequest,
          code: INVALID_JSON_CODE,
        }),
      );
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const raw = error.statusCode ?? HTTP_STATUS.internalError;
    const status =
      raw >= HTTP_STATUS.badRequest && raw < HTTP_STATUS.upperBound
        ? raw
        : HTTP_STATUS.internalError;
    const type =
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? 'request_too_large'
        : errorTypeForStatus(status);
    const message =
      status >= HTTP_STATUS.internalError
        ? 'Internal server error.'
        : rejectionMessage(error, maxBodyBytes);
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    if (status >= HTTP_STATUS.internalError) {
      logger.error({ route, status, code: error.code }, 'gw.request_failed');
    } else {
      logger.warn({ route, status, code: error.code }, 'gw.request_rejected');
    }
    return sendError(reply, status, type, message);
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, HTTP_STATUS.notFound, 'not_found_error', 'Not found.'),
  );

  app.addHook('onResponse', (request, reply, done) => {
    if (!ownedByHandler.has(request)) {
      const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
      const status = String(reply.statusCode);
      const durationMs = Math.round(reply.elapsedTime);
      const labels = { route, status, provider: NO_PROVIDER_LABEL };
      metrics.requests.inc(labels);
      metrics.duration.observe(labels, durationMs);
      logger.debug({ route, status: reply.statusCode, durationMs }, 'gw.request');
    }
    done();
  });

  app.addHook('preClose', (done) => {
    draining = true;
    done();
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', (_request, reply) =>
    !draining && adapter.ready()
      ? reply.send({ status: 'ready' })
      : reply.code(HTTP_STATUS.serviceUnavailable).send({ status: 'not_ready' }),
  );

  app.get('/metrics', async (_request, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );

  app.post<{ Body: RawJsonBody }>(MESSAGES_ROUTE, async (request, reply) => {
    ownedByHandler.add(request);
    const started = performance.now();
    const parent = propagator.extract(ROOT_CONTEXT, request.headers, defaultTextMapGetter);
    const span = tracer.startSpan(
      'gw.messages',
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.route': MESSAGES_ROUTE, 'gw.provider': adapter.name },
      },
      parent,
    );
    const spanContext = span.spanContext();
    const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : newTraceId();
    const log = logger.child({ traceId, route: MESSAGES_ROUTE, provider: adapter.name });
    let principal: ClientPrincipal | undefined;

    let finished = false;
    const finish = (status: FinalStatus, failure?: string): void => {
      if (finished) return;
      finished = true;
      const durationMs = Math.round(performance.now() - started);
      const labels = { route: MESSAGES_ROUTE, status: String(status), provider: adapter.name };
      metrics.requests.inc(labels);
      metrics.duration.observe(labels, durationMs);
      if (typeof status === 'number') span.setAttribute('http.response.status_code', status);
      if (failure !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
      span.end();
      log.info({ status, durationMs, tenantId: principal?.tenantId }, 'gw.request');
      options.audit?.record({
        type: 'gateway.request',
        provider: adapter.name,
        status,
        traceId,
        tenantId: principal?.tenantId,
        keyId: principal?.keyId,
      });
    };

    if (options.verifier !== undefined) {
      const key = extractClientKey(request.headers);
      principal = key === undefined ? undefined : await options.verifier.verify(key);
      if (principal === undefined) {
        finish(HTTP_STATUS.unauthorized, 'invalid virtual key');
        log.warn('gw.auth_failed');
        return sendError(
          reply,
          HTTP_STATUS.unauthorized,
          'authentication_error',
          'Invalid or missing virtual key.',
        );
      }
      span.setAttribute('gw.tenant_id', principal.tenantId);
    }

    const parsed = messagesRequestSchema.safeParse(request.body.json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined || issue.path.length === 0 ? 'body' : issue.path.join('.');
      finish(HTTP_STATUS.badRequest, 'invalid request');
      return sendError(
        reply,
        HTTP_STATUS.badRequest,
        'invalid_request_error',
        `${where}: ${issue?.message ?? 'invalid'}`,
      );
    }
    span.setAttribute('gw.stream', parsed.data.stream === true);

    const forwarded = forwardRequestHeaders(request.headers);
    if (forwarded.versionDefaulted) {
      log.warn({ anthropicVersion: DEFAULT_ANTHROPIC_VERSION }, 'gw.anthropic_version_defaulted');
    }
    const headers: Record<string, string> = { ...forwarded.headers };
    propagator.inject(trace.setSpan(parent, span), headers, defaultTextMapSetter);

    const controller = new AbortController();
    let abortCause: 'client' | 'timeout' | undefined;
    const abort = (cause: 'client' | 'timeout'): void => {
      if (controller.signal.aborted) return;
      abortCause = cause;
      controller.abort();
    };
    const onClientClose = (): void => {
      if (!reply.raw.writableFinished) abort('client');
    };
    reply.raw.once('close', onClientClose);

    metrics.inflight.inc();
    let inflight = true;
    const release = (): void => {
      if (!inflight) return;
      inflight = false;
      metrics.inflight.dec();
    };

    const query = request.url.indexOf('?');
    const pathAndQuery = query === -1 ? MESSAGES_ROUTE : MESSAGES_ROUTE + request.url.slice(query);
    const headersTimer = setTimeout(() => {
      abort('timeout');
    }, timeoutMs);
    let upstream: ProviderResponse;
    try {
      upstream = await adapter.send(
        { pathAndQuery, headers, body: request.body.raw, model: parsed.data.model, principal },
        principal === undefined
          ? { signal: controller.signal }
          : { signal: controller.signal, tenantId: principal.tenantId },
      );
    } catch (error) {
      release();
      reply.raw.off('close', onClientClose);
      if (abortCause === 'client') {
        finish('client_closed', 'client closed');
        reply.hijack();
        reply.raw.destroy();
        return;
      }
      if (abortCause === 'timeout') {
        finish(HTTP_STATUS.gatewayTimeout, 'upstream timeout');
        log.warn({ timeoutMs }, 'gw.upstream_timeout');
        return await sendError(
          reply,
          HTTP_STATUS.gatewayTimeout,
          'timeout_error',
          'Upstream provider did not respond in time.',
        );
      }
      if (error instanceof ProviderError) {
        finish(error.httpStatus, error.code);
        log.warn({ code: error.code }, 'gw.provider_error');
        return await sendError(reply, error.httpStatus, error.errorType, error.message);
      }
      finish(HTTP_STATUS.badGateway, 'upstream unreachable');
      log.error({ err: error instanceof Error ? error.name : 'unknown' }, 'gw.upstream_error');
      return await sendError(
        reply,
        HTTP_STATUS.badGateway,
        'api_error',
        'Upstream provider is unreachable.',
      );
    } finally {
      clearTimeout(headersTimer);
    }

    reply.code(upstream.status).headers(forwardResponseHeaders(upstream.headers));
    if (upstream.body === null) {
      release();
      finish(upstream.status);
      return reply.send();
    }

    const status = upstream.status;
    reply.raw.once('close', () => {
      release();
      if (reply.raw.writableFinished) {
        finish(status, status >= HTTP_STATUS.internalError ? 'upstream error status' : undefined);
      } else if (abortCause === 'timeout') {
        log.warn({ timeoutMs }, 'gw.upstream_idle_timeout');
        finish(HTTP_STATUS.gatewayTimeout, 'upstream idle timeout');
      } else if (abortCause === 'client') {
        finish('client_closed', 'client closed');
      } else {
        finish(HTTP_STATUS.badGateway, 'upstream stream failed');
      }
    });
    const body = Readable.from(
      withIdleTimeout(upstream.body, timeoutMs, () => {
        abort('timeout');
      }),
      { objectMode: false },
    );
    return reply.send(body);
  });

  return app;
}
