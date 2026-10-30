// Threshold presets shared by every profile (PERF-001, #320). Returns fresh arrays on each call because k6
// reads the options object in place.

/**
 * @returns {{ http_req_duration: string[], http_req_failed: string[], checks: string[] }} k6 thresholds: latency
 *   p95/p99, error rate and check pass rate
 */
export function presetThresholds() {
  return {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  };
}
