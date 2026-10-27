import { readFile } from 'node:fs/promises';

import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';

import { parseTemporalConfig, type TemporalConfig } from '@blackwing/config';
import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createContextClientInterceptor } from './context-interceptor.js';
import { createDataConverter } from './data-converter.js';

import type { DataConverter } from '@temporalio/common';

/** Attempts made to reach Temporal before giving up with `TEMPORAL_UNAVAILABLE`. */
export const CONNECT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 5_000;
/** gRPC `NOT_FOUND`. */
const GRPC_NOT_FOUND = 5;

const COMPONENT = 'temporal-client';

/** Test seams. Production code passes none of these. */
export interface TemporalClientOptions {
  /** Validated settings. Default: parsed from the environment by `@blackwing/config`. */
  readonly config?: TemporalConfig;
  /** Payload data converter shared with workers. Default: the SDK default converter. */
  readonly dataConverter?: DataConverter;
  /** Opens a connection. Default: `Connection.connect`. */
  readonly connect?: (options: ConnectionOptions) => Promise<Connection>;
  /** Reads a PEM file. Default: `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<Buffer>;
  /** Waits between attempts. Default: a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Cached {
  readonly connection: Promise<Connection>;
  client?: Promise<Client>;
}

let cached: Cached | undefined;

const log = createLogger('workflow-shared').child({ component: COMPONENT });
const connectCounter = metrics
  .getMeter('@blackwing/workflow-shared')
  .createCounter('temporal_client_connect_total', {
    description: 'Temporal connection attempts by result',
  });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Host part of `host:port` (never credentials: the config schema forbids them). */
function hostOf(address: string): string {
  const index = address.lastIndexOf(':');
  return index === -1 ? address : address.slice(0, index);
}

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'number' ? code : undefined;
}

async function buildConnectionOptions(
  config: TemporalConfig,
  read: (path: string) => Promise<Buffer>,
): Promise<ConnectionOptions> {
  if (!config.tls.enabled) return { address: config.address };
  const { clientCertPath, clientKeyPath } = config.tls;
  if (clientCertPath === undefined || clientKeyPath === undefined) {
    throw new AppError(
      'TEMPORAL_TLS_MISCONFIGURED',
      'TEMPORAL_TLS_ENABLED=true requires TEMPORAL_CLIENT_CERT_PATH and TEMPORAL_CLIENT_KEY_PATH',
    );
  }
  try {
    const [crt, key] = await Promise.all([read(clientCertPath), read(clientKeyPath)]);
    // Contents go straight to the SDK; they are never logged.
    return { address: config.address, tls: { clientCertPair: { crt, key } } };
  } catch (cause) {
    throw new AppError(
      'TEMPORAL_TLS_MISCONFIGURED',
      'Temporal client certificate or key could not be read',
      { cause },
    );
  }
}

async function openOnce(
  config: TemporalConfig,
  options: ConnectionOptions,
  connect: (options: ConnectionOptions) => Promise<Connection>,
): Promise<Connection> {
  const connection = await connect(options);
  try {
    await connection.workflowService.describeNamespace({ namespace: config.namespace });
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    if (grpcCode(error) === GRPC_NOT_FOUND) {
      throw new AppError(
        'TEMPORAL_NAMESPACE_NOT_FOUND',
        `Temporal namespace "${config.namespace}" does not exist`,
        {
          cause: error,
          detail: `Create the namespace first (e.g. \`temporal operator namespace create ${config.namespace}\`) or fix TEMPORAL_NAMESPACE`,
        },
      );
    }
    throw error;
  }
}

async function openWithRetry(
  config: TemporalConfig,
  deps: TemporalClientOptions,
): Promise<Connection> {
  const connect = deps.connect ?? ((options) => Connection.connect(options));
  const sleep = deps.sleep ?? defaultSleep;
  const options = await buildConnectionOptions(config, deps.readFile ?? ((path) => readFile(path)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      return await openOnce(config, options, connect);
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error;
      log.warn(
        { namespace: config.namespace, address: hostOf(config.address), attempt, err: error },
        'temporal connection attempt failed',
      );
      if (attempt < CONNECT_MAX_ATTEMPTS) {
        await sleep(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
      }
    }
  }
  throw new AppError(
    'TEMPORAL_UNAVAILABLE',
    `Temporal at ${hostOf(config.address)} unreachable after ${CONNECT_MAX_ATTEMPTS} attempts`,
    { cause: lastError },
  );
}

async function open(deps: TemporalClientOptions): Promise<Connection> {
  const config = deps.config ?? parseTemporalConfig();
  return await trace
    .getTracer('@blackwing/workflow-shared')
    .startActiveSpan('temporal.connect', async (span) => {
      span.setAttributes({
        'temporal.namespace': config.namespace,
        'temporal.address.host': hostOf(config.address),
        'temporal.tls': config.tls.enabled,
      });
      try {
        const connection = await openWithRetry(config, deps);
        connectCounter.add(1, { result: 'success' });
        log.info(
          { namespace: config.namespace, address: hostOf(config.address) },
          'temporal connection opened',
        );
        return connection;
      } catch (error) {
        connectCounter.add(1, { result: 'failure' });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

/**
 * The process-wide Temporal connection, opened on first use and reused afterwards (concurrent callers
 * share one in-flight attempt, so there is exactly one socket). Fails closed with `TEMPORAL_CONFIG_INVALID`,
 * `TEMPORAL_TLS_MISCONFIGURED`, `TEMPORAL_NAMESPACE_NOT_FOUND` or, after 5 capped-backoff attempts,
 * `TEMPORAL_UNAVAILABLE`. A failed attempt is not cached: the next call tries again.
 * Options only matter for the call that opens the connection.
 */
export function getTemporalConnection(options: TemporalClientOptions = {}): Promise<Connection> {
  return ensure(options).connection;
}

function ensure(options: TemporalClientOptions): Cached {
  if (cached !== undefined) return cached;
  const entry: Cached = { connection: open(options) };
  cached = entry;
  entry.connection.catch(() => {
    if (cached === entry) cached = undefined;
  });
  return entry;
}

/**
 * A `Client` bound to the configured namespace, over the shared connection. Workflow calls must run inside
 * `runWithWorkflowContext` (`@blackwing/telemetry`); without a tenant context they throw `MISSING_TENANT_CONTEXT`.
 */
export function getTemporalClient(options: TemporalClientOptions = {}): Promise<Client> {
  const entry = ensure(options);
  entry.client ??= entry.connection.then((connection) => {
    const config = options.config ?? parseTemporalConfig();
    return new Client({
      connection,
      namespace: config.namespace,
      dataConverter: options.dataConverter ?? createDataConverter(),
      // Every start, signal, query and update carries the tenant and trace context, or fails closed (#25).
      interceptors: { workflow: [createContextClientInterceptor()] },
    });
  });
  return entry.client;
}

/**
 * Closes the shared connection (graceful shutdown) and forgets it, so a later call opens a fresh one.
 * Also the reset hook for tests. Safe to call when nothing was opened or the open failed.
 */
export async function closeTemporal(): Promise<void> {
  const entry = cached;
  cached = undefined;
  if (entry === undefined) return;
  let connection: Connection;
  try {
    connection = await entry.connection;
  } catch {
    return;
  }
  await connection.close();
  log.info('temporal connection closed');
}
