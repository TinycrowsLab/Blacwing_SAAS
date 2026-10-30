import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import {
  type AssetVerificationView,
  startVerificationBodySchema,
  type StartVerificationBody,
} from '@blackwing/contracts';

import { observeAssetRequest, type AssetMetrics } from './metrics.js';
import { principalOfRequest } from './principal.js';
import { ASSET_METRICS, ASSET_VERIFICATION_SERVICE } from './tokens.js';
import { createZodDto } from '../validation/zod-dto.js';
import { ZodBody } from '../validation/zod-validation.pipe.js';

import type { AssetVerificationService } from './verification-service.js';

class StartVerificationDto extends createZodDto(startVerificationBodySchema) {}

// Decorator paths are relative to the global `/v1` prefix; metric labels are the served route templates.
const VERIFICATION = ':id/verification';
const CHECK = ':id/verification/check';
const ROUTE_VERIFICATION = '/v1/assets/:id/verification';
const ROUTE_CHECK = '/v1/assets/:id/verification/check';
const HTTP_OK = 200;
const HTTP_CREATED = 201;

/**
 * REST surface of ownership verification (ASSET-003, CONTEXT_PACK §8.10): `GET|POST|DELETE /v1/assets/:id/verification`
 * and `POST /v1/assets/:id/verification/check`. Thin, like the asset controller: parse, resolve the principal, call the
 * service, shape the answer. Errors are problem+json through the global filter.
 */
@Controller('assets')
export class AssetVerificationController {
  constructor(
    @Inject(ASSET_VERIFICATION_SERVICE) private readonly service: AssetVerificationService,
    @Inject(ASSET_METRICS) private readonly metrics: AssetMetrics,
  ) {}

  /** The state and the latest challenge (its token included). Never cached: it changes with every probe run. */
  @Get(VERIFICATION)
  async get(@Param('id') id: string): Promise<AssetVerificationView> {
    return observeAssetRequest(this.metrics, ROUTE_VERIFICATION, HTTP_OK, () =>
      this.service.get(principalOfRequest(), id),
    );
  }

  /** Starts (or restarts) verification and issues a challenge token: `201`. */
  @Post(VERIFICATION)
  async start(
    @Param('id') id: string,
    @ZodBody(StartVerificationDto) body: StartVerificationBody,
  ): Promise<AssetVerificationView> {
    return observeAssetRequest(this.metrics, ROUTE_VERIFICATION, HTTP_CREATED, () =>
      this.service.start(principalOfRequest(), id, body),
    );
  }

  /** Runs one probe against the open challenge and answers the state after it. */
  @Post(CHECK)
  @HttpCode(HTTP_OK)
  async check(@Param('id') id: string): Promise<AssetVerificationView> {
    return observeAssetRequest(this.metrics, ROUTE_CHECK, HTTP_OK, () =>
      this.service.check(principalOfRequest(), id),
    );
  }

  /** Cancels the open challenge; the asset is unverified again. */
  @Delete(VERIFICATION)
  async cancel(@Param('id') id: string): Promise<AssetVerificationView> {
    return observeAssetRequest(this.metrics, ROUTE_VERIFICATION, HTTP_OK, () =>
      this.service.cancel(principalOfRequest(), id),
    );
  }
}
