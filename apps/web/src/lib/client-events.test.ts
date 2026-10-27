import { describe, expect, it } from 'vitest';

import { emitClientEvent, routeName, setClientEventSink, type ClientEvent } from './client-events';

describe('routeName', () => {
  it('replaces ids and drops query and hash', () => {
    expect(routeName('/runs/123456/findings/0b9f1c2e-1111-4222-8333-444455556666?tab=1#x')).toBe(
      '/runs/:id/findings/:id',
    );
    expect(routeName('/assets')).toBe('/assets');
    expect(routeName('')).toBe('/');
  });
});

describe('emitClientEvent', () => {
  it('emits only whitelisted fields and drops unsafe identifiers', () => {
    const seen: ClientEvent[] = [];
    const restore = setClientEventSink((e) => seen.push(e));
    emitClientEvent('error_boundary_trip', '/runs/99', {
      code: 'RUN_NOT_ACTIVE',
      traceId: 'bad trace with spaces and secret=abc',
    });
    restore();
    expect(seen).toEqual([
      { event: 'error_boundary_trip', route: '/runs/:id', code: 'RUN_NOT_ACTIVE' },
    ]);
  });

  it('carries a kill request run id and idempotency key, dropping unsafe values', () => {
    const seen: ClientEvent[] = [];
    const restore = setClientEventSink((e) => seen.push(e));
    emitClientEvent('kill_requested', '/assessments/run_x', {
      runId: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
      idempotencyKey: '0190-abc',
    });
    emitClientEvent('kill_requested', '/assessments/x', {
      runId: 'has spaces',
      idempotencyKey: 'a=b;c',
    });
    restore();
    expect(seen).toEqual([
      {
        event: 'kill_requested',
        route: '/assessments/run_x',
        runId: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
        idempotencyKey: '0190-abc',
      },
      { event: 'kill_requested', route: '/assessments/x' },
    ]);
  });

  it('never throws when the sink throws', () => {
    const restore = setClientEventSink(() => {
      throw new Error('boom');
    });
    expect(() => {
      emitClientEvent('permission_denied_view', '/x');
    }).not.toThrow();
    restore();
  });
});
