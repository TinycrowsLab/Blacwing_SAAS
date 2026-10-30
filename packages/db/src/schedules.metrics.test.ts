import { describe, expect, it } from 'vitest';

import { createSchedulesTotalMetric, SCHEDULES_TOTAL_METRIC } from './schedules.metrics.js';

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
    callback?.({ observe: (value, attributes) => seen.push({ value, attributes }) });
    return seen;
  };
  return { meter, names, collect };
}

describe('schedules_total{enabled}', () => {
  it('registers one observable gauge under the metric name', () => {
    const { meter, names } = fakeMeter();
    createSchedulesTotalMetric(meter);
    expect(names).toEqual([SCHEDULES_TOTAL_METRIC]);
    expect(SCHEDULES_TOTAL_METRIC).toBe('schedules_total');
  });

  it('reports the last sampled count per enabled state and keeps a state left out of an update', () => {
    const { meter, collect } = fakeMeter();
    const metric = createSchedulesTotalMetric(meter);
    expect(collect()).toEqual([]);
    metric.record({ enabled: 4, disabled: 1 });
    metric.record({ enabled: 5 });
    expect(collect()).toEqual([
      { value: 5, attributes: { enabled: 'true' } },
      { value: 1, attributes: { enabled: 'false' } },
    ]);
  });
});
