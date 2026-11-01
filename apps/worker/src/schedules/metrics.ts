import { metrics } from '@opentelemetry/api';

import type { ScheduleMetrics } from './ports.js';

/** `temporal_schedule_ops_total{op,result}` and `schedule_reconcile_repairs_total` (SCHED-003). */
export function createOtelScheduleMetrics(): ScheduleMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const ops = meter.createCounter('temporal_schedule_ops_total', {
    description: 'Temporal Schedule operations by op and result',
  });
  const repairs = meter.createCounter('schedule_reconcile_repairs_total', {
    description: 'Drift repaired between schedules rows and Temporal Schedules',
  });
  return {
    op: ({ op, result }) => {
      ops.add(1, { op, result });
    },
    repairs: (count) => {
      repairs.add(count);
    },
  };
}
