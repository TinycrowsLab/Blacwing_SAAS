import { describe, expect, it } from 'vitest';

import { createHealthServer } from './health.js';
import { WorkerRuntime, type WorkerLike } from './runtime.js';

import type { WorkerConfig } from './config.js';
import type { TaskQueueName } from './task-queues.js';
import type { Logger } from '@blackwing/logger';

const config: WorkerConfig = {
  maxConcurrentActivityTaskExecutions: 20,
  maxConcurrentWorkflowTaskExecutions: 40,
  taskQueues: ['validation', 'exports'],
  healthPort: 0,
  shutdownGraceMs: 1000,
  auditActivitySample: new Map(),
};

/** A fake worker that stays RUNNING until shutdown(), then drains for `drainMs` before run() settles. */
function fakeWorker(events: string[], queue: string, drainMs = 20, failOnRun = false): WorkerLike {
  let state = 'INITIALIZED';
  let release: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    getState: () => state,
    run: async () => {
      state = 'RUNNING';
      if (failOnRun) {
        await Promise.resolve();
        state = 'FAILED';
        throw new Error('poller crashed');
      }
      await stopped;
      await new Promise((r) => setTimeout(r, drainMs));
      events.push(`drained:${queue}`);
      state = 'STOPPED';
    },
    shutdown: () => {
      events.push(`shutdown:${queue}`);
      state = 'DRAINING';
      release();
    },
  };
}

function build(events: string[], opts: { failQueue?: string } = {}) {
  const lines: string[] = [];
  const record = (_fields: unknown, message?: string): void => {
    lines.push(message ?? '');
  };
  const fake = { info: record, fatal: record, warn: record, error: record, child: () => fake };
  const runtime = new WorkerRuntime({
    config,
    log: fake as unknown as Logger,
    createWorker: (queue: TaskQueueName) =>
      Promise.resolve(fakeWorker(events, queue, 20, queue === opts.failQueue)),
    closeConnections: () => {
      events.push('closed');
      return Promise.resolve();
    },
  });
  return { runtime, lines };
}

describe('WorkerRuntime', () => {
  it('starts one worker per queue and reports health', async () => {
    const events: string[] = [];
    const { runtime } = build(events);
    await runtime.start();
    expect(runtime.health()).toEqual({
      status: 'ok',
      workers: [
        { taskQueue: 'validation', state: 'RUNNING' },
        { taskQueue: 'exports', state: 'RUNNING' },
      ],
    });
    await runtime.shutdown('test');
  });

  it('drains in-flight tasks before closing connections and logs graceful shutdown', async () => {
    const events: string[] = [];
    const { runtime, lines } = build(events);
    await runtime.start();
    await runtime.shutdown('SIGTERM');
    expect(events.indexOf('closed')).toBeGreaterThan(events.indexOf('drained:validation'));
    expect(events.indexOf('closed')).toBeGreaterThan(events.indexOf('drained:exports'));
    expect(lines).toContain('temporal worker graceful shutdown complete');
    expect(runtime.health().status).toBe('unavailable');
  });

  it('shutdown is idempotent and concurrent calls share one drain', async () => {
    const events: string[] = [];
    const { runtime } = build(events);
    await runtime.start();
    await Promise.all([runtime.shutdown('a'), runtime.shutdown('b')]);
    expect(events.filter((e) => e === 'closed')).toHaveLength(1);
  });

  it('a failed worker takes the others down and run() rejects', async () => {
    const events: string[] = [];
    const { runtime } = build(events, { failQueue: 'exports' });
    await runtime.start().catch(() => undefined);
    await expect(runtime.run()).rejects.toThrow('poller crashed');
    expect(events).toContain('shutdown:validation');
  });
});

describe('GET /healthz', () => {
  it('is 200 when ok and 503 when not, with per-queue state', async () => {
    const ok = createHealthServer(() => ({
      status: 'ok',
      workers: [{ taskQueue: 'exports', state: 'RUNNING' }],
    }));
    const res = await ok.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      workers: [{ taskQueue: 'exports', state: 'RUNNING' }],
    });

    const down = createHealthServer(() => ({ status: 'unavailable', workers: [] }));
    expect((await down.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503);
    await ok.close();
    await down.close();
  });
});
