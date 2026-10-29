// DEMO-STORY public surface of the API demo module (mounted only when BW_DEMO_MODE=1).
import { loadDemoConfig } from './config.js';
import { DemoModule } from './module.js';

import type { EnvSource } from '@blackwing/config';
import type { DynamicModule } from '@nestjs/common';

/** The demo module when BW_DEMO_MODE=1, else nothing (the demo routes are then not mounted at all). */
export function demoModuleFor(source?: EnvSource): DynamicModule[] {
  const config = loadDemoConfig(source);
  return config.enabled ? [DemoModule.forRoot(config)] : [];
}

export { DemoModule } from './module.js';
