import { type DynamicModule, Global, Module } from '@nestjs/common';
import { Gauge, type Registry } from 'prom-client';

import { HealthController } from './health.controller.js';
import { HealthService, type HealthMetrics } from './health.service.js';
import { API_HEALTH_METRICS, API_HEALTH_PROBES } from '../bootstrap/tokens.js';

import type { HealthProbe } from './health.types.js';

export interface HealthModuleOptions {
  readonly registry: Registry;
  /** Dependency probes (see `postgresProbe`, `valkeyProbe`, `temporalProbe`). */
  readonly probes?: readonly HealthProbe[];
}

/** `health_check_status` / `health_check_latency_seconds` on the app's registry. */
export function createHealthMetrics(registry: Registry): HealthMetrics {
  return {
    status: new Gauge({
      name: 'health_check_status',
      help: 'Last health check result per dependency: 1 ok, 0 down.',
      labelNames: ['dependency'],
      registers: [registry],
    }),
    latency: new Gauge({
      name: 'health_check_latency_seconds',
      help: 'Latency of the last health check per dependency, in seconds.',
      labelNames: ['dependency'],
      registers: [registry],
    }),
  };
}

@Global()
@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: API_HEALTH_PROBES, useValue: options.probes ?? [] },
        { provide: API_HEALTH_METRICS, useValue: createHealthMetrics(options.registry) },
        HealthService,
      ],
      exports: [HealthService],
    };
  }
}
