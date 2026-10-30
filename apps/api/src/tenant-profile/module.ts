import { type DynamicModule, Module } from '@nestjs/common';

import { TenantProfileController } from './controller.js';
import { createTenantProfileMetrics } from './metrics.js';
import { TenantProfileService, type TenantProfileServiceDeps } from './service.js';
import { TENANT_PROFILE_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface TenantProfileModuleOptions extends Pick<
  TenantProfileServiceDeps,
  'store' | 'memberships' | 'logger' | 'tracer'
> {
  /** Registry the `bw_settings_save_total` counter lives on. */
  readonly registry: Registry;
}

/**
 * Mounts the organisation profile routes (`/v1/tenants/current`). The store and memberships are the Postgres
 * adapters of @blackwing/db in a deployment; tests pass fakes. Mount it through `createApiApp({ imports })`
 * under the global tenant guard.
 */
@Module({})
export class TenantProfileModule {
  static forRoot(options: TenantProfileModuleOptions): DynamicModule {
    const service = new TenantProfileService({
      store: options.store,
      memberships: options.memberships,
      logger: options.logger,
      metrics: createTenantProfileMetrics(options.registry),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: TenantProfileModule,
      controllers: [TenantProfileController],
      providers: [{ provide: TENANT_PROFILE_SERVICE, useValue: service }],
    };
  }
}
