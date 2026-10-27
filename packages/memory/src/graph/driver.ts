// Neo4j driver for the surface graph (GRAPH-001, §5, §8.7). One pooled driver per process; every consumer goes
// through `withSession` or `checkGraphHealth`. The module only connects: it holds no tenant data and writes no
// audit events (connection events are infrastructure logs).

import { SpanStatusCode, trace } from '@opentelemetry/api';
import neo4j, { type AuthTokenManager, type Config, type Driver, type Session } from 'neo4j-driver';

import { AppError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { loadNeo4jConfig, type Neo4jConfig } from './config.js';

/** The logger surface the graph module needs (satisfied by `@blackwing/logger`). */
export type GraphLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/** Gauge and histogram hooks (OBS wires these to Prometheus; the default is a no-op). */
export interface GraphMetrics {
  /** `graph_health_up`: 1 when the last readiness probe succeeded, 0 otherwise. */
  healthUp(up: boolean): void;
  /** `graph_health_latency_ms`: duration of each readiness probe. */
  healthLatencyMs(latencyMs: number): void;
  /**
   * `graph_driver_pool_in_use`: sessions currently open through {@link withSession}. The driver publishes no
   * pool gauge, so this counts the sessions this module holds.
   */
  poolInUse(count: number): void;
}

const NOOP_METRICS: GraphMetrics = {
  healthUp: () => undefined,
  healthLatencyMs: () => undefined,
  poolInUse: () => undefined,
};

/** Result of {@link checkGraphHealth}. The probe never throws. */
export interface GraphHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
}

/** Driver-internal message when the pool cannot hand out a connection within `connectionAcquisitionTimeout`. */
const POOL_TIMEOUT_MESSAGE = 'Connection acquisition timed out';

const tracer = trace.getTracer('@blackwing/memory');

/** Options for {@link createNeo4jDriver}. */
export interface CreateNeo4jDriverOptions {
  readonly logger: GraphLogger;
  readonly metrics?: GraphMetrics;
  /**
   * Supplies the password for each new connection, so a rotated secret is picked up on reconnect. Default:
   * the configured password.
   */
  readonly resolvePassword?: () => Promise<string>;
  /** Builds the underlying driver. Tests inject a fake; the default is `neo4j.driver`. */
  readonly createDriver?: (uri: string, auth: AuthTokenManager, config: Config) => Driver;
}

/** A driver and the settings the graph code needs next to it. */
export interface GraphRuntime {
  readonly driver: Driver;
  readonly database: string;
  readonly logger: GraphLogger;
  readonly metrics: GraphMetrics;
  /** Open sessions held through {@link withSessionOn}. Mutated only there. */
  readonly sessions: { open: number };
}

/** Maps the driver's log levels onto the structured logger. Lines carry the component name only. */
function driverLogging(logger: GraphLogger): NonNullable<Config['logging']> {
  return {
    level: 'info',
    logger: (level, message) => {
      logger[level]({ component: 'neo4j-driver' }, message);
    },
  };
}

/** Creates a pooled driver for `config`. Nothing connects until the first query or verification. */
export function createNeo4jDriver(config: Neo4jConfig, options: CreateNeo4jDriverOptions): Driver {
  const resolvePassword =
    options.resolvePassword ?? ((): Promise<string> => Promise.resolve(config.password));
  const auth = neo4j.authTokenManagers.basic({
    tokenProvider: async () => neo4j.auth.basic(config.username, await resolvePassword()),
  });
  const createDriver = options.createDriver ?? neo4j.driver;
  const driver = createDriver(config.uri, auth, {
    maxConnectionPoolSize: config.maxPoolSize,
    connectionAcquisitionTimeout: config.connectionTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs,
    maxTransactionRetryTime: config.maxTxRetryMs,
    logging: driverLogging(options.logger),
  });
  options.logger.info(
    { uri_host: new URL(config.uri).host, database: config.database, pool_max: config.maxPoolSize },
    'graph.driver.created',
  );
  return driver;
}

/** Creates the driver plus its database name, logger and metrics. */
export function createGraphRuntime(
  config: Neo4jConfig,
  options: CreateNeo4jDriverOptions,
): GraphRuntime {
  return {
    driver: createNeo4jDriver(config, options),
    database: config.database,
    logger: options.logger,
    metrics: options.metrics ?? NOOP_METRICS,
    sessions: { open: 0 },
  };
}

/** Maps a pool-acquire timeout to `GRAPH_POOL_TIMEOUT` (retryable). Anything else passes through unchanged. */
function toGraphError(error: unknown): unknown {
  if (error instanceof Error && error.message.startsWith(POOL_TIMEOUT_MESSAGE)) {
    return new AppError('GRAPH_POOL_TIMEOUT', 'graph connection pool timed out', { cause: error });
  }
  return error;
}

/** Runs `fn` on a read or write session of `runtime`'s database and always closes the session. */
export async function withSessionOn<T>(
  runtime: GraphRuntime,
  mode: 'READ' | 'WRITE',
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = runtime.driver.session({
    database: runtime.database,
    defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
  });
  runtime.sessions.open += 1;
  runtime.metrics.poolInUse(runtime.sessions.open);
  try {
    return await fn(session);
  } catch (error) {
    throw toGraphError(error);
  } finally {
    runtime.sessions.open -= 1;
    runtime.metrics.poolInUse(runtime.sessions.open);
    await session.close();
  }
}

/** Runs `fn` on a read or write session of the process database and always closes the session. */
export async function withSession<T>(
  mode: 'READ' | 'WRITE',
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  return withSessionOn(getGraph(), mode, fn);
}

/** Error fields safe to log: the class name and the driver's code, never the message (it can name hosts). */
function errorFields(error: unknown): { error_name: string; error_code?: string } {
  const name = error instanceof Error ? error.name : 'unknown';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { error_name: name, error_code: code } : { error_name: name };
}

/** Readiness probe: `RETURN 1` on the configured database. Reports `ok: false` instead of throwing. */
export async function checkGraphHealth(runtime: GraphRuntime = getGraph()): Promise<GraphHealth> {
  return tracer.startActiveSpan('graph.health', async (span) => {
    const started = performance.now();
    try {
      await runtime.driver.executeQuery('RETURN 1', {}, { database: runtime.database });
      const latencyMs = Math.round(performance.now() - started);
      runtime.metrics.healthUp(true);
      runtime.metrics.healthLatencyMs(latencyMs);
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      runtime.metrics.healthUp(false);
      runtime.metrics.healthLatencyMs(latencyMs);
      runtime.logger.warn(
        { database: runtime.database, ...errorFields(error) },
        'graph.health.down',
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      return { ok: false, latencyMs };
    } finally {
      span.end();
    }
  });
}

let current: GraphRuntime | undefined;

/** The process runtime, created on first use from the environment (fails fast with `GRAPH_CONFIG_MISSING`). */
export function getGraph(): GraphRuntime {
  current ??= createGraphRuntime(loadNeo4jConfig(), { logger: createLogger('@blackwing/memory') });
  return current;
}

/** The process-wide pooled driver. Repeated calls return the same instance. */
export function getDriver(): Driver {
  return getGraph().driver;
}

/** Closes the process driver and forgets it. Safe to call twice, and safe when no driver was ever created. */
export async function closeDriver(): Promise<void> {
  const runtime = current;
  if (runtime === undefined) return;
  current = undefined;
  await runtime.driver.close();
  runtime.logger.info({ database: runtime.database }, 'graph.driver.closed');
}
