// `schedules_total{enabled}`: schedules per enabled state (SCHED-001, CONTEXT_PACK §7). The scheduler samples the counts
// under the tenant transaction and reports them with `record`; the gauge reads the last reported values, so a sample
// never blocks a metrics scrape and a tenant's counts are never read across tenants here.

import type { Meter } from '@opentelemetry/api';

export const SCHEDULES_TOTAL_METRIC = 'schedules_total';

export interface SchedulesTotalMetric {
  /** Replaces the sampled counts. A value left out keeps its last sample. */
  record(counts: { readonly enabled?: number; readonly disabled?: number }): void;
}

/** Creates the observable gauge on `meter` and returns the handle that feeds it. */
export function createSchedulesTotalMetric(meter: Meter): SchedulesTotalMetric {
  const latest = new Map<'true' | 'false', number>();
  meter
    .createObservableGauge(SCHEDULES_TOTAL_METRIC, {
      description: 'Recurring-run schedules by enabled state (sampled)',
    })
    .addCallback((result) => {
      for (const [enabled, total] of latest) result.observe(total, { enabled });
    });
  return {
    record(counts) {
      if (counts.enabled !== undefined) latest.set('true', counts.enabled);
      if (counts.disabled !== undefined) latest.set('false', counts.disabled);
    },
  };
}
