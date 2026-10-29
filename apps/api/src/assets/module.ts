import { type DynamicModule, Module } from '@nestjs/common';

import { AssetRepository as AssetListReader, type Database } from '@blackwing/db';

import { AssetsController } from './controller.js';
import { createAssetMetrics, type AssetMetrics } from './metrics.js';
import { createCedarAssetPolicy } from './policy.js';
import { AssetRepository } from './repository.js';
import { AssetService } from './service.js';
import { ASSET_METRICS, ASSET_SERVICE } from './tokens.js';
import { API_LOGGER } from '../bootstrap/tokens.js';

import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

export interface AssetsModuleOptions {
  /** The app role's database handle (`createDatabase(pool)`). Every query runs under `withTenant`. */
  readonly database: Database;
  /** The API's metrics registry, so the asset counters appear on `/metrics`. */
  readonly registry: Registry;
}

/**
 * The asset registry module (ASSET-002): `/v1/assets`. Mounted by the API bootstrap through
 * `createApiApp({ imports: [AssetsModule.forRoot(...)] })`; it needs the tenant guard (`tenantPrincipalSource`)
 * to be installed, otherwise every route answers 401 (fail closed).
 */
@Module({ controllers: [AssetsController] })
export class AssetsModule {
  static forRoot(options: AssetsModuleOptions): DynamicModule {
    return {
      module: AssetsModule,
      providers: [
        {
          provide: ASSET_METRICS,
          useFactory: (): AssetMetrics => createAssetMetrics(options.registry),
        },
        {
          provide: ASSET_SERVICE,
          inject: [ASSET_METRICS, API_LOGGER],
          useFactory: (metrics: AssetMetrics, logger: Logger) =>
            new AssetService({
              repository: new AssetRepository({ db: options.database }),
              projections: new AssetListReader({ db: options.database }),
              policy: createCedarAssetPolicy(),
              metrics,
              logger,
            }),
        },
      ],
    };
  }
}
