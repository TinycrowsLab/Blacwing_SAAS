import { randomBytes } from 'node:crypto';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  BROKER_BASE_PATH,
  type BrokerPdpDecision,
  type BrokerPrincipal,
  type BrokerScope,
  brokerCandidateRequestSchema,
  brokerEvidenceRequestSchema,
  brokerJournalRequestSchema,
  brokerPdpDecisionSchema,
  brokerPdpEvaluateRequestSchema,
  brokerToolAuditRequestSchema,
  engagementDispatchInputSchema,
  engagementMarkTestCaseInputSchema,
  engagementMentorReviewInputSchema,
  engagementScopeExceptionInputSchema,
  TERMINAL_RUN_STATES,
  uuidV7Schema,
} from '@blackwing/contracts';
import { createCrossTenantGuard, runWithTenantContext } from '@blackwing/db/tenant-context';
import {
  AppError,
  type ErrorEnvironment,
  ForbiddenError,
  isAppError,
  NotFoundError,
  type ProblemDetailsMapper,
  createProblemDetailsMapper,
  RateLimitedError,
  ValidationError,
} from '@blackwing/errors';
import { type Logger, withContext } from '@blackwing/logger';

import { type BrokerMetrics, createBrokerMetrics } from './metrics.js';
import { BrokerAuthError, type BrokerTokenVerifier, type RunTokenRevocations } from './token.js';
import { createTenantContextMetrics } from '../tenant/metrics.js';

import type { EngagementPort, EngagementRef } from './engagement.js';
import type { SourceGuard } from './network.js';
import type { PdpService } from './pdp.js';
import type { BrokerAuditSink, BrokerRunReader } from './ports.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Tracer name of the broker; one span per broker call. */
const BROKER_TRACER = 'blackwing.api.broker';

export const BROKER_CANDIDATES_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/candidates`;
export const BROKER_EVIDENCE_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/evidence`;
export const BROKER_JOURNAL_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/journal`;
export const BROKER_TOOL_AUDIT_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/tool-audit`;
export const BROKER_STATE_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/state`;
/** The PreToolUse decision of the agent runtime (RUNTIME-005, #467). */
export const BROKER_PDP_EVALUATE_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/pdp/evaluate`;

/** Engagement endpoints the orchestrator's MCP tools call (MCP-012, #677). */
export const BROKER_ENGAGEMENT_STATE_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/state`;
export const BROKER_ENGAGEMENT_OPEN_SUBTASKS_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/subtasks/open`;
export const BROKER_ENGAGEMENT_DISPATCH_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/dispatch`;
export const BROKER_ENGAGEMENT_SUBTASK_RESULT_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/subtasks/:subtaskId/result`;
export const BROKER_ENGAGEMENT_TEST_CASE_STATUS_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/test-cases/status`;
export const BROKER_ENGAGEMENT_MENTOR_REVIEW_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/mentor-reviews`;
export const BROKER_ENGAGEMENT_SCOPE_EXCEPTION_ROUTE = `${BROKER_BASE_PATH}/runs/:runId/engagement/scope-exceptions`;

/** Window of the per-run-session limiter. */
export interface BrokerRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface BrokerRoutesOptions {
  readonly verifier: BrokerTokenVerifier;
  readonly revocations: RunTokenRevocations;
  readonly sourceGuard: SourceGuard;
  readonly runs: BrokerRunReader;
  readonly audit: BrokerAuditSink;
  readonly logger: Logger;
  readonly metrics?: BrokerMetrics;
  readonly rateLimit?: BrokerRateLimit;
  /** The engagement endpoints' adapters. Unwired, they answer `NOT_IMPLEMENTED`. */
  readonly engagement?: EngagementPort;
  /** The PreToolUse decision service. Unwired, the PDP endpoint answers `NOT_IMPLEMENTED` and the hook denies. */
  readonly pdp?: PdpService;
  readonly now?: () => number;
  readonly environment?: ErrorEnvironment;
  readonly problems?: ProblemDetailsMapper;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the broker's `onRequest` hook once source and token passed; `null` everywhere else. */
    brokerPrincipal: BrokerPrincipal | null;
  }
}

const TRACE_ID_BYTES = 16;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const MAX_TRACKED_SESSIONS = 10_000;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;
const DEFAULT_RATE_LIMIT: BrokerRateLimit = { limit: 600, windowMs: 60_000 };

const GENERIC_FORBIDDEN = 'This request is not permitted for the presented run token.';

