import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { API_CONFIG, API_LOGGER } from './tokens.js';

import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';
import type { Server } from 'node:http';

/** Signals that start a graceful shutdown. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Bounds the drain. Nest closes the Fastify server after `beforeApplicationShutdown`: the listener stops
 * accepting connections and in-flight requests run to completion. If they are still running when
 * `API_SHUTDOWN_GRACE_MS` elapses, their connections are closed so the process can exit.
 */
@Injectable()
export class ShutdownDrain implements BeforeApplicationShutdown, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private startedAt = 0;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(API_CONFIG) private readonly config: Readonly<ApiConfig>,
    @Inject(API_LOGGER) private readonly logger: Logger,
  ) {}

  beforeApplicationShutdown(signal?: string): void {
    const graceMs = this.config.API_SHUTDOWN_GRACE_MS;
    this.startedAt = performance.now();
    this.logger.info({ signal: signal ?? null, graceMs }, 'api.shutdown.draining');
    const server: Server | undefined = this.host.httpAdapter.getHttpServer() as Server | undefined;
    this.timer = setTimeout(() => {
      this.logger.warn({ graceMs }, 'api.shutdown.grace_elapsed');
      server?.closeAllConnections();
    }, graceMs);
    this.timer.unref();
  }

  onApplicationShutdown(signal?: string): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const drainedMs = Math.round(performance.now() - this.startedAt);
    this.logger.info({ signal: signal ?? null, drainedMs }, 'api.shutdown.complete');
  }
}
