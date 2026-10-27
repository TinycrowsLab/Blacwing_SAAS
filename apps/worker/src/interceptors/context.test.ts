import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  type WorkflowInfo,
} from '@temporalio/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';
import { getActivityContext, runWithWorkflowContext } from '@blackwing/telemetry';
import { createContextClientInterceptor } from '@blackwing/workflow-shared';

import { createContextActivityInterceptor, createContextWorkerOptions } from './context.js';
import { stampContextHeaders } from './headers.js';
import { createContextSinks } from './tracing.js';
import { createWorkflowContextInterceptors } from './workflow.js';

import type { ActivityInterceptorsFactory, Headers } from '@temporalio/worker';

const TENANT_A = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const TENANT_B = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const manager = new AsyncLocalStorageContextManager().enable();
const log = createLogger('worker-test', { level: 'silent' });

beforeAll(() => {
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
});
afterEach(() => {
  exporter.reset();
});
afterAll(async () => {
  trace.disable();
  context.disable();
  manager.disable();
  await provider.shutdown();
});

function activityFor(factory: ActivityInterceptorsFactory, activityType = 'doWork') {
  // Only the fields the interceptor reads from the SDK's activity `Context`.
  const info = {
    activityType,
    attempt: 1,
    workflowExecution: { workflowId: 'wf-1', runId: 'r-1' },
  };
  const execute = factory({ info } as never).inbound?.execute;
  if (execute === undefined) throw new Error('execute missing');
  return (headers: Headers, body: () => Promise<unknown>) => execute({ args: [], headers }, body);
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('activity interceptor', () => {
  const run = activityFor(createContextActivityInterceptor(log));

  it('exposes the tenant passed at workflow start to getActivityContext()', async () => {
    const headers = stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE, runId: 'run_1' });
    const seen = await run(headers, () => Promise.resolve(getActivityContext()));
    expect(seen).toEqual({ tenantId: TENANT_A, traceId: TRACE, runId: 'run_1' });
  });

  it('does not leak the context after the activity ends', async () => {
    await run(stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE }), () =>
      Promise.resolve(),
    );
    expect(() => getActivityContext()).toThrowError(
      expect.objectContaining({ code: 'MISSING_TENANT_CONTEXT' }) as Error,
    );
  });

  it('isolates two concurrent activities of different tenants on the same worker', async () => {
    const observe = async (tenantId: string, delay: number): Promise<string[]> => {
      const headers = stampContextHeaders({}, { tenantId, traceId: TRACE });
      const seen = (await run(headers, async () => {
        const before = getActivityContext().tenantId;
        await tick(delay);
        const after = getActivityContext().tenantId;
        return [before, after];
      })) as string[];
      return seen;
    };
    const results = await Promise.all([
      observe(TENANT_A, 8),
      observe(TENANT_B, 1),
      observe(TENANT_A, 4),
      observe(TENANT_B, 6),
    ]);
    expect(results).toEqual([
      [TENANT_A, TENANT_A],
      [TENANT_B, TENANT_B],
      [TENANT_A, TENANT_A],
      [TENANT_B, TENANT_B],
    ]);
  });

  it('refuses an activity with no tenant header: non-retryable MISSING_TENANT_CONTEXT, body never runs', async () => {
    const body = vi.fn(() => Promise.resolve());
    const error = await run({}, body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error).toMatchObject({ type: 'MISSING_TENANT_CONTEXT', nonRetryable: true });
    expect(body).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid tenant header as INVALID_TENANT_CONTEXT', async () => {
    const headers = stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE });
    const forged: Headers = {
      ...headers,
      'x-bw-tenant-id': { ...headers['x-bw-tenant-id'], data: new TextEncoder().encode('"acme"') },
    };
    const body = vi.fn(() => Promise.resolve());
    await expect(run(forged, body)).rejects.toMatchObject({ type: 'INVALID_TENANT_CONTEXT' });
    expect(body).not.toHaveBeenCalled();
  });

  it('logs tenant, run and trace ids on every activity', async () => {
    const info = vi.fn();
    const spy = { ...log, info, error: vi.fn(), warn: vi.fn() } as unknown as typeof log;
    const spied = activityFor(createContextActivityInterceptor(spy));
    await spied(
      stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE, runId: 'run_1' }),
      () => Promise.resolve(),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, runId: 'run_1', traceId: TRACE }),
      'activity started',
    );
  });

  it('records an activity span with bw.tenant_id and bw.run_id, errored when the activity throws', async () => {
    const headers = stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE, runId: 'run_1' });
    await expect(run(headers, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('bw.activity doWork');
    expect(span?.attributes).toMatchObject({ 'bw.tenant_id': TENANT_A, 'bw.run_id': 'run_1' });
    expect(span?.spanContext().traceId).toBe(TRACE);
    expect(span?.status.code).toBe(2);
  });

  it('puts nested spans started by the activity into the run trace', async () => {
    await run(stampContextHeaders({}, { tenantId: TENANT_A, traceId: TRACE }), () => {
      trace.getTracer('test').startSpan('db.query').end();
      return Promise.resolve();
    });
    const names = exporter.getFinishedSpans().map((s) => [s.name, s.spanContext().traceId]);
    expect(names).toContainEqual(['db.query', TRACE]);
  });

  it('wires the activity interceptor, the client and the workflow sinks into the worker options', () => {
    const options = createContextWorkerOptions(log);
    expect(options.interceptors.activity).toHaveLength(1);
    expect(options.interceptors.client?.workflow).toHaveLength(1);
    expect(Object.keys(options.sinks.bwContext).sort()).toEqual(['recordReject', 'recordSpan']);
  });
});

