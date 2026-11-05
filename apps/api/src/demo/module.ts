// DEMO-STORY Nest module. Mounted by ../run.ts only when BW_DEMO_MODE=1 (see demoModuleFor). Dev/demo only.
import { type DynamicModule, Module } from '@nestjs/common';
import pg from 'pg';

import { DemoController } from './controller.js';
import { DemoService } from './service.js';
import { DemoStore } from './store.js';
import { DEMO_CONFIG, DEMO_SERVICE, DEMO_STORE } from './tokens.js';

import type { DemoConfig } from './config.js';

@Module({})
export class DemoModule {
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
          useFactory: (store: DemoStore) => new DemoService(store, config.tenantId, fetch, {
              webhookUrl: config.webhookUrl,
              consoleOrigin: config.consoleOrigin,
            }),
        },
      ],
    };
  }
}
