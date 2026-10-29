import { type DynamicModule, Module } from '@nestjs/common';

import { AuthorisationController, type AuthEvidenceSource } from './controller.js';
import { createAuthorisationMetrics } from './metrics.js';
import { createCedarSaPolicy, type SaPolicyEngine } from './policy.js';
import { AuthorisationService, type AuthorisationServiceDeps } from './service.js';
import { DEFAULT_STEPUP_POLICY } from './step-up.js';
import { AUTHORISATION_EVIDENCE, AUTHORISATION_SERVICE } from './tokens.js';
import { authEvidenceOf } from '../auth/guard.js';

import type { Registry } from 'prom-client';

export interface AuthorisationModuleOptions extends Pick<
  AuthorisationServiceDeps,
  'store' | 'assets' | 'memberships' | 'cursors' | 'logger' | 'tracer' | 'signer'
> {
  /** Registry the `bw_authz_sa_submit_total` and `bw_authz_sa_approvals_total` counters live on. */
  readonly registry: Registry;
  /** The Cedar resource rules. Absent: the baseline policy set (`SA_POLICY_SET`). */
  readonly policy?: SaPolicyEngine;
  /** The approval step-up requirement. Absent: 300 seconds and the realm's strong `acr`. */
  readonly stepUp?: AuthorisationServiceDeps['stepUp'];
  /** Where a request's step-up evidence comes from. Absent: the validated principal the auth guard attached. */
  readonly evidence?: AuthEvidenceSource;
  readonly now?: () => number;
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
      signer: options.signer,
      stepUp: options.stepUp ?? DEFAULT_STEPUP_POLICY,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: AuthorisationModule,
      controllers: [AuthorisationController],
      providers: [
        { provide: AUTHORISATION_SERVICE, useValue: service },
        { provide: AUTHORISATION_EVIDENCE, useValue: options.evidence ?? authEvidenceOf },
      ],
    };
  }
}
