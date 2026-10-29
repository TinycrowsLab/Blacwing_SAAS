import { type DynamicModule, Module } from '@nestjs/common';

import { TestPlanController } from './controller.js';
import { createTestPlanMetrics } from './metrics.js';
import { TestPlanService, type TestPlanServiceDeps } from './service.js';
import { TEST_PLAN_SERVICE } from './tokens.js';

import type { Registry } from 'prom-client';

export interface TestPlanModuleOptions extends Pick<
  TestPlanServiceDeps,
  'store' | 'memberships' | 'logger' | 'tracer'
> {
  /** Registry the `test_plan_mutations_total` counter lives on. */
  readonly registry: Registry;
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
    return {
      module: TestPlanModule,
      controllers: [TestPlanController],
      providers: [{ provide: TEST_PLAN_SERVICE, useValue: service }],
    };
  }
}
