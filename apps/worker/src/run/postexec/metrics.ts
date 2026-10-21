import { metrics } from '@opentelemetry/api';

import type { PostExecutionMetrics } from './ports.js';

/** `blackwing_candidates_total{result}`, `blackwing_gate3_decisions_total{decision}`, `blackwing_findings_released_total`. */
export function createOtelPostExecutionMetrics(): PostExecutionMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const candidates = meter.createCounter('blackwing_candidates_total', {
    description: 'Validated candidate findings by result (confirmed or suspected)',
  });
  const decisions = meter.createCounter('blackwing_gate3_decisions_total', {
    description: 'Gate 3 finding decisions by decision',
  });
  const released = meter.createCounter('blackwing_findings_released_total', {
    description: 'Findings released at Gate 3',
  });
  return {
    candidate: (result) => {
      candidates.add(1, { result });
    },
    gate3Decision: (decision) => {
      decisions.add(1, { decision });
    },
    released: () => {
      released.add(1);
    },
  };
}
