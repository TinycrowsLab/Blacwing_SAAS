import { fastifyRequestContext, requestContext } from '@fastify/request-context';
import {
  defaultTextMapGetter,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import { type Logger, withContext } from '@blackwing/logger';

import { type HttpMetrics, UNMATCHED_ROUTE } from './metrics.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module '@fastify/request-context' {
  interface RequestContextData {
    /** Correlation id of the request (see `deriveTraceId`). */
    traceId: string;
    /** Tenant of the request, once authentication has resolved it (later API issues). */
    tenantId?: string;
    /** Request-scoped logger carrying `traceId` and, once bound, `tenantId`. */
    logger: Logger;
  }
}

/** Instrumentation scope of the API's spans. */
export const TRACER_NAME = '@blackwing/api';

export interface RequestObservabilityOptions {
  readonly logger: Logger;
  readonly metrics: HttpMetrics;
  readonly tracer?: Tracer;
  /** Monotonic clock in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

const propagator = new W3CTraceContextPropagator();

const MS_PER_SECOND = 1000;
/** Microsecond precision for `durationMs`. */
const DURATION_PRECISION = 1000;
const FIRST_SERVER_ERROR_STATUS = 500;
/** Status recorded for a request whose client went away before any response (nginx convention). */
const CLIENT_CLOSED_REQUEST_STATUS = 499;

interface RequestState {
  readonly startedAt: number;
  readonly span: Span;
}

/** Path without the query string: queries can carry tokens and must not reach logs or span names. */
function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

function routeOf(request: FastifyRequest): string {
  // routeOptions.url is the registered template (`/v1/runs/:id`), never the raw URL.
  const template: string | undefined = request.routeOptions.url;
  return template ?? UNMATCHED_ROUTE;
}

/** The logger of the current request, or `fallback` outside a request. */
export function requestLogger(fallback: Logger): Logger {
  return requestContext.get('logger') ?? fallback;
}

/** The trace id of the current request, if any. */
export function currentTraceId(): string | undefined {
  return requestContext.get('traceId');
}

/**
 * Hook point for tenant context (§8.6): binds `tenantId` to the current request, so its logger and its
 * access log line carry it. Authentication (later API issues) calls this once the tenant is verified;
 * nothing here derives a tenant from client input.
 */
export function bindTenant(tenantId: string): void {
  const logger = requestContext.get('logger');
  requestContext.set('tenantId', tenantId);
  if (logger !== undefined) requestContext.set('logger', withContext(logger, { tenantId }));
}

/**
 * Registers `@fastify/request-context` and the per-request instrumentation: the request context
 * (`traceId`, request logger), an OpenTelemetry server span continued from `traceparent`, the
 * `http.request` access log line and the HTTP metrics. `request.id` already holds the derived trace id
 * (the adapter's `genReqId`).
 */
export async function registerRequestObservability(
  app: FastifyInstance,
  options: RequestObservabilityOptions,
): Promise<void> {
  const { logger, metrics } = options;
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  const now = options.now ?? (() => performance.now());
  const states = new WeakMap<FastifyRequest, RequestState>();

  await app.register(fastifyRequestContext, {
    defaultStoreValues: () => ({ traceId: '', logger }),
  });

  app.addHook('onRequest', (request, reply, done) => {
    const traceId = request.id;
    requestContext.set('traceId', traceId);
    requestContext.set('logger', withContext(logger, { traceId }));
    const parent = propagator.extract(ROOT_CONTEXT, request.headers, defaultTextMapGetter);
    const span = tracer.startSpan(
      `HTTP ${request.method}`,
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.request.method': request.method, 'url.path': pathOf(request.url) },
      },
      parent,
    );
    states.set(request, { startedAt: now(), span });
    void reply.header('x-request-id', traceId);
    done();
  });

  const finish = (request: FastifyRequest, statusCode: number): void => {
    const state = states.get(request);
    if (state === undefined) return;
    states.delete(request);
    const route = routeOf(request);
    const durationMs = now() - state.startedAt;
    const labels = { method: request.method, route, status: String(statusCode) };
    metrics.requests.inc(labels);
    metrics.duration.observe(labels, durationMs / MS_PER_SECOND);

    state.span.updateName(`HTTP ${request.method} ${route}`);
    state.span.setAttributes({ 'http.route': route, 'http.response.status_code': statusCode });
    if (statusCode >= FIRST_SERVER_ERROR_STATUS)
      state.span.setStatus({ code: SpanStatusCode.ERROR });
    state.span.end();

    const tenantId = requestContext.get('tenantId');
    requestLogger(logger).info(
      {
        method: request.method,
        path: pathOf(request.url),
        route,
        statusCode,
        durationMs: Math.round(durationMs * DURATION_PRECISION) / DURATION_PRECISION,
        ...(tenantId === undefined ? {} : { tenantId }),
      },
      'http.request',
    );
  };

  app.addHook('onResponse', (request, reply, done) => {
    finish(request, reply.statusCode);
    done();
  });
  // A client that disconnects mid-request never gets a response; still close its span and count it.
  app.addHook('onRequestAbort', (request, done) => {
    finish(request, CLIENT_CLOSED_REQUEST_STATUS);
    done();
  });
}
