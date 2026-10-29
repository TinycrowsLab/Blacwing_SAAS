import { Counter, type Registry } from 'prom-client';

/** Metrics of the asset API (ASSET-002): `asset_api_requests_total{route,status}`, `asset_write_conflicts_total`. */
export interface AssetMetrics {
  request(route: string, status: number): void;
  writeConflict(): void;
}

/** Registers the asset counters on `registry` (the API's registry, so they appear on `/metrics`). */
export function createAssetMetrics(registry: Registry): AssetMetrics {
  const requests = new Counter({
    name: 'asset_api_requests_total',
    help: 'Asset API requests by route template and HTTP status.',
    labelNames: ['route', 'status'] as const,
    registers: [registry],
  });
  const conflicts = new Counter({
    name: 'asset_write_conflicts_total',
    help: 'Asset writes refused because the If-Match ETag was stale or the row changed concurrently.',
    registers: [registry],
  });
  return {
    request: (route, status) => {
      requests.inc({ route, status: String(status) });
    },
    writeConflict: () => {
      conflicts.inc();
    },
  };
}
