import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithWorkflowContext } from '@blackwing/telemetry';

import { createContextClientInterceptor } from './context-interceptor.js';
import { closeTemporal, getTemporalClient } from './temporal-client.js';

import type { Connection, WorkflowClientInterceptor } from '@temporalio/client';

const TENANT = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const decode = (headers: Headers, name: string): unknown => {
  const payload = headers[name];
  return payload === undefined ? undefined : defaultPayloadConverter.fromPayload(payload);
};

const interceptor = createContextClientInterceptor();

/** What an interceptor method forwarded to `next`. The SDK's input types are large; only headers matter. */
interface Forwarded {
  headers?: Headers;
  workflowStartHeaders?: Headers;
  updateHeaders?: Headers;
}
type Method = (input: never, next: never) => unknown;

/** Calls `method` with `input` inside a context scope and returns what it passed on. */
function forward(
  method: Method | undefined,
  input: Forwarded,
  init: Parameters<typeof runWithWorkflowContext>[0] | null = {
    tenantId: TENANT,
    traceId: TRACE,
  },
): { sent: Forwarded[]; next: ReturnType<typeof vi.fn> } {
  if (method === undefined) throw new Error('interceptor method missing');
  const sent: Forwarded[] = [];
  const next = vi.fn((forwarded: Forwarded) => {
    sent.push(forwarded);
    return Promise.resolve();
  });
  const run = (): unknown => method(input as never, next as never);
  if (init === null) run();
  else void runWithWorkflowContext(init, run);
  return { sent, next };
}

const headersOf = (sent: Forwarded[]): Headers => sent[0]?.headers ?? {};

afterEach(async () => {
  await closeTemporal();
});

describe('createContextClientInterceptor', () => {
  it('stamps tenant, trace and run id on a workflow start', () => {
    const { sent } = forward(
      interceptor.startWithDetails,
      { headers: {} },
      { tenantId: TENANT, traceId: TRACE, runId: 'run_1' },
    );
    expect(decode(headersOf(sent), 'x-bw-tenant-id')).toBe(TENANT);
    expect(decode(headersOf(sent), 'x-bw-trace-id')).toBe(TRACE);
    expect(decode(headersOf(sent), 'x-bw-run-id')).toBe('run_1');
  });

  it('fails closed with MISSING_TENANT_CONTEXT when there is no ambient context, sending nothing', () => {
    expect(() => forward(interceptor.startWithDetails, { headers: {} }, null)).toThrowError(
      expect.objectContaining({ code: 'MISSING_TENANT_CONTEXT' }) as Error,
    );
  });

  it.each(['startWithDetails', 'signal', 'signalWithStart', 'query', 'startUpdate'] as const)(
    '%s refuses to leave without a context',
    (name) => {
      expect(() => forward(interceptor[name], { headers: {} }, null)).toThrowError(
        expect.objectContaining({ code: 'MISSING_TENANT_CONTEXT' }) as Error,
      );
    },
  );

  it('stamps both header sets of an update-with-start', () => {
    const { sent } = forward(interceptor.startUpdateWithStart, {
      workflowStartHeaders: {},
      updateHeaders: {},
    });
    expect(decode(sent[0]?.workflowStartHeaders ?? {}, 'x-bw-tenant-id')).toBe(TENANT);
    expect(decode(sent[0]?.updateHeaders ?? {}, 'x-bw-tenant-id')).toBe(TENANT);
  });

  it('overwrites a caller-forged tenant header with the ambient context', () => {
    const forged: Headers = { 'x-bw-tenant-id': defaultPayloadConverter.toPayload(OTHER) };
    const { sent } = forward(interceptor.signal, { headers: forged });
    expect(decode(headersOf(sent), 'x-bw-tenant-id')).toBe(TENANT);
  });

  it('keeps unrelated headers', () => {
    const other: Headers = { 'x-other': defaultPayloadConverter.toPayload('keep') };
    const { sent } = forward(interceptor.query, { headers: other });
    expect(decode(headersOf(sent), 'x-other')).toBe('keep');
  });

  it('uses an injected context source', () => {
    const custom: WorkflowClientInterceptor = createContextClientInterceptor({
      source: () => ({ tenantId: 'SYSTEM', traceId: TRACE }),
    });
    const { sent } = forward(custom.startWithDetails, { headers: {} }, null);
    expect(decode(headersOf(sent), 'x-bw-tenant-id')).toBe('SYSTEM');
  });
});

describe('getTemporalClient wiring', () => {
  function fakeConnection(startWorkflowExecution: ReturnType<typeof vi.fn>): Connection {
    return {
      close: () => Promise.resolve(),
      workflowService: {
        describeNamespace: () => Promise.resolve({}),
        startWorkflowExecution,
      },
    } as unknown as Connection;
  }

  it('sends x-bw-* headers on the start request and refuses to start with no context', async () => {
    const start = vi.fn(() => Promise.resolve({ runId: 'r1' }));
    const client = await getTemporalClient({
      connect: () => Promise.resolve(fakeConnection(start)),
    });

    await expect(
      client.workflow.start('someWorkflow', { taskQueue: 'q', workflowId: 'w1' }),
    ).rejects.toMatchObject({ code: 'MISSING_TENANT_CONTEXT' });
    expect(start).not.toHaveBeenCalled();

    await runWithWorkflowContext({ tenantId: TENANT, traceId: TRACE }, () =>
      client.workflow.start('someWorkflow', { taskQueue: 'q', workflowId: 'w2' }),
    );
    expect(start).toHaveBeenCalledTimes(1);
    const request = (start.mock.calls[0] as unknown as [{ header?: { fields?: Headers } }])[0];
    const fields = request.header?.fields ?? {};
    expect(decode(fields, 'x-bw-tenant-id')).toBe(TENANT);
    expect(decode(fields, 'x-bw-trace-id')).toBe(TRACE);
  });
});
