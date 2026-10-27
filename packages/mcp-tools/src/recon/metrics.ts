import { Counter, type Registry } from 'prom-client';

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