describe('one trace across client, workflow and activity', () => {
  it('gives the workflow span and the activity span the trace id of the starting scope', async () => {
    // 1. The caller starts a workflow inside a scope; the client interceptor stamps the headers.
    let startHeaders: Headers = {};
    const client = createContextClientInterceptor();
    await runWithWorkflowContext({ tenantId: TENANT_A, runId: 'run_7' }, async () => {
      await client.startWithDetails?.({ headers: {} } as never, (input: { headers: Headers }) => {
        startHeaders = input.headers;
        return Promise.resolve({ runId: 'run', eagerlyStarted: false });
      });
    });
    const traceId = defaultPayloadConverter.fromPayload<string>(
      startHeaders['x-bw-trace-id'] as never,
    );
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    // 2. The worker runs the workflow; its span goes through the sink like in production.
    const sinks = createContextSinks(log);
    const info = { workflowType: 'RunWorkflow', workflowId: 'wf-7' } as WorkflowInfo;
    let activityHeaders: Headers = {};
    let clock = 1_000;
    const { inbound, outbound } = createWorkflowContextInterceptors({
      recordSpan: (span) => void sinks.bwContext.recordSpan.fn(info, span),
      recordReject: (reason, code) => void sinks.bwContext.recordReject.fn(info, reason, code),
      workflowType: () => info.workflowType,
      now: () => (clock += 5),
    });
    await inbound?.[0]?.execute?.({ args: [], headers: startHeaders }, async () => {
      await outbound?.[0]?.scheduleActivity?.(
        { headers: {}, activityType: 'doWork' } as never,
        (i: { headers: Headers }) => {
          activityHeaders = i.headers;
          return Promise.resolve();
        },
      );
    });

    // 3. The activity runs on the worker with the headers the workflow stamped.
    await activityFor(createContextActivityInterceptor(log))(activityHeaders, () =>
      Promise.resolve(),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'bw.activity doWork',
      'bw.workflow RunWorkflow',
    ]);
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));
    for (const span of spans) {
      expect(span.attributes).toMatchObject({ 'bw.tenant_id': TENANT_A, 'bw.run_id': 'run_7' });
    }
  });
});

describe('workflow sinks', () => {
  const info = { workflowType: 'RunWorkflow', workflowId: 'wf-1' } as WorkflowInfo;

  it('turns a workflow record into a span with its own start and end time', async () => {
    await createContextSinks(log).bwContext.recordSpan.fn(info, {
      name: 'bw.workflow RunWorkflow',
      traceId: TRACE,
      tenantId: TENANT_A,
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_003_000,
      failed: true,
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(TRACE);
    expect(span?.status.code).toBe(2);
    expect(span?.attributes).toMatchObject({
      'bw.tenant_id': TENANT_A,
      'temporal.workflow.type': 'RunWorkflow',
      'temporal.workflow.id': 'wf-1',
    });
    expect(span?.duration[0]).toBe(3);
  });

  it('is skipped during replay (no duplicate spans or counts)', () => {
    const sinks = createContextSinks(log).bwContext;
    expect(sinks.recordSpan.callDuringReplay).not.toBe(true);
    expect(sinks.recordReject.callDuringReplay).not.toBe(true);
  });

  it('logs a refusal with ids only', async () => {
    const warn = vi.fn();
    const spy = { ...log, warn } as unknown as typeof log;
    await createContextSinks(spy).bwContext.recordReject.fn(
      info,
      'tenant_mismatch',
      'TENANT_CONTEXT_MISMATCH',
    );
    expect(warn).toHaveBeenCalledWith(
      {
        workflowType: 'RunWorkflow',
        workflowId: 'wf-1',
        reason: 'tenant_mismatch',
        code: 'TENANT_CONTEXT_MISMATCH',
      },
      'workflow context refused',
    );
  });
});
