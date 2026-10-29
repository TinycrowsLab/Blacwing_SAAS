import { type DynamicModule, Module } from '@nestjs/common';

import { AssessmentRequestController } from './controller.js';
import { createAssessmentRequestMetrics } from './metrics.js';
import { AssessmentRequestService, type AssessmentRequestServiceDeps } from './service.js';
import { ASSESSMENT_REQUEST_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface AssessmentRequestModuleOptions extends Pick<
  AssessmentRequestServiceDeps,
  | 'store'
  | 'assets'
  | 'standingAuthorisations'
  | 'memberships'
  | 'halts'
  | 'logger'
  | 'tracer'
  | 'now'
> {
  /** Registry the scoping-form counters live on. */
  readonly registry: Registry;
}

/**
 * Mounts the assessment-request routes (SCOPE-005). The store is the `AssessmentRequestRepository` of @blackwing/db
 * in a deployment; the asset, standing-authorisation, membership and kill-state ports are the tenant-scoped readers
 * of their owning modules. Mount it through `createApiApp({ imports })` under the global tenant guard.
 */
@Module({})
export class AssessmentRequestModule {
  static forRoot(options: AssessmentRequestModuleOptions): DynamicModule {
    const service = new AssessmentRequestService({
      store: options.store,
      assets: options.assets,
      standingAuthorisations: options.standingAuthorisations,
      memberships: options.memberships,
      halts: options.halts,
      logger: options.logger,
      metrics: createAssessmentRequestMetrics(options.registry),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      module: AssessmentRequestModule,
      controllers: [AssessmentRequestController],
      providers: [{ provide: ASSESSMENT_REQUEST_SERVICE, useValue: service }],
    };
  }
}
