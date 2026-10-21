import { Controller, Get, Inject, Res } from '@nestjs/common';

import { HealthService } from './health.service.js';
import { PublicRoute } from '../tenant/public-route.js';

import type { HealthReport } from './health.types.js';
import type { FastifyReply } from 'fastify';

const SERVICE_UNAVAILABLE = 503;

/** Probe endpoints (API-011): unprefixed, unauthenticated, no audit, exempt from rate limiting. */
@PublicRoute()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: the process is up. 503 only while draining. */
  @Get('live')
  live(@Res({ passthrough: true }) reply: FastifyReply): { readonly status: 'ok' | 'draining' } {
    if (!this.health.isDraining()) return { status: 'ok' };
    void reply.status(SERVICE_UNAVAILABLE);
    return { status: 'draining' };
  }

  /** Readiness: 200 only when every critical dependency is up and the API is not draining. */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ readonly status: 'ready' | 'not_ready' }> {
    if (this.health.isDraining()) {
      void reply.status(SERVICE_UNAVAILABLE);
      return { status: 'not_ready' };
    }
    const { ready } = await this.health.readiness();
    if (ready) return { status: 'ready' };
    void reply.status(SERVICE_UNAVAILABLE);
    return { status: 'not_ready' };
  }

  /** Detailed report for humans. 503 when a critical dependency is down or the API is draining. */
  @Get()
  async report(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthReport> {
    const report = await this.health.report();
    if (report.status === 'down') void reply.status(SERVICE_UNAVAILABLE);
    return report;
  }
}
