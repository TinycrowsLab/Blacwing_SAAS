import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOtelOutboxMetrics } from './metrics.js';

type Attributes = Record<string, string>;
type GaugeCallback = (result: { observe(value: number, attributes: Attributes): void }) => void;

const fake = vi.hoisted(() => {
  const created = new Map<string, { kind: string; options: unknown }>();
  const records: { name: string; value: number; attributes: Attributes | undefined }[] = [];
  const gauges = new Map<string, GaugeCallback>();
  const instrument = (kind: string, name: string, options: unknown) => {
    created.set(name, { kind, options });
    const record = (value: number, attributes?: Attributes) => {
      records.push({ name, value, attributes });
    };
    return { add: record, record };
  };
  const meter = {
    createCounter: (name: string, options: unknown) => instrument('counter', name, options),
    createHistogram: (name: string, options: unknown) => instrument('histogram', name, options),
    createObservableGauge: (name: string, options: unknown) => {
      created.set(name, { kind: 'gauge', options });
      return { addCallback: (callback: GaugeCallback) => gauges.set(name, callback) };
    },
  };
  return { created, records, gauges, meter };
});

vi.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: () => fake.meter },
}));

beforeEach(() => {
  fake.created.clear();
  fake.records.length = 0;
  fake.gauges.clear();
});

describe('createOtelOutboxMetrics', () => {
  it('registers the outbox instruments under their alerting names', () => {
    createOtelOutboxMetrics();
    expect([...fake.created.keys()].sort()).toEqual([
      'outbox_backlog',
      'outbox_dispatch_latency_seconds',
      'outbox_dispatched_total',
      'outbox_failed_total',
      'outbox_retry_total',
    ]);
    expect(fake.created.get('outbox_dispatch_latency_seconds')).toMatchObject({
      kind: 'histogram',
      options: {
        unit: 's',
        advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 5, 15, 60, 300, 1800, 7200] },
      },
    });
  });

  it('counts delivered, terminally failed and retried rows per type', () => {
    const m = createOtelOutboxMetrics();
    m.dispatched('notify.send');
    m.failed('audit.event');
    m.retried('temporal.signal');
    expect(fake.records).toEqual([
      { name: 'outbox_dispatched_total', value: 1, attributes: { type: 'notify.send' } },
      { name: 'outbox_failed_total', value: 1, attributes: { type: 'audit.event' } },
      { name: 'outbox_retry_total', value: 1, attributes: { type: 'temporal.signal' } },
    ]);
  });

  it('records dispatch latency in seconds', () => {
    createOtelOutboxMetrics().dispatchLatency(2.5);
    expect(fake.records).toEqual([
      { name: 'outbox_dispatch_latency_seconds', value: 2.5, attributes: undefined },
    ]);
  });

  it('reports the latest backlog per type on each collection', () => {
    const m = createOtelOutboxMetrics();
    m.backlog('audit.event', 3);
    m.backlog('notify.send', 1);
    m.backlog('audit.event', 5);
    const observed: { value: number; attributes: Attributes }[] = [];
    fake.gauges.get('outbox_backlog')?.({
      observe: (value, attributes) => {
        observed.push({ value, attributes });
      },
    });
    expect(observed).toEqual([
      { value: 5, attributes: { type: 'audit.event' } },
      { value: 1, attributes: { type: 'notify.send' } },
    ]);
  });
});
