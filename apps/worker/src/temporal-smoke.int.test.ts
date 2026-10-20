// DEVENV-007 (#161) smoke: a TS SDK worker connects to the dev Temporal, runs a trivial workflow in the
// `blackwing-dev` namespace, and the workflow is visible via search attributes (what the Web UI lists).
// Needs `pnpm dev:deps` (temporal + temporal-bootstrap). TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as activities from './temporal-smoke/activities.js';

import type { smokeWorkflow } from './temporal-smoke/workflows.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const taskQueue = `bw-smoke-${randomUUID()}`;

describe('temporal dev service', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
  });

  afterAll(async () => {
    await connection.close();
    await native.close();
  });

  it('has the blackwing-dev namespace with the configured retention', async () => {
    const res = await connection.workflowService.describeNamespace({ namespace });
    expect(res.namespaceInfo?.name).toBe(namespace);
    expect(Number(res.config?.workflowExecutionRetentionTtl?.seconds ?? 0)).toBeGreaterThan(0);
  });

  it('registers the custom search attributes the worker epic needs', async () => {
    const res = await connection.operatorService.listSearchAttributes({ namespace });
    for (const name of ['runId', 'tenantId', 'assessmentId', 'runState']) {
      expect(Object.keys(res.customAttributes)).toContain(name);
    }
  });

  it('runs a workflow on a worker and lists it by search attribute', async () => {
    const runId = randomUUID();
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./temporal-smoke/workflows.ts', import.meta.url)),
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await client.workflow.start<typeof smokeWorkflow>('smokeWorkflow', {
        taskQueue,
        workflowId: `smoke-${runId}`,
        args: ['blackwing'],
        searchAttributes: { runId: [runId], tenantId: ['t-smoke'] },
      });
      expect(await handle.result()).toBe('hello blackwing');
    });

    let found = 0;
    for (let i = 0; i < 20 && found === 0; i += 1) {
      for await (const wf of client.workflow.list({ query: `runId = "${runId}"` })) {
        if (wf.workflowId === `smoke-${runId}`) found += 1;
      }
      if (found === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(found).toBe(1);
  });
});
