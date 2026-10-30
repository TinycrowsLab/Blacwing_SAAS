import { Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Res } from '@nestjs/common';

import {
  type AssetListResponse,
  type AssetView,
  assetListResponseSchema,
  createAssetBodySchema,
  listAssetsQuerySchema,
  updateAssetBodySchema,
} from '@blackwing/contracts';

import { observeAssetRequest, type AssetMetrics } from './metrics.js';
import { principalOfRequest } from './principal.js';
import { ASSET_METRICS, ASSET_SERVICE } from './tokens.js';
import { createZodDto } from '../validation/zod-dto.js';
import { ZodBody, ZodQuery } from '../validation/zod-validation.pipe.js';

import type { AssetService } from './service.js';
import type { FastifyReply } from 'fastify';

/** Default and maximum page size of `GET /v1/assets` (§9). */
const ASSET_PAGE_DEFAULT = 50;

export class CreateAssetDto extends createZodDto(createAssetBodySchema) {}
export class UpdateAssetDto extends createZodDto(updateAssetBodySchema) {}
export class AssetListQueryDto extends createZodDto(listAssetsQuerySchema) {}

// Paths are relative: the global `/v1` prefix (§9) is applied by the bootstrap.
// Decorator paths are relative to the global `/v1` prefix; metric and Location labels are the served paths.
const COLLECTION = '';
const ITEM = ':id';
const ROUTE_COLLECTION = '/v1/assets';
const ROUTE_ITEM = '/v1/assets/:id';
const HTTP_OK = 200;
const HTTP_CREATED = 201;

/**
 * REST surface of the asset registry (ASSET-002, #355): `POST|GET /v1/assets`, `GET|PATCH|DELETE /v1/assets/:id`.
 * Thin: parse with the DTO, resolve the principal from the tenant context, hand to the service, shape the
 * response. Errors are problem+json through the global filter.
 */
@Controller('assets')
export class AssetsController {
  constructor(
    @Inject(ASSET_SERVICE) private readonly service: AssetService,
    @Inject(ASSET_METRICS) private readonly metrics: AssetMetrics,
  ) {}

  @Post(COLLECTION)
  async create(
    @ZodBody(CreateAssetDto) body: CreateAssetDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetView> {
    return observeAssetRequest(this.metrics, ROUTE_COLLECTION, HTTP_CREATED, async () => {
      const result = await this.service.create(principalOfRequest(), body, idempotencyKey);
      reply.status(result.status);
      reply.header('etag', result.view.etag);
      reply.header('location', `${ROUTE_COLLECTION}/${result.view.id}`);
      return result.view;
    });
  }

  /** The paged list (the wizard's projection, #355 paging): per-tenant, so never cached. */
  @Get(COLLECTION)
  async list(
    @ZodQuery(AssetListQueryDto) query: AssetListQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetListResponse> {
    return observeAssetRequest(this.metrics, ROUTE_COLLECTION, HTTP_OK, async () => {
      const page = await this.service.list(
        principalOfRequest(),
        query,
        query.limit ?? ASSET_PAGE_DEFAULT,
      );
      reply.header('cache-control', 'no-store');
      return assetListResponseSchema.parse(page);
    });
  }

  @Get(ITEM)
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetView> {
    return observeAssetRequest(this.metrics, ROUTE_ITEM, HTTP_OK, async () => {
      const view = await this.service.get(principalOfRequest(), id);
      reply.header('etag', view.etag);
      reply.header('cache-control', 'no-store');
      return view;
    });
  }

  @Patch(ITEM)
  async update(
    @Param('id') id: string,
    @ZodBody(UpdateAssetDto) body: UpdateAssetDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetView> {
    return observeAssetRequest(this.metrics, ROUTE_ITEM, HTTP_OK, async () => {
      const view = await this.service.update(principalOfRequest(), id, body, ifMatch);
      reply.header('etag', view.etag);
      return view;
    });
  }

  @Delete(ITEM)
  async remove(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetView> {
    return observeAssetRequest(this.metrics, ROUTE_ITEM, HTTP_OK, async () => {
      const retired = await this.service.remove(principalOfRequest(), id, ifMatch);
      reply.header('etag', retired.etag);
      return retired;
    });
  }
}
