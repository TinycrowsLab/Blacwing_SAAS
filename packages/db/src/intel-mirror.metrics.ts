// `intel_mirror_rows{table}`: rows per reference table of the vulnerability-intelligence mirror (INTEL-001). The
// ingestion jobs report counts with `record` after each sync (INTEL-002..006); the gauge reads the last reported values.

import type { IntelMirrorTable } from './intel-mirror.repository.js';
import type { Meter } from '@opentelemetry/api';

export const INTEL_MIRROR_ROWS_METRIC = 'intel_mirror_rows';

export interface IntelMirrorRowsMetric {
  /** Replaces the reported count of each given table. Tables left out keep their last value. */
  record(counts: Readonly<Partial<Record<IntelMirrorTable, number>>>): void;
}

/** Creates the observable gauge on `meter` and returns the handle that feeds it. */
export function createIntelMirrorRowsMetric(meter: Meter): IntelMirrorRowsMetric {
  const latest = new Map<IntelMirrorTable, number>();
  meter
    .createObservableGauge(INTEL_MIRROR_ROWS_METRIC, {
      description: 'Rows per reference table of the vulnerability-intelligence mirror',
    })
    .addCallback((result) => {
      for (const [table, rows] of latest) result.observe(rows, { table });
    });
  return {
    record(counts) {
      for (const [table, rows] of Object.entries(counts) as [
        IntelMirrorTable,
        number | undefined,
      ][]) {
        if (rows !== undefined) latest.set(table, rows);
      }
    },
  };
}
