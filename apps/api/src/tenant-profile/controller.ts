import { Body, Controller, Get, Headers, Inject, Patch, Res } from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { TENANT_PROFILE_SERVICE } from './tokens.js';

import type { TenantProfileService, TenantProfileView } from './service.js';
import type { OrgProfile } from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

/** Sends the ETag and `no-store` with the body: a profile answer is per-tenant and must not be cached. */
function answer(reply: FastifyReply, view: TenantProfileView): OrgProfile {
  void reply.header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/**
 * `GET /v1/tenants/current` and `PATCH /v1/tenants/current` (ADMIN-001). Thin: the tenant comes from the
 * guard-resolved context, never from the path or the body, and the service does the authorisation and the write.
 */
@Controller('tenants/current')
export class TenantProfileController {
  constructor(@Inject(TENANT_PROFILE_SERVICE) private readonly service: TenantProfileService) {}

  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<OrgProfile> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.get({ tenantId, actorId: actor.id }));
  }

  @Patch()
  async update(
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OrgProfile> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.update({ tenantId, actorId: actor.id }, ifMatch, body));
  }
}
