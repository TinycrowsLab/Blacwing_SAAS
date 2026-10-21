import { type DynamicModule, Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { IDEMPOTENCY_SERVICE } from './interceptor.js';
import { createIdempotencyMetrics } from './metrics.js';
import { registerIdempotencyHook } from './on-send.js';
import { IdempotencyService } from './service.js';
import { API_CONFIG, API_LOGGER } from '../bootstrap/tokens.js';

import type { ApiConfig } from '../config.js';
import type { IdempotencyStore } from './ports.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

export interface IdempotencyModuleOptions {
  /** The Valkey-backed store; without one every `@Idempotent()` route answers `503` (fail closed). */
  readonly store?: IdempotencyStore;
  /** Registry the `idempotency_*` metrics are registered on. */
  readonly registry: Registry;
}

/** Wires the Idempotency-Key service, interceptor and `onSend` hook (API-008). */
@Global()
@Module({})
export class IdempotencyModule implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(IDEMPOTENCY_SERVICE) private readonly service: IdempotencyService,
  ) {}

  static forRoot(options: IdempotencyModuleOptions): DynamicModule {
    return {
      module: IdempotencyModule,
      providers: [
        {
          provide: IDEMPOTENCY_SERVICE,
          inject: [API_CONFIG, API_LOGGER],
          useFactory: (config: Readonly<ApiConfig>, logger: Logger): IdempotencyService =>
            new IdempotencyService({
              store: options.store ?? null,
              ttlSeconds: config.API_IDEMPOTENCY_TTL_S,
              lockTtlSeconds: config.API_IDEMPOTENCY_LOCK_TTL_S,
              maxBodyBytes: config.API_IDEMPOTENCY_MAX_BODY_BYTES,
              metrics: createIdempotencyMetrics(options.registry),
              logger,
            }),
        },
      ],
      exports: [IDEMPOTENCY_SERVICE],
    };
  }

  onModuleInit(): void {
    // Module init runs before Nest registers routes, so the hook covers every route.
    registerIdempotencyHook(
      this.adapterHost.httpAdapter.getInstance<FastifyInstance>(),
      this.service,
    );
  }
}
