import { type DynamicModule, Module } from '@nestjs/common';

import { TenantSettingsController } from './controller.js';
import { createTenantSettingsMetrics } from './metrics.js';
import { TenantSettingsService, type TenantSettingsServiceDeps } from './service.js';
import { TENANT_SETTINGS_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface TenantSettingsModuleOptions extends Pick<
  TenantSettingsServiceDeps,
  'store' | 'memberships' | 'logger' | 'tracer'
> {
  /** Registry the `bw_tenant_settings_updated_total` counter lives on. */
  readonly registry: Registry;
}

/**
 * Mounts the settings routes. The store and memberships are the Postgres adapters of @blackwing/db in a
 * deployment; tests pass fakes. Mount it through `createApiApp({ imports })` under the global tenant guard.
 */
@Module({})
export class TenantSettingsModule {
  static forRoot(options: TenantSettingsModuleOptions): DynamicModule {
    const service = new TenantSettingsService({
      store: options.store,
      memberships: options.memberships,
      logger: options.logger,
      metrics: createTenantSettingsMetrics(options.registry),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: TenantSettingsModule,
      controllers: [TenantSettingsController],
      providers: [{ provide: TENANT_SETTINGS_SERVICE, useValue: service }],
    };
  }
}
