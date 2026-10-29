import { Counter, Histogram, type Registry } from 'prom-client';

/** Recon metrics (RECON-007 observability); register them once per registry, next to the tool metrics. */
export interface ReconMetrics {
  /** `recon_services_discovered_total`. */
  readonly servicesDiscovered: Counter;
  /** `recon_ports_scanned_total`. */
  readonly portsScanned: Counter;
}

export function createReconMetrics(registry: Registry): ReconMetrics {
  return {
    servicesDiscovered: new Counter({
      name: 'recon_services_discovered_total',
      help: 'Open services written to the surface model by active recon.',
      registers: [registry],
    }),
    portsScanned: new Counter({
      name: 'recon_ports_scanned_total',
      help: 'Ports probed by active recon (each counts against the request budget).',
      registers: [registry],
    }),
  };
}

/** Run metrics for the typed recon wrappers (MCP-010): `mcp_recon_runs_total` and `mcp_recon_duration_ms`. */
export interface ReconRunMetrics {
  /** `mcp_recon_runs_total{tool,result}`: `result` is `success` or the tool error code. */
  readonly runs: Counter<'tool' | 'result'>;
  /** `mcp_recon_duration_ms{tool}`. */
  readonly duration: Histogram<'tool'>;
}

export function createReconRunMetrics(registry: Registry): ReconRunMetrics {
  return {
    runs: new Counter({
      name: 'mcp_recon_runs_total',
      help: 'Typed recon tool runs (httpx, naabu, dnsx) by tool and result.',
      labelNames: ['tool', 'result'] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'mcp_recon_duration_ms',
      help: 'Wall-clock duration of typed recon tool runs in milliseconds.',
      labelNames: ['tool'] as const,
      registers: [registry],
    }),
  };
}
