import { metrics } from '@opentelemetry/api';

import type { KillStageMetrics } from './ports.js';

// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- histogram bucket boundaries in ms
const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000];

/** `bw_kill_stage_latency_ms{stage}`, `bw_kill_stage_result_total{stage,result}`, partial-halt alert counter. */
export function createOtelKillMetrics(): KillStageMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const latency = meter.createHistogram('bw_kill_stage_latency_ms', {
    description: 'Latency of one kill stage in milliseconds, from stage start to recorded outcome',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  const result = meter.createCounter('bw_kill_stage_result_total', {
    description: 'Kill stage outcomes by stage and result',
  });
  const partial = meter.createCounter('bw_kill_partial_halt_total', {
    description: 'Kill stages that finished partially_halted (alert on any increase)',
  });
  const sandboxes = meter.createCounter('bw_kill_sandboxes_terminated_total', {
    description: 'Sandboxes confirmed terminated (or already gone) by the kill sandbox stage',
  });
  const keys = meter.createCounter('bw_kill_keys_revoked_total', {
    description: 'Virtual model keys confirmed revoked by the kill key stage',
  });
  const workflows = meter.createCounter('bw_kill_workflows_cancelled_total', {
    description: 'Temporal workflows confirmed cancelled by the kill workflow stage',
  });
  return {
    keysRevoked: (count) => {
      keys.add(count);
    },
    workflowsCancelled: (count) => {
      workflows.add(count);
    },
    sandboxesTerminated: (count) => {
      sandboxes.add(count);
    },
    stageLatency: (stage, ms) => {
      latency.record(ms, { stage });
    },
    stageResult: (stage, outcome) => {
      result.add(1, { stage, result: outcome });
    },
    partialHalt: (stage) => {
      partial.add(1, { stage });
    },
  };
}
