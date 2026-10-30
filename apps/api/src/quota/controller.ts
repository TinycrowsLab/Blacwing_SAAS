import { Controller, Get, Inject, Res } from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { QUOTA_SERVICE } from './tokens.js';

import type { QuotaService, QuotaView } from './service.js';
import type { FastifyReply } from 'fastify';

/**
 * `GET /v1/tenant/quotas` (TENANT-009): the tenant's plan, used against limit per resource, and the month-to-date
 * cost against its cap. Thin: the tenant comes from the guard-resolved context, and the service checks the caller's
 * permission. The answer is per tenant, so it is never cached.
 */
@Controller('tenant/quotas')
export class QuotaController {
  constructor(@Inject(QUOTA_SERVICE) private readonly service: QuotaService) {}

  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<QuotaView> {
    const { tenantId, actor } = getTenantContextOrThrow();
    void reply.header('cache-control', 'no-store');
    return this.service.view({ tenantId, userId: actor.id });
  }
}
