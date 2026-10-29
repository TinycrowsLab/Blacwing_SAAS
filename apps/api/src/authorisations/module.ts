import { type DynamicModule, Module } from '@nestjs/common';

import { AuthorisationController } from './controller.js';
import { createAuthorisationMetrics } from './metrics.js';
import { createCedarSaPolicy, type SaPolicyEngine } from './policy.js';
import { AuthorisationService, type AuthorisationServiceDeps } from './service.js';
import { AUTHORISATION_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface AuthorisationModuleOptions extends Pick<
  AuthorisationServiceDeps,
  'store' | 'assets' | 'memberships' | 'cursors' | 'logger' | 'tracer'
> {
  /** Registry the `bw_authz_sa_submit_total` counter lives on. */
  readonly registry: Registry;
  /** The Cedar resource rules. Absent: the baseline policy set (`SA_POLICY_SET`). */
  readonly policy?: SaPolicyEngine;
}

/**
 * Mounts the standing-authorisation routes (AUTHZ-002). The store, the asset verifier and the memberships
 * are adapters of @blackwing/db in production; tests pass in-memory ones.
 */
@Module({})
export class AuthorisationModule {
  static forRoot(options: AuthorisationModuleOptions): DynamicModule {
    const service = new AuthorisationService({
      store: options.store,
      assets: options.assets,
      memberships: options.memberships,
      policy: options.policy ?? createCedarSaPolicy(),
      cursors: options.cursors,
      metrics: createAuthorisationMetrics(options.registry),
      logger: options.logger,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: AuthorisationModule,
      controllers: [AuthorisationController],
      providers: [{ provide: AUTHORISATION_SERVICE, useValue: service }],
    };
  }
}
