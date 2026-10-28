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
import { type DocsAuthenticator, registerDocsRoutes } from '../openapi/docs-routes.js';
import { buildOpenApiDocument, countOperations } from '../openapi/document.js';
import { apiPackageVersion } from '../openapi/emit.js';

import type { AuthOptions } from '../auth/module.js';
import type { ApiConfig } from '../config.js';
import type { SecurityEventSink } from '../errors/problem-filter.js';
import type { HealthProbe } from '../health/health.types.js';
import type { IdempotencyStore } from '../idempotency/ports.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import type { RateLimitConfig } from '../rate-limit/policy.js';
import type { TenantPrincipalSource } from '../tenant/guard.js';
import type { Logger } from '@blackwing/logger';
import type { Tracer } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
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
  /** Dependencies the health endpoints check; wired by the process entry point. */
  readonly healthProbes?: readonly HealthProbe[];
  /** Store behind `@Idempotent()` routes; without one they fail closed with 503 (API-008). */
  readonly idempotencyStore?: IdempotencyStore;
  /** The global auth guard's validators (#335); installs the guard and the tenant source it feeds. */
  readonly auth?: AuthOptions;
  /** IAM's validated-principal lookup; installs the global tenant guard (see `AppModuleOptions`). */
  readonly tenantPrincipalSource?: TenantPrincipalSource;
  /** Receives security-relevant errors for auditing (see `SecurityEventSink`). */
  readonly securityEventSink?: SecurityEventSink;
  /** Shared limiter of the rate-limit guard (Valkey); absent means an in-process limiter per instance. */
  readonly rateLimiter?: RateLimiter;
  /** Per-plan and per-route-class limit values (TENANT-011). */
  readonly rateLimitConfig?: RateLimitConfig;
  /** Extra modules to mount (feature modules; test-only routes). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
  /**
   * Install the SIGTERM/SIGINT handlers that drain and exit 0. Only the process entry point sets this:
   * the handlers call `process.exit`.
   */
  readonly shutdownHooks?: boolean;
  /**
   * Fastify route modules to mount on the adapter's instance before the app initialises (for example
   * `registerKillRoutes`, KILL-003). They register their full `/v1/...` paths themselves.
   */
  /**
   * Verifies the caller of `/v1/docs` in production (API-003). Without it production answers 401 to
   * every docs request (fail closed); other environments serve the docs publicly.
   */
  readonly docsAuthenticate?: DocsAuthenticator;
  readonly routes?: readonly ((instance: FastifyInstance) => void | Promise<void>)[];
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
    // The public SOC kill link carries a ~450-character signed token as a path segment (KILL-007).
    routerOptions: { maxParamLength: 1024 },
    trustProxy: config.API_TRUST_PROXY,
    // Fastify must not adopt a client `x-request-id` on its own: deriveTraceId validates it first.
    requestIdHeader: false,
    genReqId: (request: IncomingMessage) => deriveTraceId(request.headers),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      config,
      logger,
      metrics,
      ...(options.healthProbes === undefined ? {} : { healthProbes: options.healthProbes }),
      ...(options.idempotencyStore === undefined
        ? {}
        : { idempotencyStore: options.idempotencyStore }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.tenantPrincipalSource === undefined
        ? {}
        : { tenantPrincipalSource: options.tenantPrincipalSource }),
      ...(options.securityEventSink === undefined
        ? {}
        : { securityEventSink: options.securityEventSink }),
      ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
      ...(options.rateLimitConfig === undefined
        ? {}
        : { rateLimitConfig: options.rateLimitConfig }),
      imports: [ShutdownModule, ...(options.imports ?? [])],
    }),
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

  const document = buildOpenApiDocument({ version: apiPackageVersion() });
  metrics.openapiOperations.set(countOperations(document));
  registerDocsRoutes(app.getHttpAdapter().getInstance(), {
    document,
    environment: config.NODE_ENV,
    ...(options.docsAuthenticate === undefined ? {} : { authenticate: options.docsAuthenticate }),
  });

  for (const mount of options.routes ?? []) {
    await mount(app.getHttpAdapter().getInstance());
  }

  if (options.shutdownHooks === true) {
    app.enableShutdownHooks([...SHUTDOWN_SIGNALS], { useProcessExit: true });
  }
  await app.init();
  return { app, metrics };
}
