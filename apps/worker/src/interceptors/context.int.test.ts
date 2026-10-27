// #25 integration: tenant and trace context across a real Temporal worker (`pnpm dev:deps`):
// client -> workflow -> activity -> child workflow, signal gating and concurrent-tenant isolation.
// TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override the dev defaults.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';
import { runWithWorkflowContext } from '@blackwing/telemetry';
import { createContextClientInterceptor } from '@blackwing/workflow-shared';

import { createContextWorkerOptions, WORKFLOW_INTERCEPTOR_MODULE } from './context.js';
import * as activities from './testdata/activities.js';

import type { contextProbeWorkflow, signalGateWorkflow } from './testdata/workflows.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const taskQueue = `bw-context-${randomUUID()}`;
const TENANT_A = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const TENANT_B = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager().enable();

const id = (prefix: string): string => `${prefix}-${randomUUID()}`;

describe('tenant and trace context propagation', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;
  let rawClient: Client;
  let worker: Worker;
  let running: Promise<void>;

  beforeAll(async () => {
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({
      connection,
      namespace,
      interceptors: { workflow: [createContextClientInterceptor()] },
    });
    rawClient = new Client({ connection, namespace });
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./testdata/workflows.ts', import.meta.url)),
      workflowInterceptorModules: [WORKFLOW_INTERCEPTOR_MODULE],
    });
    worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowBundle: { code },
      activities,
      ...createContextWorkerOptions(createLogger('worker-context-test')),
    });
    running = worker.run();
  });

  afterAll(async () => {
    worker.shutdown();
    await running;
    await connection.close();
    await native.close();
    trace.disable();
    context.disable();
    contextManager.disable();
    await provider.shutdown();
  });

  const start = (tenantId: string, withChild: boolean, sleepMs = 0, runId?: string) =>
    runWithWorkflowContext({ tenantId, runId }, () =>
      client.workflow.start<typeof contextProbeWorkflow>('contextProbeWorkflow', {
        taskQueue,
        workflowId: id('probe'),
        args: [{ sleepMs, withChild }],
      }),
    );

  it('an activity sees the tenant passed at workflow start, and a child inherits tenant and trace', async () => {
    const handle = await start(TENANT_A, true, 0, 'run_ctx_1');
    const result = await handle.result();
    expect(result.activity.tenantId).toBe(TENANT_A);
    expect(result.child?.activity.tenantId).toBe(TENANT_A);
    expect(result.child?.activity.traceId).toBe(result.activity.traceId);
  });

  it('refuses to start a workflow with no tenant context (client side, fail closed)', async () => {
    await expect(
      client.workflow.start('contextProbeWorkflow', {
        taskQueue,
        workflowId: id('no-ctx'),
        args: [{ sleepMs: 0, withChild: false }],
      }),
    ).rejects.toMatchObject({ code: 'MISSING_TENANT_CONTEXT' });
  });

  it('fails a workflow started by a client that bypassed the interceptor with MISSING_TENANT_CONTEXT', async () => {
    const handle = await rawClient.workflow.start<typeof contextProbeWorkflow>(
      'contextProbeWorkflow',
      {
        taskQueue,
        workflowId: id('raw'),
        args: [{ sleepMs: 0, withChild: false }],
      },
    );
    const error = await handle.result().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect((error as WorkflowFailedError).cause).toMatchObject({ type: 'MISSING_TENANT_CONTEXT' });
  });

  it('drops a signal from another tenant and accepts one from the owning tenant', async () => {
    const handle = await runWithWorkflowContext({ tenantId: TENANT_A }, () =>
      client.workflow.start<typeof signalGateWorkflow>('signalGateWorkflow', {
        taskQueue,
        workflowId: id('gate'),
      }),
    );
    const poke = 'poke';
    await runWithWorkflowContext({ tenantId: TENANT_B }, () => handle.signal(poke));
    const pokes = await runWithWorkflowContext({ tenantId: TENANT_A }, () =>
      handle.query<number>('pokes'),
    );
    expect(pokes).toBe(0);
    await expect(
      runWithWorkflowContext({ tenantId: TENANT_B }, () => handle.query<number>('pokes')),
    ).rejects.toThrow();
    await runWithWorkflowContext({ tenantId: TENANT_A }, () => handle.signal(poke));
    await expect(handle.result()).resolves.toBe(1);
  });

  it('keeps concurrent activities of different tenants apart', async () => {
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        start(i % 2 === 0 ? TENANT_A : TENANT_B, false, 50 + (i % 3) * 25),
      ),
    );
    const results = await Promise.all(handles.map((h) => h.result()));
    results.forEach((result, i) => {
      expect(result.activity.tenantId).toBe(i % 2 === 0 ? TENANT_A : TENANT_B);
    });
  });

  it('puts the workflow span and the activity span in one trace', async () => {
    exporter.reset();
    const handle = await start(TENANT_A, false, 0, 'run_ctx_trace');
    const { activity } = await handle.result();
    // The workflow span is emitted through a sink at the end of the run; allow it to flush.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.spanContext().traceId === activity.traceId);
    expect(spans.map((s) => s.name).sort()).toEqual([
      'bw.activity readContext',
      'bw.workflow contextProbeWorkflow',
    ]);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        'bw.tenant_id': TENANT_A,
        'bw.run_id': 'run_ctx_trace',
      });
    }
  });
});
