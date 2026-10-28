import { Body, Controller, Get, Headers, Inject, Patch, Res } from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { TENANT_SETTINGS_SERVICE } from './tokens.js';

import type { TenantSettingsService, TenantSettingsView } from './service.js';
import type { TenantSettingsResponse } from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

/** Sends the ETag and `no-store` with the body: a settings answer is per-tenant and must not be cached. */
function answer(reply: FastifyReply, view: TenantSettingsView): TenantSettingsResponse {
  void reply.header('ETag', view.etag).header('cache-control', 'no-store');
  return view.body;
}

/**
 * `GET /v1/tenant/settings` and `PATCH /v1/tenant/settings` (TENANT-008). Thin: the tenant comes from the
 * guard-resolved context, never from the body, and the service does the authorisation and the write.
 */
@Controller('tenant/settings')
export class TenantSettingsController {
  constructor(@Inject(TENANT_SETTINGS_SERVICE) private readonly service: TenantSettingsService) {}

  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<TenantSettingsResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.get({ tenantId, actorId: actor.id }));
  }

  @Patch()
  async update(
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TenantSettingsResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return answer(reply, await this.service.update({ tenantId, actorId: actor.id }, ifMatch, body));
  }
}
