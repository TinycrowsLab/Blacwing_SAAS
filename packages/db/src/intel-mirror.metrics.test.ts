import { describe, expect, it } from 'vitest';

import { createIntelMirrorRowsMetric, INTEL_MIRROR_ROWS_METRIC } from './intel-mirror.metrics.js';

import type { Meter } from '@opentelemetry/api';

interface Observation {
  readonly value: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/** A meter that records the gauge callback and lets the test run the observation pass. */
function fakeMeter() {
  let callback:
    | ((result: { observe(value: number, attributes: Record<string, string>): void }) => void)
    | undefined;
  const names: string[] = [];
  const meter = {
    createObservableGauge(name: string) {
      names.push(name);
      return {
        addCallback(cb: typeof callback) {
          callback = cb;
        },
      };
    },
  } as unknown as Meter;
  const collect = (): Observation[] => {
    const seen: Observation[] = [];
    callback?.({
      observe: (value, attributes) => seen.push({ value, attributes }),
    });
    return seen;
  };
  return { meter, names, collect };
}

describe('intel_mirror_rows{table}', () => {
  it('registers one observable gauge under the metric name', () => {
    const { meter, names } = fakeMeter();
    createIntelMirrorRowsMetric(meter);
    expect(names).toEqual([INTEL_MIRROR_ROWS_METRIC]);
  });

  it('reports the last count recorded for each table and keeps tables left out of an update', () => {
    const { meter, collect } = fakeMeter();
    const metric = createIntelMirrorRowsMetric(meter);
    expect(collect()).toEqual([]);
    metric.record({ cve_records: 10, kev_entries: 2 });
    metric.record({ cve_records: 12 });
    expect(collect()).toEqual([
      { value: 12, attributes: { table: 'cve_records' } },
      { value: 2, attributes: { table: 'kev_entries' } },
    ]);
  });
});
