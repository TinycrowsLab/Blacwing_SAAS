// DEMO-STORY Nest module. Mounted by ../run.ts only when BW_DEMO_MODE=1 (see demoModuleFor). Dev/demo only.
import { type DynamicModule, Logger, Module, type OnModuleInit, Inject } from '@nestjs/common';
import pg from 'pg';

import { DemoController } from './controller.js';
import { seedDemoStory } from './seed.js';
import { DemoService } from './service.js';
import { DemoStore } from './store.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';

import type { DemoConfig } from './config.js';

@Module({})
export class DemoModule implements OnModuleInit {
  constructor(
    @Inject(DEMO_CONFIG) private readonly config: DemoConfig,
    @Inject(DEMO_STORE) private readonly store: DemoStore,
  ) {}

  static forRoot(config: DemoConfig): DynamicModule {
    return {
      module: DemoModule,
      controllers: [DemoController],
      providers: [
        { provide: DEMO_CONFIG, useValue: config },
        {
          provide: DEMO_STORE,
          useFactory: () => new DemoStore(new pg.Pool({ connectionString: config.databaseUrl, max: 5 })),
        },
        {
          provide: DEMO_SERVICE,
          inject: [DEMO_STORE],
          useFactory: (store: DemoStore) => new DemoService(store, config.tenantId),
        },
      ],
    };
  }

  /** Idempotent: the lab asset and the fallback finished run (see ./seed.ts). Never throws into boot. */
  async onModuleInit(): Promise<void> {
    const log = new Logger('DemoModule');
    try {
      const actors = await this.resolveSeedActors();
      await seedDemoStory(this.store, this.config.tenantId, this.config.targetBaseUrl, actors, {
        info: (fields, message) => { log.log(`${message} ${JSON.stringify(fields)}`); },
        warn: (fields, message) => { log.warn(`${message} ${JSON.stringify(fields)}`); },
      });
    } catch (error) {
      log.error(`demo.seed.failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async resolveSeedActors(): Promise<{ requesterId: string; approverId: string } | null> {
    const requester = await this.store.findActiveUserByEmail('appsec@acme.test');
    const approver = await this.store.findActiveUserByEmail('owner@acme.test');
    if (requester === null || approver === null) return null;
    return { requesterId: requester.id, approverId: approver.id };
  }
}
