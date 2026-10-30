// The service-account feature module (RBAC-005). The composition root supplies the store (the repository,
// built over the app `Database` and the audit emitter) and the role resolver (IAM membership). Without a
// role resolver every caller holds no roles, so every route is `FORBIDDEN` (fail closed).

import { type DynamicModule, Module } from '@nestjs/common';

import { ServiceAccountsController } from './controller.js';
import { createServiceAccountMetrics } from './service-account-metrics.js';
import {
  ServiceAccountService,
  type RoleResolver,
  type ServiceAccountLogger,
  type ServiceAccountStore,
} from './service.js';
import { SERVICE_ACCOUNT_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface ServiceAccountsModuleOptions {
  readonly store: ServiceAccountStore;
  /** Defaults to "no roles" (every request is denied). */
  readonly roles?: RoleResolver;
  readonly logger?: ServiceAccountLogger;
  /** Registry the `service_accounts_active` gauge lives on. Absent: no gauge. */
  readonly registry?: Registry;
}

const NO_ROLES: RoleResolver = () => Promise.resolve([]);

@Module({})
export class ServiceAccountsModule {
  static forRoot(options: ServiceAccountsModuleOptions): DynamicModule {
    const service = new ServiceAccountService({
      store: options.store,
      roles: options.roles ?? NO_ROLES,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.registry === undefined
        ? {}
        : { metrics: createServiceAccountMetrics(options.registry) }),
    });
    return {
      module: ServiceAccountsModule,
      controllers: [ServiceAccountsController],
      providers: [{ provide: SERVICE_ACCOUNT_SERVICE, useValue: service }],
      exports: [SERVICE_ACCOUNT_SERVICE],
    };
  }
}