/** What an answered endpoint receives: the run from the token, the bound path params, the parsed body. */
interface EndpointCall {
  readonly ref: EngagementRef;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

interface Endpoint {
  readonly route: string;
  readonly action: string;
  readonly scope: BrokerScope;
  readonly owner: string;
  /** `null` for a read. */
  readonly body: z.ZodType | null;
  /** Answers the call when the endpoint is wired; without it the endpoint answers `NOT_IMPLEMENTED`. */
  readonly handle?: (call: EndpointCall) => Promise<unknown>;
}

const ENDPOINTS: readonly Endpoint[] = [
  {
    route: BROKER_CANDIDATES_ROUTE,
    action: 'broker.candidate.submit',
    scope: 'candidates:write',
    owner: 'FINDING/VALIDATE',
    body: brokerCandidateRequestSchema,
  },
  {
    route: BROKER_EVIDENCE_ROUTE,
    action: 'broker.evidence.record',
    scope: 'evidence:write',
    owner: 'EVIDENCE',
    body: brokerEvidenceRequestSchema,
  },
  {
    route: BROKER_JOURNAL_ROUTE,
    action: 'broker.journal.append',
    scope: 'journal:write',
    owner: 'REVERSAL',
    body: brokerJournalRequestSchema,
  },
  {
    route: BROKER_TOOL_AUDIT_ROUTE,
    action: 'broker.tool_audit.record',
    scope: 'audit:write',
    owner: 'AUDIT',
    body: brokerToolAuditRequestSchema,
  },
  {
    route: BROKER_STATE_ROUTE,
    action: 'broker.state.read',
    scope: 'state:read',
    owner: 'ORCH/WORKFLOW',
    body: null,
  },
];

/** The PDP endpoint, wired only with a `PdpService` (RUNTIME-005). */
function pdpEndpoint(service: PdpService | undefined): Endpoint {
  const base: Endpoint = {
    route: BROKER_PDP_EVALUATE_ROUTE,
    action: 'broker.pdp.evaluate',
    scope: 'pdp:evaluate',
    owner: 'PDP',
    body: brokerPdpEvaluateRequestSchema,
  };
  if (service === undefined) return base;
  return {
    ...base,
    handle: async ({ ref, body }) =>
      service.evaluate(ref, brokerPdpEvaluateRequestSchema.parse(body)),
  };
}

const terminalStates: ReadonlySet<string> = new Set(TERMINAL_RUN_STATES);

type EngagementHandle = (call: EndpointCall, port: EngagementPort) => Promise<unknown>;

/**
 * The engagement endpoints (MCP-012). Reads need `engagement:read`, writes `engagement:write`. A write is
 * refused once the run is terminal (`RUN_NOT_ACTIVE`) by the same rule as every other write. Without a port
 * each one keeps answering `NOT_IMPLEMENTED`.
 */
function engagementEndpoints(port: EngagementPort | undefined): readonly Endpoint[] {
  const wired = (base: Omit<Endpoint, 'handle'>, handle: EngagementHandle): Endpoint =>
    port === undefined ? base : { ...base, handle: (call) => handle(call, port) };
  const subtaskIdOf = (params: EndpointCall['params']): string => {
    const parsed = uuidV7Schema.safeParse(params.subtaskId);
    if (!parsed.success) {
      throw new ValidationError('request is malformed', { detail: 'The subtask id is not valid.' });
    }
    return parsed.data;
  };
  return [
    wired(
      {
        route: BROKER_ENGAGEMENT_STATE_ROUTE,
        action: 'broker.engagement.state_read',
        scope: 'engagement:read',
        owner: 'ORCH/WORKFLOW',
        body: null,
      },
      ({ ref }, p) => p.state(ref),
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_OPEN_SUBTASKS_ROUTE,
        action: 'broker.engagement.open_subtasks_read',
        scope: 'engagement:read',
        owner: 'ORCH',
        body: null,
      },
      ({ ref }, p) => p.openSubtasks(ref),
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_DISPATCH_ROUTE,
        action: 'broker.engagement.dispatch',
        scope: 'engagement:write',
        owner: 'ORCH/WORKFLOW',
        body: engagementDispatchInputSchema,
      },
      ({ ref, body }, p) => p.dispatch(ref, engagementDispatchInputSchema.parse(body)),
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_SUBTASK_RESULT_ROUTE,
        action: 'broker.engagement.subtask_result_read',
        scope: 'engagement:read',
        owner: 'ORCH',
        body: null,
      },
      async ({ ref, params }, p) => {
        const found = await p.subtaskResult(ref, subtaskIdOf(params));
        if (found === null) throw new NotFoundError('subtask not found');
        return found;
      },
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_TEST_CASE_STATUS_ROUTE,
        action: 'broker.engagement.test_case_status',
        scope: 'engagement:write',
        owner: 'ORCH',
        body: engagementMarkTestCaseInputSchema,
      },
      ({ ref, body }, p) => p.markTestCase(ref, engagementMarkTestCaseInputSchema.parse(body)),
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_MENTOR_REVIEW_ROUTE,
        action: 'broker.engagement.mentor_review',
        scope: 'engagement:write',
        owner: 'MENTOR',
        body: engagementMentorReviewInputSchema,
      },
      ({ ref, body }, p) =>
        p.requestMentorReview(ref, engagementMentorReviewInputSchema.parse(body)),
    ),
    wired(
      {
        route: BROKER_ENGAGEMENT_SCOPE_EXCEPTION_ROUTE,
        action: 'broker.engagement.scope_exception',
        scope: 'engagement:write',
        owner: 'GATE2',
        body: engagementScopeExceptionInputSchema,
      },
      ({ ref, body }, p) =>
        p.requestScopeException(ref, engagementScopeExceptionInputSchema.parse(body)),
    ),
  ];
}

