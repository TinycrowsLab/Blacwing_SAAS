import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createWorkflowContext,
  findWorkflowContext,
  getActivityContext,
  runWithWorkflowContext,
} from './context.js';

const TENANT_A = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const TENANT_B = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const manager = new AsyncLocalStorageContextManager().enable();
beforeAll(() => {
  context.setGlobalContextManager(manager);
});
afterAll(() => {
  context.disable();
  manager.disable();
});

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('getActivityContext', () => {
  it('fails closed with MISSING_TENANT_CONTEXT outside any scope', () => {
    expect(() => getActivityContext()).toThrowError(
      expect.objectContaining({ code: 'MISSING_TENANT_CONTEXT' }) as Error,
    );
    expect(findWorkflowContext()).toBeUndefined();
  });

  it('returns the scoped context, including across awaits', async () => {
    await runWithWorkflowContext(
      { tenantId: TENANT_A, traceId: TRACE, runId: 'run_1' },
      async () => {
        await tick(1);
        expect(getActivityContext()).toEqual({
          tenantId: TENANT_A,
          traceId: TRACE,
          runId: 'run_1',
        });
      },
    );
    expect(findWorkflowContext()).toBeUndefined();
  });

  it('isolates concurrent scopes of different tenants (no leak between activities)', async () => {
    const seen: string[] = [];
    const activity = (tenantId: string, delay: number): Promise<void> =>
      runWithWorkflowContext({ tenantId, traceId: TRACE }, async () => {
        await tick(delay);
        seen.push(`${tenantId}:${getActivityContext().tenantId}`);
        await tick(delay);
        seen.push(`${tenantId}:${getActivityContext().tenantId}`);
      });
    await Promise.all([activity(TENANT_A, 3), activity(TENANT_B, 1), activity(TENANT_A, 2)]);
    expect(seen).toHaveLength(6);
    for (const entry of seen) {
      const [expected, actual] = entry.split(':');
      expect(actual).toBe(expected);
    }
  });

  it('restores the outer scope after a nested scope ends', () => {
    runWithWorkflowContext({ tenantId: TENANT_A, traceId: TRACE }, () => {
      runWithWorkflowContext({ tenantId: TENANT_B, traceId: TRACE }, () => {
        expect(getActivityContext().tenantId).toBe(TENANT_B);
      });
      expect(getActivityContext().tenantId).toBe(TENANT_A);
    });
  });
});

describe('createWorkflowContext', () => {
  it('rejects an empty tenant as MISSING_TENANT_CONTEXT', () => {
    expect(() => createWorkflowContext({ tenantId: '' })).toThrowError(
      expect.objectContaining({ code: 'MISSING_TENANT_CONTEXT' }) as Error,
    );
  });

  it('rejects a non-uuid tenant as INVALID_TENANT_CONTEXT, without echoing it', () => {
    expect(() => createWorkflowContext({ tenantId: 'acme-corp' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_TENANT_CONTEXT' }) as Error,
    );
    expect(() => createWorkflowContext({ tenantId: 'acme-corp' })).not.toThrowError(/acme-corp/);
  });

  it('accepts the SYSTEM sentinel', () => {
    expect(createWorkflowContext({ tenantId: 'SYSTEM', traceId: TRACE }).tenantId).toBe('SYSTEM');
  });

  it('generates a valid trace id when none is given or active', () => {
    const first = createWorkflowContext({ tenantId: TENANT_A });
    const second = createWorkflowContext({ tenantId: TENANT_A });
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.traceId).not.toBe(second.traceId);
  });

  it('adopts the active OpenTelemetry trace id', () => {
    const span = trace.wrapSpanContext({
      traceId: TRACE,
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });
    const created = context.with(trace.setSpan(context.active(), span), () =>
      createWorkflowContext({ tenantId: TENANT_A }),
    );
    expect(created.traceId).toBe(TRACE);
  });

  it('prefers an explicit trace id over the active span', () => {
    const span = trace.wrapSpanContext({
      traceId: TRACE,
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });
    const explicit = 'b'.repeat(32);
    const created = context.with(trace.setSpan(context.active(), span), () =>
      createWorkflowContext({ tenantId: TENANT_A, traceId: explicit }),
    );
    expect(created.traceId).toBe(explicit);
  });
});
