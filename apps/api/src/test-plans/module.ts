import { type DynamicModule, Module } from '@nestjs/common';

import { TestPlanController } from './controller.js';
import { createTestPlanMetrics } from './metrics.js';
import { TestPlanService, type TestPlanServiceDeps } from './service.js';
import { PLAN_VALIDATION_SERVICE, TEST_PLAN_SERVICE } from './tokens.js';
import { createPlanValidationMetrics } from './validation/metrics.js';
import { createCedarPlanPolicy, type PlanPolicyEngine } from './validation/policy.js';
import { PlanValidationService } from './validation/service.js';

import type { PlanValidationStore } from './validation/ports.js';
import type { Registry } from 'prom-client';

export interface TestPlanModuleOptions extends Pick<
  TestPlanServiceDeps,
  'store' | 'memberships' | 'logger' | 'tracer'
> {
  /** Registry the `test_plan_mutations_total` and plan validation counters live on. */
  readonly registry: Registry;
  /** The validation read model and audit write (`PlanValidationRepository` in a deployment). */
  readonly planValidation: PlanValidationStore;
  /** The plan policy engine. Defaults to the platform Cedar plan policy. */
  readonly policy?: PlanPolicyEngine;
}

/**
 * Mounts the test plan routes under the global tenant guard (`createApiApp({ imports })`). The store is the
 * Postgres adapter `TestPlanRepository` (@blackwing/db) in a deployment; tests pass a fake.
 */
@Module({})
export class TestPlanModule {
  static forRoot(options: TestPlanModuleOptions): DynamicModule {
    const service = new TestPlanService({
      store: options.store,
      memberships: options.memberships,
      logger: options.logger,
      metrics: createTestPlanMetrics(options.registry),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    const validation = new PlanValidationService({
      store: options.planValidation,
      memberships: options.memberships,
      policy: options.policy ?? createCedarPlanPolicy(),
      metrics: createPlanValidationMetrics(options.registry),
      logger: options.logger,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: TestPlanModule,
      controllers: [TestPlanController],
      providers: [
        { provide: TEST_PLAN_SERVICE, useValue: service },
        { provide: PLAN_VALIDATION_SERVICE, useValue: validation },
      ],
    };
  }
}
