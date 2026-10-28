import { describe, expect, it } from 'vitest';

import { parseKillChaosConfig, parseWorkerConfig } from './config.js';
import { ALL_TASK_QUEUES } from './task-queues.js';

const base = { NODE_ENV: 'test' } as const;

describe('parseWorkerConfig', () => {
  it('applies the documented defaults', () => {
    const config = parseWorkerConfig(base);
    expect(config.maxConcurrentActivityTaskExecutions).toBe(20);
    expect(config.maxConcurrentWorkflowTaskExecutions).toBe(40);
    expect(config.taskQueues).toEqual(ALL_TASK_QUEUES);
    expect(config.shutdownGraceMs).toBe(30_000);
  });

  it('reads concurrency, queues, port and grace from the environment', () => {
    const config = parseWorkerConfig({
      ...base,
      TEMPORAL_MAX_ACTIVITY_CONCURRENCY: '5',
      TEMPORAL_MAX_WORKFLOW_CONCURRENCY: '7',
      WORKER_TASK_QUEUES: 'exports,retention',
      WORKER_HEALTH_PORT: '14000',
      WORKER_SHUTDOWN_GRACE: '10s',
    });
    expect(config).toMatchObject({
      maxConcurrentActivityTaskExecutions: 5,
      maxConcurrentWorkflowTaskExecutions: 7,
      taskQueues: ['exports', 'retention'],
      healthPort: 14000,
      shutdownGraceMs: 10_000,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', '1000000'])('rejects concurrency %j', (value) => {
    expect(() =>
      parseWorkerConfig({ ...base, TEMPORAL_MAX_ACTIVITY_CONCURRENCY: value }),
    ).toThrow();
    expect(() =>
      parseWorkerConfig({ ...base, TEMPORAL_MAX_WORKFLOW_CONCURRENCY: value }),
    ).toThrow();
  });

  it('rejects an unknown queue', () => {
    expect(() => parseWorkerConfig({ ...base, WORKER_TASK_QUEUES: 'bogus' })).toThrow(/bogus/);
  });

  it('parses AUDIT_ACTIVITY_SAMPLE and defaults to sampling nothing', () => {
    expect(parseWorkerConfig(base).auditActivitySample.size).toBe(0);
    const config = parseWorkerConfig({ ...base, AUDIT_ACTIVITY_SAMPLE: 'a=0.1, b=1' });
    expect([...config.auditActivitySample]).toEqual([
      ['a', 0.1],
      ['b', 1],
    ]);
  });

  it.each(['a', 'a=', '=0.5', 'a=0', 'a=1.5', 'a=x', 'a=0.5=1'])(
    'rejects AUDIT_ACTIVITY_SAMPLE %j',
    (value) => {
      expect(() => parseWorkerConfig({ ...base, AUDIT_ACTIVITY_SAMPLE: value })).toThrow();
    },
  );
});

describe('parseKillChaosConfig (KILL-008)', () => {
  const realUrls = {
    KILL_CHAOS_EGRESS_URL: 'https://egress.dev.internal',
    KILL_CHAOS_SANDBOX_URL: 'https://sandbox.dev.internal',
    KILL_CHAOS_KEYS_URL: 'https://keys.dev.internal',
  };

  it('defaults to 25 mock runs with no control URLs and the default report path', () => {
    expect(parseKillChaosConfig(base)).toEqual({
      runs: 25,
      mode: 'mock',
      egressUrl: undefined,
      sandboxUrl: undefined,
      keysUrl: undefined,
      reportPath: undefined,
    });
  });

  it('reads the run count, mode, control URLs and report path from the environment', () => {
    const config = parseKillChaosConfig({
      ...base,
      KILL_CHAOS_RUNS: '100',
      KILL_CHAOS_MODE: 'real',
      ...realUrls,
      KILL_CHAOS_REPORT_PATH: '/tmp/slo.json',
    });
    expect(config).toEqual({
      runs: 100,
      mode: 'real',
      egressUrl: 'https://egress.dev.internal',
      sandboxUrl: 'https://sandbox.dev.internal',
      keysUrl: 'https://keys.dev.internal',
      reportPath: '/tmp/slo.json',
    });
  });

  it.each(['0', '-3', '2.5', 'many', '501'])('rejects KILL_CHAOS_RUNS %j', (value) => {
    expect(() => parseKillChaosConfig({ ...base, KILL_CHAOS_RUNS: value })).toThrow();
  });

  it('rejects an unknown mode, so a typo cannot silently run the mock suite', () => {
    expect(() => parseKillChaosConfig({ ...base, KILL_CHAOS_MODE: 'Real' })).toThrow();
  });

  it('rejects a control URL that is not a URL', () => {
    expect(() =>
      parseKillChaosConfig({ ...base, KILL_CHAOS_EGRESS_URL: 'egress.dev.internal' }),
    ).toThrow();
  });

  it.each(['KILL_CHAOS_EGRESS_URL', 'KILL_CHAOS_SANDBOX_URL', 'KILL_CHAOS_KEYS_URL'])(
    'real mode fails closed when %s is missing',
    (missing) => {
      const urls = Object.fromEntries(Object.entries(realUrls).filter(([key]) => key !== missing));
      expect(() => parseKillChaosConfig({ ...base, KILL_CHAOS_MODE: 'real', ...urls })).toThrow(
        missing,
      );
    },
  );
});
