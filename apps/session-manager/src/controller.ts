import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { createLogger, type Logger } from '@blackwing/logger';

import { type AuditEmitter, createLogAuditEmitter } from './audit.js';
import { configHash, type SessionManagerConfig } from './config.js';
import { createSessionManagerMetrics, type SessionManagerMetrics } from './metrics.js';
import { createOpenBaoProbe, createPostgresProbe, createValkeyProbe } from './probes.js';
import {
  createReadinessMonitor,
  type DependencyProbe,
  type ReadinessMonitor,
} from './readiness.js';
import { buildServer } from './server.js';
import { createTokenVerifier, type TokenVerifier } from './tokens.js';
import { version } from './version.js';

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';

const TRACER_NAME = '@blackwing/session-manager';

/** Flushes buffered telemetry on shutdown. */
type TelemetryFlusher = () => Promise<void>;

/** Flushes the globally registered OTel tracer provider, if it supports `forceFlush` (no-op otherwise). */
const flushGlobalTelemetry: TelemetryFlusher = async () => {
  const provider: unknown = trace.getTracerProvider();
  const delegate: unknown =
    typeof provider === 'object' && provider !== null && 'getDelegate' in provider
      ? (provider as { getDelegate(): unknown }).getDelegate()
      : provider;
  if (
    typeof delegate === 'object' &&
    delegate !== null &&
    'forceFlush' in delegate &&
    typeof delegate.forceFlush === 'function'
  ) {
    await (delegate as { forceFlush(): Promise<void> }).forceFlush();
  }
};

/** A readiness probe that can release its client on shutdown. */
type ClosableDependency = DependencyProbe & { close?(): Promise<void> };

export interface SessionManagerDeps {
  readonly logger?: Logger;
  /** PostgreSQL probe; defaults to a real check on `DATABASE_URL`. */
  readonly postgresProbe?: ClosableDependency;
  /** Valkey probe; defaults to a real client on `VALKEY_URL`. */
  readonly valkeyProbe?: ClosableDependency;
  /** OpenBao probe; defaults to `GET /v1/sys/health` on `OPENBAO_ADDR`. */
  readonly openBaoProbe?: ClosableDependency;
  readonly verifier?: TokenVerifier;
  readonly audit?: AuditEmitter;
  readonly tracer?: Tracer;
  readonly flushTelemetry?: TelemetryFlusher;
  readonly internalRoutes?: FastifyPluginCallback;
  /** Readiness tuning (tests use short intervals). */
  readonly readiness?: { readonly initialBackoffMs?: number; readonly recheckMs?: number };
}

export interface ShutdownResult {
  /** True when every in-flight request finished within `SM_DRAIN_TIMEOUT`. */
  readonly drained: boolean;
}

export interface RunningSessionManager {
  readonly app: FastifyInstance;
  readonly readiness: ReadinessMonitor;
  readonly metrics: SessionManagerMetrics;
  /** Bound address, e.g. `127.0.0.1:7080`. */
  readonly address: { readonly host: string; readonly port: number };
  /** Stops accepting, drains up to `SM_DRAIN_TIMEOUT`, flushes telemetry. Idempotent. */
  shutdown(signal: string): Promise<ShutdownResult>;
}

/**
 * Boots the session manager from an already-validated config: builds the server, binds the internal address,
 * starts readiness probing (PostgreSQL, Valkey, OpenBao) and emits `session_manager.started`. Readiness stays
 * 503 until every dependency answers, so no session is served while a dependency is down (fail closed).
 */
