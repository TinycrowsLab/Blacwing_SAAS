import { metrics } from '@opentelemetry/api';

import type { DispatchMetrics } from './ports.js';

/** `blackwing_subtasks_total{persona,status}` and `blackwing_dispatch_rejections_total{reason}`. */
export function createOtelDispatchMetrics(): DispatchMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const subtasks = meter.createCounter('blackwing_subtasks_total', {
    description: 'Subtask status changes by persona and status',
  });
  const rejections = meter.createCounter('blackwing_dispatch_rejections_total', {
    description: 'dispatch_subtask calls refused, by reason code',
  });
  return {
    subtask: (persona, status) => {
      subtasks.add(1, { persona, status });
    },
    rejection: (reason) => {
      rejections.add(1, { reason });
    },
  };
}
