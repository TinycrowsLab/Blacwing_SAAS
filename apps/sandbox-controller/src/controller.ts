import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { createLogger, type Logger } from '@blackwing/logger';

import { type AuditEmitter, createLogAuditEmitter } from './audit.js';
import { createHmacRunTokenVerifier, type RunTokenVerifier } from './auth.js';
import { configHash, type SandboxControllerConfig } from './config.js';
import { createDriver, type DriverFactory } from './drivers/index.js';
import { createControllerMetrics, type ControllerMetrics } from './metrics.js';
import {
  createReadinessMonitor,
  type DependencyProbe,
  type ReadinessMonitor,
} from './readiness.js';
import { buildServer } from './server.js';
import { createValkeyProbe, type ValkeyProbe } from './valkey.js';
import { version } from './version.js';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

const TRACER_NAME = '@blackwing/sandbox-controller';

/** Flushes buffered telemetry on shutdown. */
export type TelemetryFlusher = () => Promise<void>;

/** Flushes the globally registered OTel tracer provider, if it supports `forceFlush` (no-op otherwise). */
export const flushGlobalTelemetry: TelemetryFlusher = async () => {
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

export interface ControllerDeps {
  readonly logger?: Logger;
  readonly driverFactory?: DriverFactory;
  /** Valkey readiness probe; defaults to a real client on `VALKEY_URL`. */
  readonly valkeyProbe?: DependencyProbe & Partial<Pick<ValkeyProbe, 'close'>>;
  readonly verifier?: RunTokenVerifier;
  readonly audit?: AuditEmitter;
  readonly tracer?: Tracer;
  readonly flushTelemetry?: TelemetryFlusher;
  readonly internalRoutes?: FastifyPluginAsync;
  /** Readiness tuning (tests use short intervals). */
  readonly readiness?: { readonly initialBackoffMs?: number; readonly recheckMs?: number };
}

export interface ShutdownResult {
  /** True when every in-flight request finished within `SBX_DRAIN_TIMEOUT`. */
  readonly drained: boolean;
}

export interface RunningController {
  readonly app: FastifyInstance;
  readonly readiness: ReadinessMonitor;
  readonly metrics: ControllerMetrics;
  /** Bound address, e.g. `127.0.0.1:7070`. */
  readonly address: { readonly host: string; readonly port: number };
  /** Stops accepting, drains up to `SBX_DRAIN_TIMEOUT`, flushes telemetry. Idempotent. */
  shutdown(signal: string): Promise<ShutdownResult>;
}

/**
 * Boots the controller from an already-validated config: builds the server, binds the management address
 * (internal interface only), starts readiness probing and emits `sandbox_controller.started`.
 */
export async function startSandboxController(
  config: Readonly<SandboxControllerConfig>,
  deps: ControllerDeps = {},
): Promise<RunningController> {
  const rootLogger =
    deps.logger ??
    createLogger('sandbox-controller', { level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
  const logger = rootLogger.child({ component: 'bootstrap' });
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME, version);
  const audit = deps.audit ?? createLogAuditEmitter(rootLogger);
  const flush = deps.flushTelemetry ?? flushGlobalTelemetry;
  const hash = configHash(config);
  const commit = config.SBX_BUILD_COMMIT;

  return tracer.startActiveSpan('sandbox_controller.startup', async (span) => {
    try {
      const metrics = createControllerMetrics(version, commit);
      // The driver client is lazy: constructing the driver never touches Kubernetes/Docker.
      const driver = (deps.driverFactory ?? createDriver)(config.SBX_DRIVER);
      const valkey = deps.valkeyProbe ?? createValkeyProbe(config.VALKEY_URL);
      const readiness = createReadinessMonitor({
        probes: [{ name: 'driver', check: () => driver.ping() }, valkey],
        ...(deps.readiness?.initialBackoffMs === undefined
          ? {}
          : { initialBackoffMs: deps.readiness.initialBackoffMs }),
        ...(deps.readiness?.recheckMs === undefined ? {} : { recheckMs: deps.readiness.recheckMs }),
        onChange: (ready, state) => {
          metrics.ready.set(ready ? 1 : 0);
          logger.info({ ready, checks: state }, 'sbx.readiness.changed');
        },
        onProbeFailure: (name, attempt, nextDelayMs) => {
          logger.warn(
            { dependency: name, attempt, next_delay_ms: nextDelayMs },
            'sbx.readiness.probe_failed',
          );
        },
      });
      const app = buildServer({
        logger: rootLogger,
        verifier:
          deps.verifier ?? createHmacRunTokenVerifier({ secret: config.SBX_RUN_TOKEN_SECRET }),
        readiness,
        metrics,
        maxBodyBytes: config.SBX_MAX_BODY_BYTES,
        environment: config.NODE_ENV,
        ...(deps.internalRoutes === undefined ? {} : { internalRoutes: deps.internalRoutes }),
      });

      await app.listen({ host: config.SBX_MGMT_ADDR.host, port: config.SBX_MGMT_ADDR.port });
      const bound = app.server.address();
      const address =
        typeof bound === 'object' && bound !== null
          ? { host: bound.address, port: bound.port }
          : { host: config.SBX_MGMT_ADDR.host, port: config.SBX_MGMT_ADDR.port };
      metrics.up.set(1);
      readiness.start();
      await audit.emit({
        type: 'sandbox_controller.started',
        configHash: hash,
        version,
        commit,
        occurredAt: new Date().toISOString(),
      });
      logger.info(
        { host: address.host, port: address.port, driver: config.SBX_DRIVER, config_hash: hash },
        'sbx.started',
      );

      let pending: Promise<ShutdownResult> | undefined;
      const shutdown = (signal: string): Promise<ShutdownResult> => {
        pending ??= (async () => {
          logger.info({ signal, drain_timeout_ms: config.SBX_DRAIN_TIMEOUT }, 'sbx.shutdown.begin');
          readiness.stop();
          metrics.up.set(0);
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<false>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, config.SBX_DRAIN_TIMEOUT);
          });
          const closed = app.close().then(() => true as const);
          const drained = await Promise.race([closed, timedOut]);
          clearTimeout(timer);
          if (!drained) {
            logger.warn({ signal }, 'sbx.shutdown.drain_timeout');
            app.server.closeAllConnections();
            await closed.catch(() => undefined);
          }
          await Promise.allSettled([driver.close(), valkey.close?.() ?? Promise.resolve()]);
          await audit
            .emit({
              type: 'sandbox_controller.stopped',
              configHash: hash,
              version,
              commit,
              occurredAt: new Date().toISOString(),
              signal,
              drained,
            })
            .catch(() => undefined);
          logger.info({ signal, drained }, 'sbx.shutdown.complete');
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
