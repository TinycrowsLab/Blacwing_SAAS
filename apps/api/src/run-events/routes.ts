import { trace, type Span } from '@opentelemetry/api';
import { z } from 'zod';

import {
  type RunState,
  TERMINAL_RUN_STATES,
  uuidV7Schema,
  type RunEvent,
} from '@blackwing/contracts';
import { hashTenantId } from '@blackwing/db/tenant-context';
import { hasPermission } from '@blackwing/domain';
import {
  createProblemDetailsMapper,
  type ErrorEnvironment,
  ForbiddenError,
  type ProblemDetailsMapper,
  RateLimitedError,
  serializeErrorForLog,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import { TenantStreamLimiter } from './limits.js';
import { formatControlFrame, formatEventFrame, resumeCursor, SseStream } from './sse.js';
import { TRACER_NAME } from '../bootstrap/request-context.js';
import { problemErrorHandler } from '../kill/routes.js';

import type { RunEventsMetrics } from './metrics.js';
import type { RunEventsBusFactory, RunEventsPrincipal, RunEventsRunReader } from './ports.js';
import type { EventBus } from '@blackwing/events';
import type { Logger } from '@blackwing/logger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

/** `GET /v1/runs/{runId}/events`: the live event stream of one run (#65). */
export const RUN_EVENTS_ROUTE = '/v1/runs/:runId/events';

/** Largest resume cursor a client may send; a stream id is at most 41 characters. */
const MAX_CURSOR_LENGTH = 64;

const paramsSchema = z.object({ runId: uuidV7Schema });
const querySchema = z.object({ lastEventId: z.string().max(MAX_CURSOR_LENGTH).optional() });

/** Terminal run states (§3.3): a stream that reaches one ends. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATES);

/** Tuning of one stream; every value comes from `@blackwing/config` (API_SSE_*). */
export interface RunEventsStreamLimits {
  readonly heartbeatMs: number;
  readonly maxDurationMs: number;
  /** A resume replays at most this many events; more answers `resync` instead. */
  readonly maxReplay: number;
  /** Open streams per tenant on this instance. */
  readonly maxConnectionsPerTenant: number;
}

export interface RunEventsRoutesOptions {
  /** Authenticates the request (session via the BFF, or a `bw_pat_`/`bw_ci_` bearer). Must throw for a bad credential. */
  readonly authenticate: (request: FastifyRequest) => Promise<RunEventsPrincipal>;
  readonly runs: RunEventsRunReader;
  readonly buses: RunEventsBusFactory;
  readonly limits: RunEventsStreamLimits;
  readonly metrics: RunEventsMetrics;
  readonly logger: Logger;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

function isTerminalState(value: unknown): value is RunState {
  return typeof value === 'string' && TERMINAL_STATES.has(value);
}

/** A run event that carries a terminal run state (for example the kill's `killed`) ends the stream. */
function terminalStateOf(event: RunEvent): RunState | undefined {
  const state = event.payload.state;
  return isTerminalState(state) ? state : undefined;
}

/** The inherited response headers (CORS, Helmet) carried onto the hijacked stream. */
function inheritedHeaders(reply: FastifyReply): OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(reply.getHeaders()).filter(([, value]) => value !== undefined),
  );
}

function notPermitted(): ForbiddenError {
  // The same answer for a run in another tenant and a run that does not exist: no existence oracle (§8.6).
  return new ForbiddenError("you are not permitted to read this run's events");
}

/**
 * Registers `GET /v1/runs/:runId/events` (#65) on a Fastify instance. Everything that can be refused is
 * refused before the stream opens, as RFC 9457 problem+json: 401 (no credential), 403 (no `run:read`, or
 * a run not in the caller's tenant), 422 (bad id or cursor), 429 (tenant at its stream cap). After that,
 * failures travel as `event: error` frames, because the status line is already sent.
 */
