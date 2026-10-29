import { type DynamicModule, Module } from '@nestjs/common';

import { AssetListController } from './controller.js';
import { AssetListService, type AssetListServiceDeps } from './service.js';
import { ASSET_LIST_SERVICE } from './tokens.js';

export type AssetListModuleOptions = AssetListServiceDeps;

/**
 * Mounts `GET /v1/assets`. The store is the `AssetRepository` of @blackwing/db in a deployment, and the memberships
 * port is the tenant-scoped reader of RBAC-001. Mount it through `createApiApp({ imports })` under the global tenant guard.
 */
@Module({})
export class AssetListModule {
  static forRoot(options: AssetListModuleOptions): DynamicModule {
    const service = new AssetListService({
      store: options.store,
      memberships: options.memberships,
    });
    return {
      module: AssetListModule,
      controllers: [AssetListController],
      providers: [{ provide: ASSET_LIST_SERVICE, useValue: service }],
    };
  }
}
