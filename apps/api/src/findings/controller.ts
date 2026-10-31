import { Controller, Get, Header, Inject, Param, Query, Res } from '@nestjs/common';

import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';

import { parseFindingListQuery } from './query.js';
import { FINDING_SERVICE } from './tokens.js';
import { versionEtag } from '../concurrency/index.js';

import type { FindingService } from './service.js';
import type { FindingDetail, FindingListResponse } from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

/**
 * Finding query routes (FINDING query, §9): `GET /v1/findings` (filter and cursor page) and `GET /v1/findings/:id`
 * (detail). Read-only. The tenant and the actor come from the guard-resolved context, never from the request.
 * The query string is parsed here, not by the global pipe, so every refusal is a `400` with a stable code.
 */
@Controller('findings')
export class FindingController {
  constructor(@Inject(FINDING_SERVICE) private readonly service: FindingService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: Record<string, unknown>): Promise<FindingListResponse> {
    const { tenantId, actor } = getTenantContextOrThrow();
    return this.service.list({ tenantId, actorId: actor.id }, parseFindingListQuery(query));
  }

  /** Sends the finding's ETag: the `If-Match` a triage decision (TRIAGE-004) must carry. */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FindingDetail> {
    const { tenantId, actor } = getTenantContextOrThrow();
    const detail = await this.service.get({ tenantId, actorId: actor.id }, id);
    void reply.header('ETag', versionEtag(detail.stateVersion));
    return detail;
  }
}
