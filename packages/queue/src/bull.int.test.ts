import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';

import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { type BullWorker, createQueue, createWorker } from './bull.js';

import type { QueueMetrics } from './metrics.js';
import type { ConnectionOptions } from 'bullmq';

let valkey: ValkeyHandle | undefined;
let raw: ReturnType<ValkeyHandle['createClient']>;
const workers: BullWorker[] = [];
const producers: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  valkey = await withValkey();
  raw = valkey.createClient({ keyPrefix: '' });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(producers.map((p) => p.close()));
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey]);

const payload = z.object({ to: z.string().min(1), n: z.number().int() });
const POLL_MS = 25;

function connection(): ConnectionOptions {
  if (valkey === undefined) throw new Error('Valkey not started');
  return { host: valkey.host, port: valkey.port, password: valkey.password };
}

function tenant(): string {
  return randomUUID();
}

function queueName(): string {
  return `q${randomUUID().slice(0, 8)}`;
}

function memoryMetrics(): QueueMetrics & {
  completed: Mock;
  failed: Mock;
  sampled: Mock;
} {
  return { completed: vi.fn(), failed: vi.fn(), sampled: vi.fn() };
}

/** Polls `check` until it returns true, failing after `timeoutMs`. */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function track<W extends BullWorker>(worker: W): W {
  workers.push(worker);
  return worker;
}