function traceIdOf(): string {
  return (
    trace.getActiveSpan()?.spanContext().traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex')
  );
}

/** The `runId` / `tenantId` a body states about itself; they must equal the token's, never widen it. */
function bodyIds(body: unknown): { runId?: unknown; tenantId?: unknown } {
  return typeof body === 'object' && body !== null ? body : {};
}

/** Fixed-window limiter keyed by run session (never by user token). */
function createRateLimiter(config: BrokerRateLimit, now: () => number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): number | null => {
    const at = now();
    const current = windows.get(key);
    if (current === undefined || at - current.start >= config.windowMs) {
      windows.set(key, { start: at, count: 1 });
      if (windows.size > MAX_TRACKED_SESSIONS) {
        for (const [k, w] of windows) if (at - w.start >= config.windowMs) windows.delete(k);
      }
      return null;
    }
    current.count += 1;
    if (current.count <= config.limit) return null;
    return Math.max(1, Math.ceil((current.start + config.windowMs - at) / MS_PER_SECOND));
  };
}

function toAppError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  if (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_') &&
    typeof statusCode === 'number' &&
    statusCode >= HTTP_STATUS_BAD_REQUEST &&
    statusCode < HTTP_STATUS_SERVER_ERROR
  ) {
    return new ValidationError('request is malformed', { detail: 'The request is malformed.' });
  }
  return error;
}

/**
 * Mounts the internal Run Broker under `/internal/broker` (API-014). It is a separate Fastify plugin
 * scope with its own hooks, error handler and not-found handler, so nothing of `/v1` applies and nothing
 * here is reachable from the public OpenAPI document.
 *
 * Order, all before any handler or body parsing: (1) source guard (socket CIDR + mesh identity header),
 * (2) bearer `bwrun_` token, (3) revocation, (4) per-run-session rate limit. Handlers then check scope,
 * path/body run binding, body schema, a repeated revocation check, the run in its tenant context, and the
 * run's state. Every refusal is RFC 9457 problem+json and none reveals whether another run exists.
 */
