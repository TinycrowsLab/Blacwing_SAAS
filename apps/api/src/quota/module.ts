import { type DynamicModule, Module } from '@nestjs/common';

import { QuotaController } from './controller.js';
import { createQuotaMetrics } from './metrics.js';
import { QuotaService } from './service.js';
import { QUOTA_SERVICE } from './tokens.js';

import type { Database } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

export interface QuotaModuleOptions {
  /** The app role's database handle. Every quota query runs under `withTenant`. */
  readonly database: Database;
  /** The API's metrics registry, so `bw_quota_exceeded_total` appears on `/metrics`. */
  readonly registry: Registry;
  readonly logger: Pick<Logger, 'info'>;
}

/**
 * The plan-quota module (TENANT-009): `GET /v1/tenant/quotas`, and the service the creation points enforce through
 * (assets now; invitations and runs when their endpoints land). Mount it through `createApiApp({ imports })` under
 * the global tenant guard, like the other tenant modules.
 */
@Module({ controllers: [QuotaController] })
export class QuotaModule {
  static forRoot(options: QuotaModuleOptions): DynamicModule {
    return {
      module: QuotaModule,
      providers: [
        {
          provide: QUOTA_SERVICE,
          useFactory: () =>
            new QuotaService({
              database: options.database,
              metrics: createQuotaMetrics(options.registry),
              logger: options.logger,
            }),
        },
      ],
      exports: [QUOTA_SERVICE],
    };
  }
}
