import {
  ApplicationFailure,
  ContinueAsNew,
  defaultPayloadConverter,
  type Headers,
} from '@temporalio/workflow';
import { describe, expect, it, vi } from 'vitest';

import { decodeContextHeaders, stampContextHeaders } from './headers.js';
import {
  createWorkflowContextInterceptors,
  type ContextInterceptorDeps,
  type WorkflowSpanRecord,
} from './workflow.js';

const TENANT = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

interface Ids {
  traceId: string;
  runId: string;
}

const headersFor = (tenantId: string, extra: Partial<Ids> = {}): Headers =>
  stampContextHeaders({}, { tenantId, traceId: extra.traceId ?? TRACE, ...extra });

/** An interceptor method that the SDK types as optional; the tests need it to exist. */
function must<T>(method: T | undefined): T {
  if (method === undefined) throw new Error('interceptor method missing');
  return method;
}

type Any = (input: never, next: never) => unknown;
// The SDK's interceptor inputs are large; the interceptors only read and replace `headers`.
const call = (method: unknown, input: object, next: unknown): unknown =>
  (must(method) as Any)(input as never, next as never);
const headersOf = (value: unknown): Headers => (value as { headers: Headers }).headers;

function setup(now = [1_000, 2_500]) {
  const spans: WorkflowSpanRecord[] = [];
  const rejects: [string, string][] = [];
  const clock = [...now];
  const deps: ContextInterceptorDeps = {
    recordSpan: (span) => spans.push(span),
    recordReject: (reason, code) => rejects.push([reason, code]),
    workflowType: () => 'TestWorkflow',
    now: () => clock.shift() ?? 9_999,
  };
  const { inbound, outbound } = createWorkflowContextInterceptors(deps);
  const [inbound0] = inbound ?? [];
  const [outbound0] = outbound ?? [];
  return { inbound: must(inbound0), outbound: must(outbound0), spans, rejects };
}
type Setup = ReturnType<typeof setup>;

async function failureOf(run: () => unknown): Promise<ApplicationFailure> {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(ApplicationFailure);
  return error as ApplicationFailure;
}

/** Runs `body` as the workflow function under a started workflow of `tenantId`. */
function startWorkflow(
  t: Setup,
  tenantId: string,
  body: () => Promise<unknown> = () => Promise.resolve('done'),
  extra: Partial<Ids> = {},
): Promise<unknown> {
  return call(
    t.inbound.execute,
    { args: [], headers: headersFor(tenantId, extra) },
    body,
  ) as Promise<unknown>;
}

const outboundHeaders = async (
  t: Setup,
  method: unknown,
  headers: Headers = {},
): Promise<Headers> => {
  let sent: Headers = {};
  await call(method, { headers }, (value: unknown) => {
    sent = headersOf(value);
    return Promise.resolve();
  });
  return sent;
};

