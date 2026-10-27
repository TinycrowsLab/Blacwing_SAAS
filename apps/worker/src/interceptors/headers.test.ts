import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';

import { refuse } from '@blackwing/contracts/workflow-context';

import { contextFailure, decodeContextHeaders, stampContextHeaders } from './headers.js';

const TENANT = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('context headers', () => {
  it('round-trips a context through JSON payloads', () => {
    const headers = stampContextHeaders({}, { tenantId: TENANT, traceId: TRACE, runId: 'run_1' });
    expect(Object.keys(headers).sort()).toEqual(['x-bw-run-id', 'x-bw-tenant-id', 'x-bw-trace-id']);
    expect(decodeContextHeaders(headers)).toEqual({
      'x-bw-tenant-id': TENANT,
      'x-bw-trace-id': TRACE,
      'x-bw-run-id': 'run_1',
    });
  });

  it('keeps unrelated headers and replaces existing x-bw headers', () => {
    const base = {
      'x-keep': defaultPayloadConverter.toPayload('k'),
      'x-bw-tenant-id': defaultPayloadConverter.toPayload('old'),
    };
    const headers = stampContextHeaders(base, { tenantId: TENANT, traceId: TRACE });
    expect(headers['x-keep']).toBe(base['x-keep']);
    expect(decodeContextHeaders(headers)['x-bw-tenant-id']).toBe(TENANT);
  });

  it('ignores headers that are not part of the context', () => {
    const headers = { 'x-other': defaultPayloadConverter.toPayload('v') };
    expect(decodeContextHeaders(headers)).toEqual({});
  });

  it('turns a refusal into a non-retryable failure typed with the error code', () => {
    const failure = contextFailure(refuse('MISSING_TENANT_CONTEXT', 'nope'));
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe('MISSING_TENANT_CONTEXT');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toBe('nope');
  });
});
