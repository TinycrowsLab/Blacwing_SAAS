import { Inject, Injectable } from '@nestjs/common';

import {
  API_CONFIG,
  API_HEALTH_METRICS,
  API_HEALTH_PROBES,
  API_LOGGER,
} from '../bootstrap/tokens.js';

import type { ApiConfig } from '../config.js';
import type {
  CheckError,
  CheckResult,
  HealthProbe,
  HealthReport,
  OverallStatus,
  ReadinessReport,
} from './health.types.js';
import type { Logger } from '@blackwing/logger';
import type { Gauge } from 'prom-client';

const MS_PER_SECOND = 1000;

export interface HealthMetrics {
  readonly status: Gauge<'dependency'>;
  readonly latency: Gauge<'dependency'>;
}

interface Cached {
  readonly at: number;
  readonly promise: Promise<HealthReport>;
}

class TimeoutSignal extends Error {}

function rollUp(
  probes: readonly HealthProbe[],
  checks: Readonly<Record<string, CheckResult>>,
): OverallStatus {
  let status: OverallStatus = 'ok';
  for (const probe of probes) {
    if (checks[probe.name]?.status === 'ok') continue;
    if (probe.critical) return 'down';
    status = 'degraded';
  }
  return status;
}

/**
 * Runs the dependency checks (API-011). Every check has its own timeout, results are shared for
 * `API_HEALTH_CACHE_MS`, and failures are reduced to stable codes so nothing about a dependency's
 * host, credentials or driver error reaches an unauthenticated caller.
 */
@Injectable()
export class HealthService {
  private draining = false;
  private cached: Cached | undefined;
  private readonly lastStatus = new Map<string, 'ok' | 'down'>();

  constructor(
    @Inject(API_CONFIG) private readonly config: Readonly<ApiConfig>,
    @Inject(API_LOGGER) private readonly logger: Logger,
    @Inject(API_HEALTH_PROBES) private readonly probes: readonly HealthProbe[],
    @Inject(API_HEALTH_METRICS) private readonly metrics: HealthMetrics,
  ) {}

  /** Flips readiness to 503 and liveness to draining. Called first thing on SIGTERM. */
  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Readiness: draining or any critical dependency down means not ready. */
  async readiness(): Promise<ReadinessReport> {
    const report = await this.report();
    const criticalDown = this.activeProbes().some(
      (probe) => probe.critical && report.checks[probe.name]?.status !== 'ok',
    );
    return { ready: !this.draining && !criticalDown, report };
  }

  /** Detailed report for `/health`. Draining always reads `down`. */
  async report(): Promise<HealthReport> {
    const now = performance.now();
    if (this.cached === undefined || now - this.cached.at >= this.config.API_HEALTH_CACHE_MS) {
      this.cached = { at: now, promise: this.run() };
    }
    const base = await this.cached.promise;
    return this.draining ? { ...base, status: 'down' } : base;
  }

  private activeProbes(): readonly HealthProbe[] {
    return this.probes.filter(
      (probe) => probe.name !== 'temporal' || this.config.API_HEALTH_CHECK_TEMPORAL,
    );
  }

  private async run(): Promise<HealthReport> {
    const probes = this.activeProbes();
    const results = await Promise.all(probes.map((probe) => this.runOne(probe)));
    const checks: Record<string, CheckResult> = {};
    probes.forEach((probe, index) => {
      const result = results[index];
      if (result !== undefined) checks[probe.name] = result;
    });
    return {
      status: rollUp(probes, checks),
      checks,
      version: this.config.API_VERSION,
      commit: this.config.API_COMMIT,
    };
  }

  private async runOne(probe: HealthProbe): Promise<CheckResult> {
    const started = performance.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let error: CheckError | undefined;
    try {
      await Promise.race([
        probe.check(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TimeoutSignal());
          }, this.config.API_HEALTH_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (caught) {
      error = caught instanceof TimeoutSignal ? 'timeout' : 'unreachable';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const latencyMs = Math.round(performance.now() - started);
    const result: CheckResult =
      error === undefined ? { status: 'ok', latencyMs } : { status: 'down', latencyMs, error };
    this.record(probe, result);
    return result;
  }

  private record(probe: HealthProbe, result: CheckResult): void {
    this.metrics.status.set({ dependency: probe.name }, result.status === 'ok' ? 1 : 0);
    this.metrics.latency.set({ dependency: probe.name }, result.latencyMs / MS_PER_SECOND);
    const previous = this.lastStatus.get(probe.name);
    this.lastStatus.set(probe.name, result.status);
    if (previous === result.status || (previous === undefined && result.status === 'ok')) return;
    this.logger.warn(
      {
        dependency: probe.name,
        from: previous ?? 'unknown',
        to: result.status,
        error: result.error ?? null,
      },
      'api.health.transition',
    );
  }
}
