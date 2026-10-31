import { Counter, Gauge, Registry } from 'prom-client';

export interface ControllerMetrics {
  readonly registry: Registry;
  /** 1 while the process serves; 0 once draining. */
  readonly up: Gauge;
  /** 1 while `/readyz` is 200. */
  readonly ready: Gauge;
  readonly buildInfo: Gauge<'version' | 'commit'>;
  /** Rejected run tokens, by bounded reason code (never the token). */
  readonly authFailures: Counter<'reason'>;
  /** Run CAs issued (SANDBOX-008). Counted once per new CA; idempotent re-reads do not count. */
  readonly caIssued: Counter;
  /** Run CAs revoked (SANDBOX-008). Counted only when a CA was actually stored and then deleted. */
  readonly caRevoked: Counter;
  /** Run NetworkPolicy applies by outcome (`applied`, `failed`, `unsupported`), SANDBOX-005. */
  readonly netpolApply: Counter<'result'>;
  /** Run input stagings by outcome (`staged`, `failed`), INGEST/SANDBOX input stager. */
  readonly inputsStaged: Counter<'result'>;
  /** Bytes of source checked out for runs (after the shallow checkout, before read-only). */
  readonly sourceBytes: Counter;
}

/** A private registry per instance, so tests and multiple instances never share series. */
export function createControllerMetrics(version: string, commit: string): ControllerMetrics {
  const registry = new Registry();
  const metrics: ControllerMetrics = {
    registry,
    up: new Gauge({
      name: 'sbx_up',
      help: 'Sandbox controller is serving.',
      registers: [registry],
    }),
    ready: new Gauge({
      name: 'sbx_ready',
      help: 'Sandbox controller is ready (config valid, driver and Valkey reachable).',
      registers: [registry],
    }),
    buildInfo: new Gauge({
      name: 'sbx_build_info',
      help: 'Sandbox controller build; the value is always 1.',
      labelNames: ['version', 'commit'],
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'sbx_auth_failures_total',
      help: 'Internal API requests refused for a missing or invalid run-scoped token.',
      labelNames: ['reason'],
      registers: [registry],
    }),
    caIssued: new Counter({
      name: 'sbx_ca_issued_total',
      help: 'Per-run MITM CAs issued.',
      registers: [registry],
    }),
    caRevoked: new Counter({
      name: 'sbx_ca_revoked_total',
      help: 'Per-run MITM CAs revoked (key deleted).',
      registers: [registry],
    }),
    netpolApply: new Counter({
      name: 'sbx_netpol_apply_total',
      help: 'Run NetworkPolicy applies, by result.',
      labelNames: ['result'],
      registers: [registry],
    }),
    inputsStaged: new Counter({
      name: 'sbx_inputs_staged_total',
      help: 'Run input stagings, by result.',
      labelNames: ['result'],
      registers: [registry],
    }),
    sourceBytes: new Counter({
      name: 'sbx_source_bytes',
      help: 'Bytes of source checked out for runs.',
      registers: [registry],
    }),
  };
  metrics.up.set(0);
  metrics.ready.set(0);
  metrics.buildInfo.labels({ version, commit }).set(1);
  return metrics;
}