export function registerRunEventRoutes(
  app: FastifyInstance,
  options: RunEventsRoutesOptions,
): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );
  const limiter = new TenantStreamLimiter(options.limits.maxConnectionsPerTenant);
  const tracer = trace.getTracer(TRACER_NAME);

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler(problemErrorHandler(problems));

    scope.get(RUN_EVENTS_ROUTE, async (request, reply) => {
      const principal = await options.authenticate(request);
      const tenantId = principal.tenantId;
      if (tenantId === null || tenantId === '') {
        throw new TenantContextMissingError('a tenant context is required to read run events');
      }
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) throw new ValidationError('runId must be a lowercase UUIDv7');
      const query = querySchema.safeParse(request.query);
      if (!query.success) throw new ValidationError('lastEventId must be a single stream id');
      const runId = params.data.runId;

      if (!hasPermission(principal.roles, 'run:read')) throw notPermitted();
      const run = await options.runs.getRun(tenantId, runId);
      if (run?.tenantId !== tenantId) throw notPermitted();

      const resume = resumeCursor(request.headers['last-event-id'], query.data.lastEventId);
      const release = limiter.tryAcquire(tenantId);
      if (release === undefined) {
        throw new RateLimitedError('too many open run event streams for this tenant');
      }

      // Hijacked: from here the response is ours. Every failure becomes a frame, never a status code.
      reply.hijack();
      const hash = hashTenantId(tenantId);
      const span = tracer.startSpan('api.run_events.stream', {
        attributes: {
          'bw.tenant_hash': hash,
          'bw.run_id': runId,
          'bw.resumed': resume !== undefined,
        },
      });
      const stream = new SseStream(reply.raw, inheritedHeaders(reply), {
        heartbeatMs: options.limits.heartbeatMs,
        maxDurationMs: options.limits.maxDurationMs,
        onClose: () => {
          release();
          options.metrics.connectionClosed(hash);
          span.end();
        },
      });
      options.metrics.connectionOpened(hash);
      void streamRun({
        stream,
        span,
        hash,
        runId,
        run,
        resume,
        bus: options.buses(tenantId),
        limits: options.limits,
        metrics: options.metrics,
        logger: options.logger,
      });
      return reply;
    });

    done();
  });
}

interface StreamRunInput {
  readonly stream: SseStream;
  readonly span: Span;
  readonly hash: string;
  readonly runId: string;
  readonly run: { readonly state: RunState };
  readonly resume: string | undefined;
  readonly bus: EventBus;
  readonly limits: RunEventsStreamLimits;
  readonly metrics: RunEventsMetrics;
  readonly logger: Logger;
}

/**
 * Drives one open stream to its end: the terminal state of a finished run, a bounded replay on resume,
 * then the live subscription. It never throws: the status line is already out, so errors become frames.
 */
async function streamRun(input: StreamRunInput): Promise<void> {
  const { stream, bus, runId, hash, metrics, logger } = input;
  const resync = (reason: string): void => {
    metrics.resync(reason);
    stream.end(formatControlFrame('resync', { reason }));
  };
  try {
    logger.info(
      { tenant: hash, runId, resumed: input.resume !== undefined },
      'run event stream opened',
    );
    if (isTerminalState(input.run.state)) {
      // A finished run has no live events. The client gets the final state and the stream closes.
      await stream.send(formatControlFrame('state', { state: input.run.state }));
      stream.end(formatControlFrame('end', { state: input.run.state }));
      return;
    }
    if (input.resume !== undefined) {
      // One event past the cap tells us the replay is too long without reading all of it.
      const pending = await bus.countAfter(runId, input.resume, input.limits.maxReplay + 1);
      if (pending > input.limits.maxReplay) {
        resync('replay_limit');
        return;
      }
    }
    const subscription = bus.subscribe(runId, {
      fromId: input.resume ?? '$',
      signal: stream.signal,
      onError: (error) => {
        logger.warn(
          { tenant: hash, runId, err: serializeErrorForLog(error) },
          'run event stream lost its source; closing',
        );
        stream.end(formatControlFrame('error', { reason: 'stream_unavailable' }));
      },
    });
    for await (const item of subscription) {
      if (item.kind === 'event') {
        if (!(await stream.send(formatEventFrame(item.id, item.event.type, item.event)))) break;
        metrics.eventSent();
        const state = terminalStateOf(item.event);
        if (state !== undefined) {
          stream.end(formatControlFrame('end', { state }));
          break;
        }
      } else if (item.kind === 'gap') {
        metrics.dropped(item.dropped);
        resync('slow_consumer');
        break;
      } else {
        resync(item.reason);
        break;
      }
    }
  } catch (error) {
    logger.error(
      { tenant: hash, runId, err: serializeErrorForLog(error) },
      'run event stream failed',
    );
    stream.end(formatControlFrame('error', { reason: 'stream_failed' }));
  } finally {
    stream.close();
  }
}
