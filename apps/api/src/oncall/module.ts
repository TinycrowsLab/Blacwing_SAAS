import { type DynamicModule, Module } from '@nestjs/common';

import { OncallController } from './controller.js';
import { createOncallMetrics } from './metrics.js';
import {
  PostgresOncallAuditSink,
  PostgresOncallMemberships,
  PostgresOncallStore,
} from './postgres.js';
import { OncallService } from './service.js';
import { ONCALL_MEMBERSHIPS, ONCALL_SERVICE } from './tokens.js';
import { API_LOGGER } from '../bootstrap/tokens.js';

import type { OncallExceptionReader } from './ports.js';
import type { Database } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

export interface OncallModuleOptions {
  /** The app role's database handle (`createDatabase(pool)`). Every query runs under `withTenant`. */
  readonly database: Database;
  /** The API's metrics registry, so the on-call counters appear on `/metrics`. */
  readonly registry: Registry;
  /** Logger for the resolver (`oncall.resolve`, `oncall.sod_skipped`). Defaults to the API logger. */
  readonly logger?: Logger;
  /** The Gate 2 exception reader (GATE2-001). Absent, escalation-step lookups fail loudly, never allow. */
  readonly exceptions?: OncallExceptionReader;
}

/** Until GATE2-001 wires the exception store, a step lookup refuses: it never answers "no approver, allow". */
const UNWIRED_EXCEPTIONS: OncallExceptionReader = {
  get: () => Promise.reject(new Error('gate 2 exception reader is not wired (GATE2-001)')),
};

/**
 * The Gate 2 on-call roster module (GATE2-003): `/v1/oncall/rosters`, Org Admin to write. Mounted by the
 * API bootstrap through `createApiApp({ imports: [OncallModule.forRoot(...)] })`; it needs the tenant guard
 * to be installed, otherwise every route answers 401 (fail closed).
 */
@Module({ controllers: [OncallController] })
export class OncallModule {
  static forRoot(options: OncallModuleOptions): DynamicModule {
    return {
      module: OncallModule,
      providers: [
        {
          provide: ONCALL_MEMBERSHIPS,
          useValue: new PostgresOncallMemberships(options.database),
        },
        {
          provide: ONCALL_SERVICE,
          inject: [API_LOGGER],
          useFactory: (logger: Logger) =>
            new OncallService({
              store: new PostgresOncallStore(options.database),
              exceptions: options.exceptions ?? UNWIRED_EXCEPTIONS,
              audit: new PostgresOncallAuditSink(options.database),
              logger: options.logger ?? logger,
              metrics: createOncallMetrics(options.registry),
            }),
        },
      ],
    };
  }
}
