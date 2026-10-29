import { Counter, type Registry } from 'prom-client';

/** The outcome of one finding read: `ok` answered, `denied` was refused by RBAC or Cedar, `not_found` had no row. */
type FindingReadResult = 'ok' | 'denied' | 'not_found';

/** Finding API metrics. Labels are bounded enums, never ids. */
export interface FindingMetrics {
  request(route: 'list' | 'get', result: FindingReadResult): void;
}

/** `finding_api_requests_total{route,result}` on the app's registry. */
export function createFindingMetrics(registry: Registry): FindingMetrics {
  const counter = new Counter({
    name: 'finding_api_requests_total',
    help: 'Finding query API requests by route and result.',
    labelNames: ['route', 'result'],
    registers: [registry],
  });
  return {
    request: (route, result) => {
      counter.inc({ route, result });
    },
  };
}