export function registerBrokerRoutes(app: FastifyInstance, options: BrokerRoutesOptions): void {
  const problems =
    options.problems ??
    createProblemDetailsMapper(
      options.environment === undefined ? {} : { environment: options.environment },
    );
  const metrics = options.metrics ?? createBrokerMetrics();
  const now = options.now ?? Date.now;
  const limiter = createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT, now);
  const tracer = trace.getTracer(BROKER_TRACER);
  // Requirement 6 (TENANT-003): a tenant mismatch is `CROSS_TENANT_DENIED` and leaves a
  // `tenant.cross_tenant_denied` audit event next to the endpoint's own denied event.
  const tenantGuard = createCrossTenantGuard({
    audit: (event) =>
      options.audit.record({
        action: event.action,
        endpoint: event.surface,
        outcome: 'denied',
        status: HTTP_STATUS_FORBIDDEN,
        code: 'CROSS_TENANT_DENIED',
        tenantId: event.contextTenantId,
        runId: event.resource?.replace(/^run:/, '') ?? '',
        sessionId: '',
        tokenId: '',
        traceId: traceIdOf(),
      }),
    metrics: createTenantContextMetrics(metrics.registry),
    logger: options.logger,
  });

  const authFailure = (request: FastifyRequest, reason: string): void => {
    metrics.authFailures.inc({ reason });
    options.logger.warn(
      { event: 'broker.auth_failure', reason, traceId: request.id },
      'broker refused',
    );
  };

  const record = async (
    principal: BrokerPrincipal,
    endpoint: Endpoint,
    outcome: 'success' | 'denied' | 'rejected' | 'not_implemented' | 'error',
    error: unknown,
    decided?: BrokerPdpDecision,
  ): Promise<void> => {
    try {
      await options.audit.record({
        action: endpoint.action,
        endpoint: endpoint.route,
        outcome,
        status: isAppError(error)
          ? error.httpStatus
          : outcome === 'error'
            ? HTTP_STATUS_SERVER_ERROR
            : HTTP_STATUS_OK,
        code: isAppError(error) ? error.code : null,
        tenantId: principal.tenantId,
        runId: principal.runId,
        sessionId: principal.sessionId,
        tokenId: principal.tokenId,
        traceId: traceIdOf(),
        ...(decided === undefined ? {} : { decision: decided.decision, reason: decided.reason }),
      });
    } catch (auditError) {
      metrics.auditFailures.inc({ endpoint: endpoint.route });
      options.logger.error(
        { event: 'broker.audit_failure', endpoint: endpoint.route, err: auditError },
        'broker audit event could not be recorded',
      );
    }
  };

  void app.register(
    (scope, _opts, done) => {
      scope.decorateRequest('brokerPrincipal', null);

      scope.setErrorHandler((error: unknown, _request, reply) => {
        const response = problems.toProblemResponse(toAppError(error), traceIdOf());
        const headers: Record<string, string> = { ...response.headers };
        if (response.status === HTTP_STATUS_UNAUTHORIZED) headers['www-authenticate'] = 'Bearer';
        void reply.status(response.status).headers(headers).send(response.body);
      });

      // Unknown paths below the prefix still pass the hooks below, so a caller outside the run network
      // or without a token learns nothing about which routes exist.
      scope.setNotFoundHandler(() => {
        throw new NotFoundError('not found');
      });

      scope.addHook('onRequest', async (request) => {
        const refusal = options.sourceGuard.check({
          remoteAddress: request.socket.remoteAddress,
          headers: request.headers,
        });
        if (refusal !== null) {
          authFailure(request, `source_${refusal}`);
          throw new ForbiddenError('source not permitted', { detail: GENERIC_FORBIDDEN });
        }
        let principal: BrokerPrincipal;
        try {
          principal = options.verifier.verify(request.headers.authorization);
          if (await options.revocations.isRevoked(principal)) throw new BrokerAuthError('revoked');
        } catch (error) {
          authFailure(request, error instanceof BrokerAuthError ? error.reason : 'malformed');
          throw error instanceof BrokerAuthError ? error : new BrokerAuthError('malformed');
        }
        request.brokerPrincipal = principal;
        const retryAfterSeconds = limiter(`${principal.runId}:${principal.sessionId}`);
        if (retryAfterSeconds !== null) {
          authFailure(request, 'rate_limited');
          throw new RateLimitedError('rate limit exceeded', { retryAfterSeconds });
        }
      });

      scope.addHook('onResponse', (request, reply, done2) => {
        metrics.requests.inc({
          endpoint: request.routeOptions.url ?? 'unmatched',
          status: String(reply.statusCode),
        });
        done2();
      });

      const run = async (
        request: FastifyRequest,
        principal: BrokerPrincipal,
        endpoint: Endpoint,
      ): Promise<unknown> => {
        const log = withContext(options.logger, {
          traceId: request.id,
          tenantId: principal.tenantId,
          runId: principal.runId,
          sessionId: principal.sessionId,
        });
        try {
          if (!principal.scopes.includes(endpoint.scope)) {
            throw new ForbiddenError('scope not granted', { detail: GENERIC_FORBIDDEN });
          }
          const params = z.object({ runId: z.string() }).safeParse(request.params);
          if (!params.success || params.data.runId !== principal.runId) {
            throw new ForbiddenError('run mismatch', { detail: GENERIC_FORBIDDEN });
          }
          if (endpoint.body !== null) {
            const stated = bodyIds(request.body);
            if (stated.runId !== undefined && stated.runId !== principal.runId) {
              throw new ForbiddenError('run mismatch', { detail: GENERIC_FORBIDDEN });
            }
            if (stated.tenantId !== undefined) {
              await tenantGuard.assertSameTenant(
                typeof stated.tenantId === 'string' ? stated.tenantId : null,
                { surface: endpoint.route, resource: `run:${principal.runId}` },
              );
            }
            const parsed = endpoint.body.safeParse(request.body);
            if (!parsed.success) {
              throw new ValidationError('request body is invalid', {
                detail: `Invalid body: ${parsed.error.issues
                  .map((issue) => issue.path.join('.') || '(body)')
                  .join(', ')}`,
              });
            }
          }
          // Kill-switch revocation takes effect immediately (§8.5): check again right before acting.
          if (await options.revocations.isRevoked(principal)) {
            authFailure(request, 'revoked');
            throw new BrokerAuthError('revoked');
          }
          // Tenant context (§8.6): the lookup runs for the token's tenant only. Unknown run and another
          // tenant's run are the same `null`, answered identically.
          const found = await options.runs.getRun(principal.tenantId, principal.runId);
          if (found === null) {
            throw new ForbiddenError('run not accessible', { detail: GENERIC_FORBIDDEN });
          }
          await tenantGuard.assertSameTenant(found.tenantId, {
            surface: endpoint.route,
            resource: `run:${principal.runId}`,
          });
          if (endpoint.body !== null && terminalStates.has(found.state)) {
            throw new AppError('RUN_NOT_ACTIVE', 'run is not active', {
              detail: 'The run has ended; the broker accepts no more writes for it.',
            });
          }
          if (endpoint.handle !== undefined) {
            const pathParams = z.record(z.string(), z.string()).safeParse(request.params);
            const result = await endpoint.handle({
              ref: { tenantId: found.tenantId, runId: principal.runId },
              params: pathParams.success ? pathParams.data : {},
              body: request.body,
            });
            const decided =
              endpoint.route === BROKER_PDP_EVALUATE_ROUTE
                ? brokerPdpDecisionSchema.parse(result)
                : undefined;
            await record(principal, endpoint, 'success', null, decided);
            log.info(
              { event: 'broker.request', action: endpoint.action, outcome: 'success' },
              'broker request',
            );
            return result;
          }
          const stub = new AppError('NOT_IMPLEMENTED', 'not implemented', {
            detail: `This broker endpoint is owned by ${endpoint.owner} and is not implemented yet.`,
          });
          await record(principal, endpoint, 'not_implemented', stub);
          log.info(
            { event: 'broker.request', action: endpoint.action, outcome: 'not_implemented' },
            'broker request',
          );
          throw stub;
        } catch (error) {
          if (isAppError(error) && error.code === 'NOT_IMPLEMENTED') throw error;
          const outcome =
            isAppError(error) && error.httpStatus < HTTP_STATUS_SERVER_ERROR
              ? error.httpStatus === HTTP_STATUS_FORBIDDEN ||
                error.httpStatus === HTTP_STATUS_UNAUTHORIZED
                ? 'denied'
                : 'rejected'
              : 'error';
          await record(principal, endpoint, outcome, error);
          throw error;
        }
      };

      const endpoints = [
        ...ENDPOINTS,
        pdpEndpoint(options.pdp),
        ...engagementEndpoints(options.engagement),
      ];
      for (const endpoint of endpoints) {
        const handler = async (request: FastifyRequest): Promise<unknown> => {
          const principal = request.brokerPrincipal;
          // Unreachable (the hook always sets it): fail closed rather than serve without a principal.
          if (principal === null) throw new BrokerAuthError('missing');
          const span = tracer.startSpan('broker.request', {
            attributes: {
              'broker.action': endpoint.action,
              'blackwing.run_id': principal.runId,
              'blackwing.session_id': principal.sessionId,
            },
          });
          try {
            // The whole request runs in the run token's tenant context (§8.6, TENANT-003).
            const result = await runWithTenantContext(
              { tenantId: principal.tenantId, actor: { type: 'run', id: principal.runId } },
              () => run(request, principal, endpoint),
            );
            span.end();
            return result;
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw error;
          }
        };
        const method = endpoint.body === null ? 'GET' : 'POST';
        scope.route({ method, url: endpoint.route.slice(BROKER_BASE_PATH.length), handler });
      }

      done();
    },
    { prefix: BROKER_BASE_PATH },
  );
}
