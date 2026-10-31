import { type DynamicModule, Module } from '@nestjs/common';

import { TriageController } from './controller.js';
import { createTriageMetrics } from './metrics.js';
import { TriageService, type TriageServiceDeps } from './service.js';
import { TRIAGE_SERVICE } from './tokens.js';

import type { TriageStore } from './ports.js';
import type { FindingMemberships } from '../findings/ports.js';
import type { FindingService } from '../findings/service.js';
import type { Logger } from '@blackwing/logger';
import type { Tracer } from '@opentelemetry/api';
import type { Registry } from 'prom-client';

export interface TriageModuleOptions {
  /** The Gate 3 persistence: `FindingTriageRepository` of @blackwing/db in a deployment. */
  readonly store: TriageStore;
  /** The finding read service the decisions authorise through (FINDING-001). */
  readonly findings: FindingService;
  readonly memberships: FindingMemberships;
  readonly logger: Pick<Logger, 'info'>;
  /** Registry the `triage_decision_total` and `triage_decision_ms` metrics live on. */
  readonly registry: Registry;
  readonly now?: () => Date;
  readonly tracer?: Tracer;
  /** The TRIAGE-004 separation-of-duties hook for releases (see `TriageServiceDeps.assertReleaseActor`). */
  readonly assertReleaseActor?: TriageServiceDeps['assertReleaseActor'];
}

/**
 * Mounts the Gate 3 decision routes (TRIAGE-004). Mount through `createApiApp({ imports })` under the global tenant guard
 * and the idempotency module, so every route runs inside the caller's tenant context.
 */
@Module({})
export class TriageModule {
  static forRoot(options: TriageModuleOptions): DynamicModule {
    const service = new TriageService({
      store: options.store,
      findings: options.findings,
      memberships: options.memberships,
      metrics: createTriageMetrics(options.registry),
      logger: options.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
      ...(options.assertReleaseActor === undefined
        ? {}
        : { assertReleaseActor: options.assertReleaseActor }),
    });
    return {
      module: TriageModule,
      controllers: [TriageController],
      providers: [{ provide: TRIAGE_SERVICE, useValue: service }],
    };
  }
}
