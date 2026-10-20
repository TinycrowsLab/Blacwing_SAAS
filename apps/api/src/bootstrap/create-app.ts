import 'reflect-metadata';

import { fastifyCors } from '@fastify/cors';
import { fastifyHelmet } from '@fastify/helmet';
import { Module, type ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../app.module.js';
import { createHttpMetrics, type HttpMetrics } from './metrics.js';
import { NestPinoLogger } from './nest-logger.js';
import { registerRequestObservability } from './request-context.js';
import { SHUTDOWN_SIGNALS, ShutdownDrain } from './shutdown.js';
import { deriveTraceId } from './trace-id.js';

import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';
import type { Tracer } from '@opentelemetry/api';
import type { IncomingMessage } from 'node:http';

/** Global REST prefix (§9). */
export const API_PREFIX = 'v1';

/**
 * Routes served outside `/v1`: health probes (API-011), GraphQL (API-009) and the internal Run Broker
 * API (`/internal/broker`, §3.1).
 */
export const GLOBAL_PREFIX_EXCLUDES: readonly string[] = Object.freeze([
  'health',
  'health/live',
  'health/ready',
  'graphql',
  'internal/broker',
  'internal/broker/{*path}',
]);

export interface CreateApiAppOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  readonly tracer?: Tracer;
  readonly metrics?: HttpMetrics;
  /** Extra modules to mount (feature modules; test-only routes). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
  /**
   * Install the SIGTERM/SIGINT handlers that drain and exit 0. Only the process entry point sets this:
   * the handlers call `process.exit`.
   */
  readonly shutdownHooks?: boolean;
}

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly metrics: HttpMetrics;
}

@Module({ providers: [ShutdownDrain] })
class ShutdownModule {}

/**
 * Builds and initialises the API (not yet listening): Fastify adapter with the configured body limit,
 * proxy trust and trace-id derivation, raw bodies kept for signature checks, pino as Nest's logger,
 * Helmet, CORS for the web console origins, request context and per-request logs, metrics and spans.
 */
export async function createApiApp(options: CreateApiAppOptions): Promise<ApiApp> {
  const { config, logger } = options;
  const metrics = options.metrics ?? createHttpMetrics();

  const adapter = new FastifyAdapter({
    logger: false,
    bodyLimit: config.API_BODY_LIMIT_BYTES,
    trustProxy: config.API_TRUST_PROXY,
    // Fastify must not adopt a client `x-request-id` on its own: deriveTraceId validates it first.
    requestIdHeader: false,
    genReqId: (request: IncomingMessage) => deriveTraceId(request.headers),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ config, logger, imports: [ShutdownModule, ...(options.imports ?? [])] }),
    adapter,
    { bufferLogs: true, rawBody: true, abortOnError: false },
  );
  app.useLogger(new NestPinoLogger(logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...GLOBAL_PREFIX_EXCLUDES] });

  await app.register(fastifyHelmet);
  await app.register(fastifyCors, { origin: [...config.WEB_ORIGIN], credentials: true });
  await registerRequestObservability(app.getHttpAdapter().getInstance(), {
    logger,
    metrics,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });

  if (options.shutdownHooks === true) {
    app.enableShutdownHooks([...SHUTDOWN_SIGNALS], { useProcessExit: true });
  }
  await app.init();
  return { app, metrics };
}
