import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { TenantContextGuard, type TenantPrincipalSource } from './guard.js';
import { TenantContextInterceptor } from './interceptor.js';
import { createTenantContextMetrics } from './metrics.js';
import { API_TENANT_METRICS, API_TENANT_PRINCIPAL_SOURCE } from '../bootstrap/tokens.js';

import type { Registry } from 'prom-client';

export interface TenantContextModuleOptions {
  /** IAM's validated-principal lookup. */
  readonly principalSource: TenantPrincipalSource;
  /** Registry the `bw_tenant_context_missing_total` / `bw_cross_tenant_denied_total` counters live on. */
  readonly registry: Registry;
}

/** Installs the global tenant guard and interceptor (TENANT-003): every route not `@PublicRoute()` is tenant-scoped. */
@Global()
@Module({})
export class TenantContextModule {
  static forRoot(options: TenantContextModuleOptions): DynamicModule {
    return {
      module: TenantContextModule,
      providers: [
        { provide: API_TENANT_PRINCIPAL_SOURCE, useValue: options.principalSource },
        { provide: API_TENANT_METRICS, useValue: createTenantContextMetrics(options.registry) },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
      exports: [API_TENANT_METRICS],
    };
  }
}
