// WORKFLOW-003 integration: registration, visibility and the type-conflict path against a real Temporal server.
// Needs `pnpm dev:deps` (temporal + temporal-bootstrap). TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { NativeConnection, Worker } from '@temporalio/worker';
import Long from 'long';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerSearchAttributes } from './search-attribute-registration.js';
import { runStartSearchAttributes, SEARCH_ATTRIBUTES } from './search-attributes.js';

import type * as probe from './search-attributes/probe-workflows.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const KEYWORD = temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD;
const INT = temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT;
const workflowsPath = fileURLToPath(
  new URL('./search-attributes/probe-workflows.ts', import.meta.url),
);

/** Visibility is eventually consistent: poll until `found` answers true or the attempts run out. */
async function eventually(found: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await found()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

describe('custom search attributes (dev Temporal)', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
  });

  afterAll(async () => {
    // Unset when beforeAll failed to connect; keep the real connect error as the only failure.
    await (connection as Connection | undefined)?.close();
    await (native as NativeConnection | undefined)?.close();
  });

  it('registers the three attributes, and a second registration changes nothing', async () => {
    const operator = connection.operatorService;
    await registerSearchAttributes({ operator, namespace });

    const second = await registerSearchAttributes({ operator, namespace });

    expect(second).toEqual({ result: 'unchanged', created: [] });
    const listed = await operator.listSearchAttributes({ namespace });
    for (const name of Object.keys(SEARCH_ATTRIBUTES)) {
      expect(listed.customAttributes[name]).toBe(KEYWORD);
    }
  });

  it('finds a running workflow by tenantId and runState through a visibility query', async () => {
    const tenantId = `t-${randomUUID()}`;
    const runId = randomUUID();
    const workflowId = `wf-probe-${runId}`;
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue: `bw-search-attr-${runId}`,
      workflowsPath,
    });

    await worker.runUntil(async () => {
      const handle = await client.workflow.start<typeof probe.runStateProbeWorkflow>(
        'runStateProbeWorkflow',
        {
          taskQueue: `bw-search-attr-${runId}`,
          workflowId,
          searchAttributes: runStartSearchAttributes({ tenantId, runId, runState: 'approved' }),
        },
      );

      const visible = await eventually(async () => {
        for await (const wf of client.workflow.list({
          query: `tenantId = "${tenantId}" and runState = "executing"`,
        })) {
          if (wf.workflowId === workflowId) return true;
        }
        return false;
      });
      expect(visible).toBe(true);

      await handle.signal('releaseProbe');
      expect(await handle.result()).toBe('released');
    });
  });

  it('fails with SEARCH_ATTR_TYPE_CONFLICT and changes nothing when an attribute has another type', async () => {
    // A throwaway namespace, so the shared dev attributes are never touched.
    const scratch = `bw-int-${randomUUID().slice(0, 8)}`;
    await connection.workflowService.registerNamespace({
      namespace: scratch,
      workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(3600) },
    });
    const operator = connection.operatorService;
    const ready = await eventually(async () => {
      try {
        await operator.listSearchAttributes({ namespace: scratch });
        return true;
      } catch {
        return false;
      }
    });
    expect(ready).toBe(true);
    await operator.addSearchAttributes({ namespace: scratch, searchAttributes: { tenantId: INT } });

    await expect(registerSearchAttributes({ operator, namespace: scratch })).rejects.toMatchObject({
      code: 'SEARCH_ATTR_TYPE_CONFLICT',
    });

    const listed = await operator.listSearchAttributes({ namespace: scratch });
    expect(listed.customAttributes.tenantId).toBe(INT);
    expect(listed.customAttributes.runId).toBeUndefined();
    expect(listed.customAttributes.runState).toBeUndefined();
  });
});
