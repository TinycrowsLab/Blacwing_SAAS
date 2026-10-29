import { Controller, Get, Inject, Query, Res } from '@nestjs/common';

import { type AssetListResponse, listAssetsQuerySchema } from '@blackwing/contracts';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { ValidationError } from '@blackwing/errors';

import { ASSET_LIST_SERVICE } from './tokens.js';

import type { AssetListService } from './service.js';
import type { FastifyReply } from 'fastify';

/**
 * `GET /v1/assets` (ASSET-017 scoping input). Thin: the tenant and the actor come from the guard-resolved context,
 * the query is validated strictly here, and the service does the authorisation and the read. Per-tenant answers
 * are not cached.
 */
@Controller('assets')
export class AssetListController {
  constructor(@Inject(ASSET_LIST_SERVICE) private readonly service: AssetListService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetListResponse> {
    const parsed = listAssetsQuerySchema.safeParse(query);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new ValidationError('invalid asset query', {
        detail: `Invalid query: ${[...new Set(fields)].join(', ')}.`,
      });
    }
    const { tenantId, actor } = getTenantContextOrThrow();
    void reply.header('cache-control', 'no-store');
    return this.service.list({ tenantId, actorId: actor.id }, parsed.data);
  }
}
