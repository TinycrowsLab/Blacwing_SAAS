import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOtelKillMetrics } from './metrics.js';

type Attributes = Record<string, string>;

const fake = vi.hoisted(() => {
  const created = new Map<string, { kind: string; options: unknown }>();
  const records: { name: string; value: number; attributes: Attributes | undefined }[] = [];
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
  };
  return { created, records, meter };
});

vi.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: () => fake.meter },
}));

beforeEach(() => {
  fake.created.clear();
  fake.records.length = 0;
});

describe('createOtelKillMetrics', () => {
  it('registers the kill instruments with millisecond histograms', () => {
    createOtelKillMetrics();
    expect([...fake.created.keys()].sort()).toEqual([
      'bw_kill_halt_ms',
      'bw_kill_keys_revoked_total',
      'bw_kill_partial_halt_total',
      'bw_kill_sandboxes_terminated_total',
      'bw_kill_stage_latency_ms',
      'bw_kill_stage_result_total',
      'bw_kill_workflows_cancelled_total',
    ]);
    const bucketed = {
      unit: 'ms',
      advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000] },
    };
    expect(fake.created.get('bw_kill_halt_ms')).toMatchObject({
      kind: 'histogram',
      options: bucketed,
    });
    expect(fake.created.get('bw_kill_stage_latency_ms')).toMatchObject({
      kind: 'histogram',
      options: bucketed,
    });
  });

  it('records the halt time from trigger to completion', () => {
    createOtelKillMetrics().haltMs(1200);
    expect(fake.records).toEqual([{ name: 'bw_kill_halt_ms', value: 1200, attributes: undefined }]);
  });

  it('records per-stage latency and outcome, labelled by stage', () => {
    const m = createOtelKillMetrics();
    m.stageLatency('sandbox', 40);
    m.stageResult('sandbox', 'terminated');
    m.partialHalt('egress');
    expect(fake.records).toEqual([
      { name: 'bw_kill_stage_latency_ms', value: 40, attributes: { stage: 'sandbox' } },
      {
        name: 'bw_kill_stage_result_total',
        value: 1,
        attributes: { stage: 'sandbox', result: 'terminated' },
      },
      { name: 'bw_kill_partial_halt_total', value: 1, attributes: { stage: 'egress' } },
    ]);
  });

  it('adds the confirmed sandbox, key and workflow counts', () => {
    const m = createOtelKillMetrics();
    m.sandboxesTerminated(4);
    m.keysRevoked(3);
    m.workflowsCancelled(2);
    expect(fake.records).toEqual([
      { name: 'bw_kill_sandboxes_terminated_total', value: 4, attributes: undefined },
      { name: 'bw_kill_keys_revoked_total', value: 3, attributes: undefined },
      { name: 'bw_kill_workflows_cancelled_total', value: 2, attributes: undefined },
    ]);
  });
});
