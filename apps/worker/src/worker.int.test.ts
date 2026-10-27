// WORKFLOW-002 (#23) integration: the real worker process against the dev Temporal (`pnpm dev:deps`).
// TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override the dev defaults.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithWorkflowContext } from '@blackwing/telemetry';
import { createContextClientInterceptor } from '@blackwing/workflow-shared';

import { startWorkerProcess, type WorkerProcess } from './bootstrap.js';
import { TASK_QUEUES } from './task-queues.js';

import type { noopWorkflow } from './workflows/index.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
const appDir = fileURLToPath(new URL('..', import.meta.url));

function env(port: number, queues: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TEMPORAL_ADDRESS: address,
    TEMPORAL_NAMESPACE: namespace,
    WORKER_TASK_QUEUES: queues,
    WORKER_HEALTH_PORT: String(port),
    LOG_LEVEL: 'info',
  };
}

const randomPort = (): number => 20_000 + Math.floor(Math.random() * 10_000);

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('worker process', () => {
  let connection: Connection;
  let client: Client;
  let worker: WorkerProcess | undefined;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    client = new Client({
      connection,
      namespace,
      interceptors: { workflow: [createContextClientInterceptor()] },
    });
  });

  afterAll(async () => {
    await worker?.shutdown('test cleanup');
    await (connection as Connection | undefined)?.close();
  });

  it('serves /healthz and completes noopWorkflow through the client', async () => {
    const port = randomPort();
    worker = await startWorkerProcess(env(port, TASK_QUEUES.RETENTION));

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      workers: [{ taskQueue: TASK_QUEUES.RETENTION, state: 'RUNNING' }],
    });

    // Every workflow carries a tenant context (#25); a platform workflow says SYSTEM explicitly.
    const handle = await runWithWorkflowContext({ tenantId: 'SYSTEM' }, () =>
      client.workflow.start<typeof noopWorkflow>('noopWorkflow', {
        taskQueue: TASK_QUEUES.RETENTION,
        workflowId: `noop-${randomUUID()}`,
      }),
    );
    await expect(handle.result()).resolves.toBeUndefined();
  });

  it('SIGTERM drains and exits 0 with the graceful shutdown log', async () => {
    const port = randomPort();
    const child = spawn(process.execPath, ['--import', 'tsx', mainPath], {
      cwd: appDir,
      env: env(port, TASK_QUEUES.NOTIFICATIONS),
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return res.status === 200 ? true : undefined;
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toContain('graceful shutdown complete');
  });

  it('exits non-zero with WORKER_QUEUE_UNKNOWN for an unknown queue', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', mainPath], {
      cwd: appDir,
      env: env(randomPort(), 'bogus'),
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).not.toBe(0);
    expect(output).toContain('WORKER_QUEUE_UNKNOWN');
  });
});
