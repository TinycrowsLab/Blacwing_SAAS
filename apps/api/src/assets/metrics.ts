import { Counter, Gauge, type Registry } from 'prom-client';

import { isAppError } from '@blackwing/errors';

/**
 * Metrics of the asset API: `asset_api_requests_total{route,status}`, `asset_write_conflicts_total` (ASSET-002), and
 * the ownership-verification counters (ASSET-003): `asset_verification_attempts_total{method,result}` and the
 * in-process gauge `asset_verification_active_pending`, and the HTTP-file probe counter (ASSET-006):
 * `asset_verification_http_total{result,reason}`.
 */
export interface AssetMetrics {
  request(route: string, status: number): void;
  writeConflict(): void;
  /** One probe run. `result` is `passed`, `not_found` or `probe_error`: a bounded set, never a probe's free text. */
  verificationAttempt(method: string, result: 'passed' | 'not_found' | 'probe_error'): void;
  /** A challenge became pending (a verification started). */
  verificationPendingOpened(): void;
  /** A pending challenge ended (passed, failed, expired or cancelled). */
  verificationPendingClosed(): void;
  /** One HTTP-file probe run: `result` as above, `reason` a bounded machine reason (never the observed body). */
  verificationHttpFile(result: string, reason: string): void;
}

const HTTP_INTERNAL = 500;

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
  const attempts = new Counter({
    name: 'asset_verification_attempts_total',
    help: 'Ownership verification probe runs by method and result.',
    labelNames: ['method', 'result'] as const,
    registers: [registry],
  });
  const httpFile = new Counter({
    name: 'asset_verification_http_total',
    help: 'HTTP-file ownership probe runs by result and bounded reason.',
    labelNames: ['result', 'reason'] as const,
    registers: [registry],
  });
  const pending = new Gauge({
    name: 'asset_verification_active_pending',
    help: 'Ownership verifications pending in this process (opened minus closed since start).',
    registers: [registry],
  });
  return {
    request: (route, status) => {
      requests.inc({ route, status: String(status) });
    },
    writeConflict: () => {
      conflicts.inc();
    },
    verificationAttempt: (method, result) => {
      attempts.inc({ method, result });
    },
    verificationPendingOpened: () => {
      pending.inc();
    },
    verificationPendingClosed: () => {
      pending.dec();
    },
    verificationHttpFile: (result, reason) => {
      httpFile.inc({ result, reason });
    },
  };
}

/**
 * Counts one request under its route template and status, then re-throws. A failed request counts with the status
 * of its error (`500` for anything that is not an `AppError`).
 */
export async function observeAssetRequest<T>(
  metrics: Pick<AssetMetrics, 'request'>,
  route: string,
  successStatus: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    metrics.request(route, successStatus);
    return result;
  } catch (error) {
    metrics.request(route, isAppError(error) ? error.httpStatus : HTTP_INTERNAL);
    throw error;
  }
}
