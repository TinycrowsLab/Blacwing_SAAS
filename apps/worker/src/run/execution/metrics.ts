import { metrics } from '@opentelemetry/api';

import type { ExecutionMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in seconds
const WAIT_BUCKETS_SECONDS = [30, 60, 300, 900, 1800, 3600];

/**
 * `blackwing_gate2_total{decision}`, `blackwing_gate2_wait_seconds`,
 * `blackwing_orchestrator_dispatches_total`, `blackwing_mentor_interventions_total{role}`.
 */
export function createOtelExecutionMetrics(): ExecutionMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const gate2 = meter.createCounter('blackwing_gate2_total', {
    description: 'Gate 2 decisions by decision (approved, denied or timeout)',
  });
  const wait = meter.createHistogram('blackwing_gate2_wait_seconds', {
    description: 'Time from a Gate 2 request opening to its decision',
    unit: 's',
    advice: { explicitBucketBoundaries: WAIT_BUCKETS_SECONDS },
  });
  const dispatches = meter.createCounter('blackwing_orchestrator_dispatches_total', {
    description: 'dispatch_subtask calls made by the orchestrator',
  });
  const mentor = meter.createCounter('blackwing_mentor_interventions_total', {
    description: 'Mentor and reflector interventions by role',
  });
  return {
    gate2: (decision) => {
      gate2.add(1, { decision });
    },
    gate2Wait: (seconds) => {
      wait.record(seconds);
    },
    dispatch: () => {
      dispatches.add(1);
    },
    mentorIntervention: (role) => {
      mentor.add(1, { role });
    },
  };
}