describe('createQueue and createWorker against a real Valkey', () => {
  it('processes a typed job whose payload is validated, and counts it as completed', async () => {
    const t = tenant();
    const name = queueName();
    const metrics = memoryMetrics();
    const received: z.infer<typeof payload>[] = [];
    const queue = createQueue(name, { tenantId: t, payload, connection: connection() });
    producers.push(queue);
    const { jobId } = await queue.add({ to: 'ops@example.test', n: 3 });
    track(
      createWorker(
        name,
        (data) => {
          received.push(data);
          return Promise.resolve();
        },
        { tenantId: t, payload, connection: connection(), metrics, concurrency: 2 },
      ),
    );

    await until(() => received.length === 1);
    expect(received).toEqual([{ to: 'ops@example.test', n: 3 }]);
    await until(() => metrics.completed.mock.calls.length === 1);
    expect(metrics.completed).toHaveBeenCalledWith(name);
    expect(jobId).toMatch(/^\d+$/);
  });

  it('keys every job under the tenant prefix bw:<tenantId>: and applies the default job options', async () => {
    const t = tenant();
    const name = queueName();
    const queue = createQueue(name, { tenantId: t, payload, connection: connection() });
    producers.push(queue);
    const { jobId } = await queue.add({ to: 'a@example.test', n: 1 });

    expect(queue.prefix).toBe(`bw:${t}`);
    const jobKey = `bw:${t}:${name}:${jobId}`;
    expect(await raw.exists(jobKey)).toBe(1);
    const opts = JSON.parse((await raw.hget(jobKey, 'opts')) ?? '{}') as Record<string, unknown>;
    expect(opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnFail: false,
    });
    const everyKey = await raw.keys('bw:*');
    expect(everyKey.length).toBeGreaterThan(0);
    for (const key of everyKey.filter((k) => k.includes(name))) {
      expect(key.startsWith(`bw:${t}:${name}:`)).toBe(true);
    }
  });

  it('isolates tenants: another tenant cannot see or process the job', async () => {
    const owner = tenant();
    const intruder = tenant();
    const name = queueName();
    const producer = createQueue(name, { tenantId: owner, payload, connection: connection() });
    producers.push(producer);
    await producer.add({ to: 'secret@example.test', n: 7 });

    const spy = vi.fn(() => Promise.resolve());
    const otherTenantWorker = track(
      createWorker(name, spy, { tenantId: intruder, payload, connection: connection() }),
    );
    const otherTenantQueue = createQueue(name, {
      tenantId: intruder,
      payload,
      connection: connection(),
    });
    producers.push(otherTenantQueue);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(spy).not.toHaveBeenCalled();
    expect(await otherTenantQueue.depth()).toBe(0);
    expect(await producer.depth()).toBe(1);
    expect(await raw.llen(`bw:${intruder}:${name}:wait`)).toBe(0);
    expect(await raw.llen(`bw:${owner}:${name}:wait`)).toBe(1);
    await otherTenantWorker.close();
  });

  it('rejects a bad payload on enqueue and a payload over the size cap, leaving nothing queued', async () => {
    const t = tenant();
    const name = queueName();
    const queue = createQueue(name, {
      tenantId: t,
      payload,
      connection: connection(),
      maxPayloadBytes: 64,
    });
    producers.push(queue);

    const invalid = queue.add({ to: '', n: 1 });
    await expect(invalid).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const large = queue.add({ to: 'x'.repeat(200), n: 1 });
    await expect(large).rejects.toMatchObject({ code: 'QUEUE_PAYLOAD_TOO_LARGE' });

    expect(await queue.depth()).toBe(0);
  });

  it('refuses a malformed jobId and treats a repeated jobId as an idempotent no-op', async () => {
    const t = tenant();
    const name = queueName();
    const queue = createQueue(name, { tenantId: t, payload, connection: connection() });
    producers.push(queue);

    await expect(queue.add({ to: 'a', n: 1 }, { jobId: 'bad id:1' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const first = await queue.add({ to: 'a', n: 1 }, { jobId: 'order-1' });
    const again = await queue.add({ to: 'a', n: 1 }, { jobId: 'order-1' });
    expect(first.jobId).toBe('order-1');
    expect(again.jobId).toBe('order-1');
    expect(await queue.depth()).toBe(1);
  });

  it('retries a throwing processor per backoff, then lands as failed and counts one failure', async () => {
    const t = tenant();
    const name = queueName();
    const metrics = memoryMetrics();
    const processor = vi.fn(() => Promise.reject(new Error('smtp is down')));
    const queue = createQueue(name, {
      tenantId: t,
      payload,
      connection: connection(),
      jobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 20 } },
    });
    producers.push(queue);
    await queue.add({ to: 'a@example.test', n: 1 });
    track(
      createWorker(name, processor, { tenantId: t, payload, connection: connection(), metrics }),
    );

    await until(() => metrics.failed.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processor).toHaveBeenCalledTimes(3);
    expect(metrics.failed.mock.calls).toEqual([[name]]);
    expect(metrics.completed).not.toHaveBeenCalled();
  });

  it('fails a job with a poison payload at once and never runs the processor', async () => {
    const t = tenant();
    const name = queueName();
    const metrics = memoryMetrics();
    const loose = z.object({ to: z.string(), n: z.string() });
    const producer = createQueue(name, { tenantId: t, payload: loose, connection: connection() });
    producers.push(producer);
    const { jobId } = await producer.add({ to: 'a@example.test', n: 'not-a-number' });

    const processor = vi.fn(() => Promise.resolve());
    track(
      createWorker(name, processor, { tenantId: t, payload, connection: connection(), metrics }),
    );

    await until(() => metrics.failed.mock.calls.length === 1);
    expect(processor).not.toHaveBeenCalled();
    expect(await raw.exists(`bw:${t}:${name}:${jobId}`)).toBe(1);
    const state = await raw.hget(`bw:${t}:${name}:${jobId}`, 'finishedOn');
    expect(state).not.toBeNull();
  });

  it('reports QUEUE_UNAVAILABLE, retryable, within the enqueue timeout when Valkey is unreachable', async () => {
    const t = tenant();
    const name = queueName();
    const queue = createQueue(name, {
      tenantId: t,
      payload,
      connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null },
      enqueueTimeoutMs: 300,
    });
    const started = Date.now();
    await expect(queue.add({ to: 'a@example.test', n: 1 })).rejects.toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
      retryable: true,
      httpStatus: 503,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await queue.close();
  });

  it('samples active, waiting and depth gauges while a job is running and others wait', async () => {
    const t = tenant();
    const name = queueName();
    const metrics = memoryMetrics();
    const producer = createQueue(name, { tenantId: t, payload, connection: connection() });
    producers.push(producer);
    await producer.add({ to: 'a@example.test', n: 1 });
    await producer.add({ to: 'b@example.test', n: 2 });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    track(
      createWorker(name, () => gate, {
        tenantId: t,
        payload,
        connection: connection(),
        metrics,
        concurrency: 1,
        gaugeIntervalMs: 50,
      }),
    );
    await until(() =>
      metrics.sampled.mock.calls.some(([, s]) => (s as { active: number }).active === 1),
    );
    expect(metrics.sampled).toHaveBeenLastCalledWith(name, { active: 1, waiting: 1, depth: 1 });
    release();
    await until(() => metrics.completed.mock.calls.length === 2);
  });

  it('closes a worker after in-flight jobs finish, and close is idempotent', async () => {
    const t = tenant();
    const name = queueName();
    const metrics = memoryMetrics();
    const producer = createQueue(name, { tenantId: t, payload, connection: connection() });
    producers.push(producer);
    await producer.add({ to: 'a@example.test', n: 1 });
    let finished = false;
    const worker = createWorker(
      name,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        finished = true;
      },
      { tenantId: t, payload, connection: connection(), metrics },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = worker.close();
    expect(worker.close()).toBe(first);
    await first;
    expect(finished).toBe(true);
  });
});
