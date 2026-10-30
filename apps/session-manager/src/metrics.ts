import { Counter, Gauge, Registry } from 'prom-client';

export interface SessionManagerMetrics {
  readonly registry: Registry;
  /** 1 while the process serves; 0 once draining. */
  readonly up: Gauge;
  /** 1 while `/readyz` is 200. */
  readonly ready: Gauge;
  readonly buildInfo: Gauge<'version' | 'commit'>;
  /** Rejected tokens, by bounded reason code (never the token). */
  readonly authFailures: Counter<'reason'>;
}

/** A private registry per instance, so tests and multiple instances never share series. */
export function createSessionManagerMetrics(
  version: string,
  commit: string,
): SessionManagerMetrics {
  const registry = new Registry();
  const metrics: SessionManagerMetrics = {
    registry,
    up: new Gauge({
      name: 'sm_up',
      help: 'Session manager is serving.',
      registers: [registry],
    }),
    ready: new Gauge({
      name: 'sm_ready',
      help: 'Session manager is ready (config valid, PostgreSQL, Valkey and OpenBao reachable).',
      registers: [registry],
    }),
    buildInfo: new Gauge({
      name: 'sm_build_info',
      help: 'Session manager build; the value is always 1.',
      labelNames: ['version', 'commit'],
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'sm_auth_failures_total',
      help: 'Internal API requests refused for a missing or invalid token.',
      labelNames: ['reason'],
      registers: [registry],
    }),
  };
  metrics.up.set(0);
  metrics.ready.set(0);
  metrics.buildInfo.labels({ version, commit }).set(1);
  return metrics;
}
