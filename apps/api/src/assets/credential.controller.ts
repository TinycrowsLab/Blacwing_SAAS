import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';

import { type AssetMetrics, observeAssetRequest } from './metrics.js';
import { principalOfRequest } from './principal.js';
import { ASSET_CREDENTIAL_SERVICE, ASSET_METRICS } from './tokens.js';

import type { AssetCredentialService } from './credential-service.js';
import type {
  AssetCredentialListResponse,
  AssetCredentialRotationView,
  AssetCredentialView,
} from '@blackwing/contracts';
import type { FastifyReply } from 'fastify';

const HTTP_OK = 200;
const HTTP_CREATED = 201;

// Route templates are the served paths (the `/v1` prefix is applied by the bootstrap); they label the metrics.
const ROUTE_COLLECTION = '/v1/assets/:id/credentials';
const ROUTE_ITEM = '/v1/assets/:id/credentials/:role';
const ROUTE_ROTATE = '/v1/assets/:id/credentials/:role/rotate';

/**
 * REST surface of asset login credentials (#363): `GET|POST /v1/assets/:id/credentials`,
 * `GET /v1/assets/:id/credentials/:role` and `POST /v1/assets/:id/credentials/:role/rotate`. The body is not parsed by
 * a DTO pipe: the service refuses an oversized recipe (`413`) before it validates the rest (`422`), and the secret
 * values reach only the service. Responses carry the recipe and the `secretRef`, never a secret value.
 */
@Controller('assets')
export class AssetCredentialsController {
  constructor(
    @Inject(ASSET_CREDENTIAL_SERVICE) private readonly service: AssetCredentialService,
    @Inject(ASSET_METRICS) private readonly metrics: AssetMetrics,
  ) {}

  @Get(':id/credentials')
  async list(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetCredentialListResponse> {
    return observeAssetRequest(this.metrics, ROUTE_COLLECTION, HTTP_OK, async () => {
      const page = await this.service.list(principalOfRequest(), id);
      reply.header('cache-control', 'no-store');
      return page;
    });
  }

  @Post(':id/credentials')
  async create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetCredentialView> {
    return observeAssetRequest(this.metrics, ROUTE_COLLECTION, HTTP_CREATED, async () => {
      const view = await this.service.create(principalOfRequest(), id, body);
      reply.status(HTTP_CREATED);
      reply.header('cache-control', 'no-store');
      reply.header('location', `/v1/assets/${id}/credentials/${encodeURIComponent(view.roleName)}`);
      return view;
    });
  }

  @Get(':id/credentials/:role')
  async get(
    @Param('id') id: string,
    @Param('role') role: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetCredentialView> {
    return observeAssetRequest(this.metrics, ROUTE_ITEM, HTTP_OK, async () => {
      const view = await this.service.get(principalOfRequest(), id, role);
      reply.header('cache-control', 'no-store');
      return view;
    });
  }

  @Post(':id/credentials/:role/rotate')
  @HttpCode(HTTP_OK)
  async rotate(
    @Param('id') id: string,
    @Param('role') role: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetCredentialRotationView> {
    return observeAssetRequest(this.metrics, ROUTE_ROTATE, HTTP_OK, async () => {
      const view = await this.service.rotate(principalOfRequest(), id, role, body);
      reply.header('cache-control', 'no-store');
      return view;
    });
  }
}