describe('execute', () => {
  it('fails the workflow with MISSING_TENANT_CONTEXT when there is no tenant header', async () => {
    const t = setup();
    const next = vi.fn();
    const failure = await failureOf(() => call(t.inbound.execute, { args: [], headers: {} }, next));
    expect(failure).toMatchObject({ type: 'MISSING_TENANT_CONTEXT', nonRetryable: true });
    expect(next).not.toHaveBeenCalled();
    expect(t.rejects).toEqual([['missing_tenant', 'MISSING_TENANT_CONTEXT']]);
  });

  it('fails with INVALID_TENANT_CONTEXT for a non-uuid tenant', async () => {
    const t = setup();
    const headers = { 'x-bw-tenant-id': defaultPayloadConverter.toPayload('not-a-uuid') };
    const failure = await failureOf(() => call(t.inbound.execute, { args: [], headers }, vi.fn()));
    expect(failure.type).toBe('INVALID_TENANT_CONTEXT');
    expect(t.rejects).toEqual([['invalid_tenant', 'INVALID_TENANT_CONTEXT']]);
  });

  it('fails with INVALID_TENANT_CONTEXT for an undecodable header payload', async () => {
    const t = setup();
    const encoder = new TextEncoder();
    const headers: Headers = {
      'x-bw-tenant-id': {
        metadata: { encoding: encoder.encode('json/plain') },
        data: encoder.encode('{not json'),
      },
    };
    const failure = await failureOf(() => call(t.inbound.execute, { args: [], headers }, vi.fn()));
    expect(failure.type).toBe('INVALID_TENANT_CONTEXT');
  });

  it('accepts the SYSTEM sentinel for platform workflows', async () => {
    const t = setup();
    await expect(startWorkflow(t, 'SYSTEM')).resolves.toBe('done');
    expect(t.spans[0]).toMatchObject({ tenantId: 'SYSTEM' });
  });

  it('reports a span of the run with the header trace id, tenant and run id', async () => {
    const t = setup();
    await startWorkflow(t, TENANT, undefined, { runId: 'run_9' });
    expect(t.spans).toEqual([
      {
        name: 'bw.workflow TestWorkflow',
        traceId: TRACE,
        tenantId: TENANT,
        runId: 'run_9',
        startMs: 1_000,
        endMs: 2_500,
        failed: false,
      },
    ]);
  });

  it('marks the span failed and rethrows when the workflow throws', async () => {
    const t = setup();
    const boom = new Error('boom');
    await expect(startWorkflow(t, TENANT, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(t.spans[0]?.failed).toBe(true);
  });

  it('does not mark continue-as-new as a failure', async () => {
    const t = setup();
    const continued = new ContinueAsNew({ workflowType: 'TestWorkflow', args: [] } as never);
    await expect(startWorkflow(t, TENANT, () => Promise.reject(continued))).rejects.toBe(continued);
    expect(t.spans[0]?.failed).toBe(false);
  });
});

describe('outbound re-injection', () => {
  it('stamps tenant, trace and run id on activities, local activities, children, signals and continue-as-new', async () => {
    const t = setup();
    const sent: Headers[] = [];
    await startWorkflow(
      t,
      TENANT,
      async () => {
        const methods = [
          t.outbound.scheduleActivity,
          t.outbound.scheduleLocalActivity,
          t.outbound.startChildWorkflowExecution,
          t.outbound.signalWorkflow,
          t.outbound.continueAsNew,
        ];
        for (const method of methods) sent.push(await outboundHeaders(t, method));
      },
      { runId: 'run_9' },
    );
    expect(sent).toHaveLength(5);
    for (const headers of sent) {
      expect(decodeContextHeaders(headers)).toEqual({
        'x-bw-tenant-id': TENANT,
        'x-bw-trace-id': TRACE,
        'x-bw-run-id': 'run_9',
      });
    }
  });

  it('lets a child workflow inherit the parent context without the caller passing it', async () => {
    const parent = setup();
    let childStartHeaders: Headers = {};
    await startWorkflow(parent, TENANT, async () => {
      childStartHeaders = await outboundHeaders(
        parent,
        parent.outbound.startChildWorkflowExecution,
      );
    });
    // The child's own interceptor chain reads exactly what the parent sent.
    const child = setup();
    await call(child.inbound.execute, { args: [], headers: childStartHeaders }, () =>
      Promise.resolve('child-ok'),
    );
    expect(child.spans[0]).toMatchObject({ tenantId: TENANT, traceId: TRACE, failed: false });
    expect(child.rejects).toEqual([]);
  });

  it('overwrites an activity header a workflow tried to forge', async () => {
    const t = setup();
    let sent: Headers = {};
    await startWorkflow(t, TENANT, async () => {
      sent = await outboundHeaders(t, t.outbound.scheduleActivity, headersFor(OTHER));
    });
    expect(decodeContextHeaders(sent)['x-bw-tenant-id']).toBe(TENANT);
  });

  it('refuses an outbound call made before any context exists', () => {
    const t = setup();
    const next = vi.fn();
    expect(() => call(t.outbound.scheduleActivity, { headers: {} }, next)).toThrowError(
      ApplicationFailure,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('adds tenant, trace and run id to workflow log attributes', async () => {
    const t = setup();
    let attributes: unknown;
    await startWorkflow(
      t,
      TENANT,
      () => {
        attributes = call(t.outbound.getLogAttributes, { a: 1 }, (value: unknown) => value);
        return Promise.resolve();
      },
      { runId: 'run_9' },
    );
    expect(attributes).toEqual({
      a: 1,
      bw_tenant_id: TENANT,
      bw_trace_id: TRACE,
      bw_run_id: 'run_9',
    });
  });
});

describe('inbound messages', () => {
  const handled = () => vi.fn(() => Promise.resolve('handled'));
  const signal = (headers: Headers) => ({ signalName: 's', args: [], headers });
  const query = (headers: Headers, queryName = 'progress') => ({
    queryId: 'q',
    queryName,
    args: [],
    headers,
  });
  const update = (headers: Headers) => ({ updateId: 'u', name: 'u', args: [], headers });

  it('delivers a signal from the same tenant', async () => {
    const t = setup();
    const handler = vi.fn(() => Promise.resolve());
    await startWorkflow(
      t,
      TENANT,
      () => call(t.inbound.handleSignal, signal(headersFor(TENANT)), handler) as Promise<unknown>,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('drops a signal carrying another tenant and records TENANT_CONTEXT_MISMATCH, without failing the workflow', async () => {
    const t = setup();
    const handler = vi.fn(() => Promise.resolve());
    await expect(
      startWorkflow(t, TENANT, async () => {
        await call(t.inbound.handleSignal, signal(headersFor(OTHER)), handler);
        return 'still-running';
      }),
    ).resolves.toBe('still-running');
    expect(handler).not.toHaveBeenCalled();
    expect(t.rejects).toEqual([['tenant_mismatch', 'TENANT_CONTEXT_MISMATCH']]);
  });

  it('drops a signal with no tenant header and one pretending to be SYSTEM', async () => {
    const t = setup();
    const handler = vi.fn(() => Promise.resolve());
    await startWorkflow(t, TENANT, async () => {
      await call(t.inbound.handleSignal, signal({}), handler);
      await call(t.inbound.handleSignal, signal(headersFor('SYSTEM')), handler);
    });
    expect(handler).not.toHaveBeenCalled();
    expect(t.rejects).toEqual([
      ['missing_tenant', 'MISSING_TENANT_CONTEXT'],
      ['tenant_mismatch', 'TENANT_CONTEXT_MISMATCH'],
    ]);
  });

  it('drops a signal that arrives before the workflow has a context (fail closed)', async () => {
    const t = setup();
    const handler = vi.fn(() => Promise.resolve());
    await call(t.inbound.handleSignal, signal(headersFor(TENANT)), handler);
    expect(handler).not.toHaveBeenCalled();
    expect(t.rejects).toEqual([['missing_tenant', 'MISSING_TENANT_CONTEXT']]);
  });

  it('answers a query from the same tenant', async () => {
    const t = setup();
    await startWorkflow(t, TENANT, async () => {
      await expect(call(t.inbound.handleQuery, query(headersFor(TENANT)), handled())).resolves.toBe(
        'handled',
      );
    });
  });

  it('refuses a query from another tenant without running the handler', async () => {
    const t = setup();
    const denied = handled();
    await startWorkflow(t, TENANT, async () => {
      const failure = await failureOf(() =>
        call(t.inbound.handleQuery, query(headersFor(OTHER)), denied),
      );
      expect(failure.type).toBe('TENANT_CONTEXT_MISMATCH');
    });
    expect(denied).not.toHaveBeenCalled();
  });

  it('refuses a query without tenant headers but lets SDK-internal queries through', async () => {
    const t = setup();
    await startWorkflow(t, TENANT, async () => {
      const failure = await failureOf(() => call(t.inbound.handleQuery, query({}), handled()));
      expect(failure.type).toBe('MISSING_TENANT_CONTEXT');
      await expect(
        call(t.inbound.handleQuery, query({}, '__stack_trace'), handled()),
      ).resolves.toBe('handled');
    });
  });

  it('rejects an update from another tenant at validation and at handling', async () => {
    const t = setup();
    const validate = vi.fn();
    const handle = handled();
    await startWorkflow(t, TENANT, async () => {
      const forged = update(headersFor(OTHER));
      const validation = await failureOf(() => call(t.inbound.validateUpdate, forged, validate));
      expect(validation.type).toBe('TENANT_CONTEXT_MISMATCH');
      const handling = await failureOf(() => call(t.inbound.handleUpdate, forged, handle));
      expect(handling.type).toBe('TENANT_CONTEXT_MISMATCH');
    });
    expect(validate).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('accepts an update from the same tenant', async () => {
    const t = setup();
    const validate = vi.fn();
    await startWorkflow(t, TENANT, async () => {
      const own = update(headersFor(TENANT));
      call(t.inbound.validateUpdate, own, validate);
      expect(validate).toHaveBeenCalledOnce();
      await expect(call(t.inbound.handleUpdate, own, handled())).resolves.toBe('handled');
    });
  });
});

describe('isolation between workflow instances', () => {
  it('keeps each instance on its own tenant', async () => {
    const a = setup();
    const b = setup();
    let seenA: Headers = {};
    let seenB: Headers = {};
    await Promise.all([
      startWorkflow(a, TENANT, async () => {
        await Promise.resolve();
        seenA = await outboundHeaders(a, a.outbound.scheduleActivity);
      }),
      startWorkflow(b, OTHER, async () => {
        seenB = await outboundHeaders(b, b.outbound.scheduleActivity);
      }),
    ]);
    expect(decodeContextHeaders(seenA)['x-bw-tenant-id']).toBe(TENANT);
    expect(decodeContextHeaders(seenB)['x-bw-tenant-id']).toBe(OTHER);
  });
});
