import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { TenantContextGuard, type TenantPrincipalSource } from './guard.js';
import { TenantContextInterceptor } from './interceptor.js';
import { createTenantContextMetrics } from './metrics.js';
import {
  API_RBAC_METRICS,
  API_TENANT_METRICS,
  API_TENANT_PRINCIPAL_SOURCE,
} from '../bootstrap/tokens.js';
import { createRbacMetrics } from '../rbac/metrics.js';
import { PermissionGuard } from '../rbac/permission.guard.js';

import type { Registry } from 'prom-client';

export interface TenantContextModuleOptions {
  /** IAM's validated-principal lookup. */
  readonly principalSource: TenantPrincipalSource;
  /** Registry the `bw_tenant_context_missing_total` / `bw_cross_tenant_denied_total` counters live on. */
  readonly registry: Registry;
}

/**
 * Installs the global tenant guard, the RBAC permission guard and the tenant interceptor (TENANT-003,
 * RBAC-003): every route not `@PublicRoute()` is tenant-scoped and permission-checked. The guards are
 * registered in this order, and that order is the contract: the permission guard reads the principal the
 * tenant guard validated.
 */
@Global()
@Module({})
export class TenantContextModule {
  static forRoot(options: TenantContextModuleOptions): DynamicModule {
    return {
      module: TenantContextModule,
      providers: [
        { provide: API_TENANT_PRINCIPAL_SOURCE, useValue: options.principalSource },
        { provide: API_TENANT_METRICS, useValue: createTenantContextMetrics(options.registry) },
        { provide: API_RBAC_METRICS, useValue: createRbacMetrics(options.registry) },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
      exports: [API_TENANT_METRICS],
    };
  }
}
