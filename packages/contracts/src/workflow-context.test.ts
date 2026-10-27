import { describe, expect, it } from 'vitest';

import {
  checkSameTenant,
  parseWorkflowContext,
  SYSTEM_TENANT,
  WORKFLOW_CONTEXT_HEADERS,
  workflowContextToHeaderValues,
} from './workflow-context.js';

const TENANT = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const OTHER_TENANT = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const headers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  [WORKFLOW_CONTEXT_HEADERS.tenantId]: TENANT,
  [WORKFLOW_CONTEXT_HEADERS.traceId]: TRACE,
  ...over,
});

describe('parseWorkflowContext', () => {
  it('accepts a tenant uuid with a trace id', () => {
    expect(parseWorkflowContext(headers())).toEqual({
      ok: true,
      context: { tenantId: TENANT, traceId: TRACE },
    });
  });

  it('carries the optional run id', () => {
    const parsed = parseWorkflowContext(headers({ [WORKFLOW_CONTEXT_HEADERS.runId]: 'run_abc' }));
    expect(parsed).toEqual({
      ok: true,
      context: { tenantId: TENANT, traceId: TRACE, runId: 'run_abc' },
    });
  });

  it('accepts the explicit SYSTEM sentinel for platform workflows', () => {
    const parsed = parseWorkflowContext(
      headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: SYSTEM_TENANT }),
    );
    expect(parsed).toMatchObject({ ok: true, context: { tenantId: 'SYSTEM' } });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])('refuses a %s tenant as MISSING_TENANT_CONTEXT', (_name, value) => {
    const parsed = parseWorkflowContext(headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: value }));
    expect(parsed).toMatchObject({
      ok: false,
      code: 'MISSING_TENANT_CONTEXT',
      reason: 'missing_tenant',
    });
  });

  it('refuses an entirely empty header set as MISSING_TENANT_CONTEXT', () => {
    expect(parseWorkflowContext({})).toMatchObject({ ok: false, code: 'MISSING_TENANT_CONTEXT' });
  });

  it.each([
    ['not a uuid', 'acme'],
    ['a lowercase sentinel', 'system'],
    ['a number', 42],
    ['an object', { id: TENANT }],
    ['a uuid with trailing text', `${TENANT} `],
    ['a sql fragment', "' OR 1=1 --"],
  ])('refuses %s as INVALID_TENANT_CONTEXT', (_name, value) => {
    const parsed = parseWorkflowContext(headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: value }));
    expect(parsed).toMatchObject({
      ok: false,
      code: 'INVALID_TENANT_CONTEXT',
      reason: 'invalid_tenant',
    });
  });

  it.each([
    ['missing', undefined],
    ['short', 'abc'],
    ['uppercase', TRACE.toUpperCase()],
    ['all zero', '0'.repeat(32)],
  ])('refuses a %s trace id as INVALID_TENANT_CONTEXT', (_name, value) => {
    const parsed = parseWorkflowContext(headers({ [WORKFLOW_CONTEXT_HEADERS.traceId]: value }));
    expect(parsed).toMatchObject({ ok: false, code: 'INVALID_TENANT_CONTEXT' });
  });

  it('refuses an oversized run id', () => {
    const parsed = parseWorkflowContext(
      headers({ [WORKFLOW_CONTEXT_HEADERS.runId]: 'r'.repeat(129) }),
    );
    expect(parsed).toMatchObject({ ok: false, code: 'INVALID_TENANT_CONTEXT' });
  });

  it('never echoes a header value in the refusal message', () => {
    const parsed = parseWorkflowContext(
      headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: 'secret-tenant-value' }),
    );
    expect(JSON.stringify(parsed)).not.toContain('secret-tenant-value');
  });
});

describe('workflowContextToHeaderValues', () => {
  it('round-trips through parseWorkflowContext', () => {
    const context = { tenantId: TENANT, traceId: TRACE, runId: 'run_1' };
    expect(parseWorkflowContext(workflowContextToHeaderValues(context))).toEqual({
      ok: true,
      context,
    });
  });

  it('omits the run id header when there is none', () => {
    expect(
      Object.keys(workflowContextToHeaderValues({ tenantId: TENANT, traceId: TRACE })),
    ).toEqual([WORKFLOW_CONTEXT_HEADERS.tenantId, WORKFLOW_CONTEXT_HEADERS.traceId]);
  });
});

describe('checkSameTenant', () => {
  const running = { tenantId: TENANT, traceId: TRACE };

  it('accepts a message from the same tenant even with another trace id', () => {
    const other = headers({ [WORKFLOW_CONTEXT_HEADERS.traceId]: 'a'.repeat(32) });
    expect(checkSameTenant(running, other)).toMatchObject({ ok: true });
  });

  it('refuses another tenant as TENANT_CONTEXT_MISMATCH', () => {
    const parsed = checkSameTenant(
      running,
      headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: OTHER_TENANT }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      code: 'TENANT_CONTEXT_MISMATCH',
      reason: 'tenant_mismatch',
    });
  });

  it('refuses SYSTEM talking to a tenant workflow and the reverse', () => {
    const system = headers({ [WORKFLOW_CONTEXT_HEADERS.tenantId]: SYSTEM_TENANT });
    expect(checkSameTenant(running, system)).toMatchObject({ code: 'TENANT_CONTEXT_MISMATCH' });
    expect(checkSameTenant({ tenantId: SYSTEM_TENANT, traceId: TRACE }, headers())).toMatchObject({
      code: 'TENANT_CONTEXT_MISMATCH',
    });
  });

  it('refuses a message with no tenant header', () => {
    expect(checkSameTenant(running, {})).toMatchObject({ code: 'MISSING_TENANT_CONTEXT' });
  });
});
