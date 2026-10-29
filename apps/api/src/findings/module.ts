import { type DynamicModule, Module } from '@nestjs/common';

import { FindingController } from './controller.js';
import { createFindingMetrics } from './metrics.js';
import { createCedarFindingPolicy, type FindingPolicyEngine } from './policy.js';
import { FindingService } from './service.js';
import { FINDING_SERVICE } from './tokens.js';
import { createCursorCodec } from '../pagination/index.js';

import type { FindingMemberships, FindingStore } from './ports.js';
import type { Logger } from '@blackwing/logger';
import type { Tracer } from '@opentelemetry/api';
import type { Registry } from 'prom-client';

export interface FindingModuleOptions {
  /** The finding persistence: `FindingRepository` of @blackwing/db in a deployment. */
  readonly store: FindingStore;
  readonly memberships: FindingMemberships;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
  /** Registry the `finding_api_requests_total` counter lives on. */
  readonly registry: Registry;
  /** HMAC key of the list cursors (`API_CURSOR_SECRET`). Absent or short: mounting fails (fail closed). */
  readonly cursorSecret: string | undefined;
  /** The Cedar resource rules. Absent: the baseline policy set (`FINDING_POLICY_SET`). */
  readonly policy?: FindingPolicyEngine;
}

/**
 * Mounts the finding query routes. Mount through `createApiApp({ imports })` under the global tenant guard, so
 * every route runs inside the caller's tenant context and RLS applies to the store.
 */
@Module({})
export class FindingModule {
  static forRoot(options: FindingModuleOptions): DynamicModule {
    const service = new FindingService({
      store: options.store,
      memberships: options.memberships,
      policy: options.policy ?? createCedarFindingPolicy(),
      cursors: createCursorCodec(options.cursorSecret),
      metrics: createFindingMetrics(options.registry),
      logger: options.logger,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    return {
      module: FindingModule,
      controllers: [FindingController],
      providers: [{ provide: FINDING_SERVICE, useValue: service }],
    };
  }
}