export async function startSessionManager(
  config: Readonly<SessionManagerConfig>,
  deps: SessionManagerDeps = {},
): Promise<RunningSessionManager> {
  const rootLogger =
    deps.logger ??
    createLogger('session-manager', { level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
  const logger = rootLogger.child({ component: 'bootstrap' });
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME, version);
  const audit = deps.audit ?? createLogAuditEmitter(rootLogger);
  const flush = deps.flushTelemetry ?? flushGlobalTelemetry;
  const hash = configHash(config);
  const commit = config.SM_BUILD_COMMIT;

  return tracer.startActiveSpan('session_manager.startup', async (span) => {
    try {
      const metrics = createSessionManagerMetrics(version, commit);
      const postgres = deps.postgresProbe ?? createPostgresProbe(config.DATABASE_URL);
      const valkey = deps.valkeyProbe ?? createValkeyProbe(config.VALKEY_URL);
      const openBao = deps.openBaoProbe ?? createOpenBaoProbe(config.OPENBAO_ADDR);
      const dependencies: readonly ClosableDependency[] = [postgres, valkey, openBao];
      const readiness = createReadinessMonitor({
        probes: dependencies,
        ...(deps.readiness?.initialBackoffMs === undefined
          ? {}
          : { initialBackoffMs: deps.readiness.initialBackoffMs }),
        ...(deps.readiness?.recheckMs === undefined ? {} : { recheckMs: deps.readiness.recheckMs }),
        onChange: (ready, state) => {
          metrics.ready.set(ready ? 1 : 0);
          logger.info({ ready, checks: state }, 'sm.readiness.changed');
        },
        onProbeFailure: (name, attempt, nextDelayMs) => {
          logger.warn(
            { dependency: name, attempt, next_delay_ms: nextDelayMs },
            'sm.readiness.probe_failed',
          );
        },
      });
      const app = buildServer({
        logger: rootLogger,
        verifier:
          deps.verifier ??
          createTokenVerifier({
            runSecret: config.SM_RUN_TOKEN_SECRET,
            controlSecret: config.SM_CONTROL_TOKEN_SECRET,
          }),
        readiness,
        metrics,
        maxBodyBytes: config.SM_MAX_BODY_BYTES,
        environment: config.NODE_ENV,
        ...(deps.internalRoutes === undefined ? {} : { internalRoutes: deps.internalRoutes }),
      });

      await app.listen({ host: config.SM_MGMT_ADDR.host, port: config.SM_MGMT_ADDR.port });
      const bound = app.server.address();
      const address =
        typeof bound === 'object' && bound !== null
          ? { host: bound.address, port: bound.port }
          : { host: config.SM_MGMT_ADDR.host, port: config.SM_MGMT_ADDR.port };
      metrics.up.set(1);
      readiness.start();
      await audit.emit({
        type: 'session_manager.started',
        configHash: hash,
        version,
        commit,
        occurredAt: new Date().toISOString(),
      });
      logger.info({ host: address.host, port: address.port, config_hash: hash }, 'sm.started');

      let pending: Promise<ShutdownResult> | undefined;
      const shutdown = (signal: string): Promise<ShutdownResult> => {
        pending ??= (async () => {
          logger.info({ signal, drain_timeout_ms: config.SM_DRAIN_TIMEOUT }, 'sm.shutdown.begin');
          readiness.stop();
          metrics.up.set(0);
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<false>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, config.SM_DRAIN_TIMEOUT);
          });
          const closed = app.close().then(() => true as const);
          const drained = await Promise.race([closed, timedOut]);
          clearTimeout(timer);
          if (!drained) {
            logger.warn({ signal }, 'sm.shutdown.drain_timeout');
            app.server.closeAllConnections();
            await closed.catch(() => undefined);
          }
          await Promise.allSettled(
            dependencies.map((dependency) => dependency.close?.() ?? Promise.resolve()),
          );
          await audit
            .emit({
              type: 'session_manager.stopped',
              configHash: hash,
              version,
              commit,
              occurredAt: new Date().toISOString(),
              signal,
              drained,
            })
            .catch(() => undefined);
          logger.info({ signal, drained }, 'sm.shutdown.complete');
          await flush().catch(() => undefined);
          return { drained };
        })();
        return pending;
      };

      return { app, readiness, metrics, address, shutdown };
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
