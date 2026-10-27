import { describe, expect, it } from 'vitest';

import { getActivityContext } from '@blackwing/telemetry';

import { DONE_RUN, harness, LIVE_RUN, principal, TENANT_A } from './fixtures.test-helpers.js';
import { InMemoryKillAuditSink } from './memory.js';
import {
  KILL_TRIGGER_SPAN,
  KillService,
  parseKillRequest,
  type KillServiceDeps,
} from './service.js';
import {
  createTemporalKillSignaler,
  KILL_PROPAGATION_WORKFLOW,
  KILL_TARGETS_SIGNAL,
  killPropagationWorkflowId,
  type SignalWithStartClient,
} from './temporal-signaler.js';

const appsec = principal(['appsec_engineer']);

/** The stable `code` of what `fn` throws, or `undefined` when it does not throw. */
function thrownCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  return undefined;
}
const runKill = { scope: 'run', scopeRefId: LIVE_RUN, reason: 'secret=hunter2 leaking' };

describe('parseKillRequest (Zod validation and code mapping)', () => {
  it.each([
    [{ scope: 'global', reason: 'abc' }, 'KILL_GLOBAL_NOT_ALLOWED_HERE'],
    [{ scope: 'galaxy', reason: 'abc' }, 'KILL_SCOPE_INVALID'],
    [{ reason: 'abc' }, 'KILL_SCOPE_INVALID'],
    [{ scope: 'asset', reason: 'abc' }, 'KILL_REF_REQUIRED'],
    [{ scope: 'run', scopeRefId: null, reason: 'abc' }, 'KILL_REF_REQUIRED'],
    [{ scope: 'tenant', scopeRefId: LIVE_RUN, reason: 'abc' }, 'KILL_SCOPE_INVALID'],
    [{ scope: 'run', scopeRefId: LIVE_RUN, reason: 'ab' }, 'VALIDATION_FAILED'],
    [{ scope: 'run', scopeRefId: 'nope', reason: 'abc' }, 'VALIDATION_FAILED'],
    ['not an object', 'VALIDATION_FAILED'],
  ])('%j -> %s', (body, code) => {
    expect(thrownCode(() => parseKillRequest(body))).toBe(code);
  });

  it('accepts a tenant kill without a ref', () => {
    expect(parseKillRequest({ scope: 'tenant', reason: 'incident' })).toEqual({
      scope: 'tenant',
      scopeRefId: null,
      reason: 'incident',
    });
  });
});

describe('KillService edge cases', () => {
  it('records an empty target set as halted with halt_ms=0 and does not signal', async () => {
    const h = harness();
    const result = await h.service.trigger({
      principal: appsec,
      body: { scope: 'run', scopeRefId: DONE_RUN, reason: 'already done' },
      idempotencyKey: 'key-empty-01',
      traceId: null,
    });
    expect(result.response.status).toBe('halted');
    const [event] = h.store.list(TENANT_A);
    expect(event).toMatchObject({ status: 'halted', haltMs: 0, completedAt: event?.triggeredAt });
    expect(h.signaler.requests).toHaveLength(0);
    expect(h.audit.records.map((r) => r.action)).toEqual(['kill.triggered']);
  });

  it('dedups concurrent kills of the same scope to the in-flight event', async () => {
    const h = harness();
    const fire = (key: string) =>
      h.service.trigger({ principal: appsec, body: runKill, idempotencyKey: key, traceId: null });
    const [a, b] = await Promise.all([fire('concurrent-a'), fire('concurrent-b')]);
    expect(a.response.killEventId).toBe(b.response.killEventId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(h.store.list(TENANT_A)).toHaveLength(1);
    expect(h.signaler.requests).toHaveLength(1);
    // A different key on the same open scope is bound to the same event from now on.
    const again = await fire('concurrent-b');
    expect(again.response.killEventId).toBe(a.response.killEventId);
  });

  it('dedups concurrent requests with the same Idempotency-Key', async () => {
    const h = harness();
    const fire = () =>
      h.service.trigger({
        principal: appsec,
        body: runKill,
        idempotencyKey: 'same-key-1',
        traceId: null,
      });
    const results = await Promise.all([fire(), fire(), fire()]);
    expect(new Set(results.map((r) => r.response.killEventId)).size).toBe(1);
    expect(h.store.list(TENANT_A)).toHaveLength(1);
  });

  it('refuses an Idempotency-Key reused with a different body', async () => {
    const h = harness();
    await h.service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'reuse-key-1',
      traceId: null,
    });
    await expect(
      h.service.trigger({
        principal: appsec,
        body: { ...runKill, reason: 'something else' },
        idempotencyKey: 'reuse-key-1',
        traceId: null,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH', httpStatus: 422 });
  });

  it('keeps the event initiated, still answers, counts and logs when the enqueue fails', async () => {
    const h = harness({ signaler: { signal: () => Promise.reject(new Error('temporal down')) } });
    const result = await h.service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'enqueue-fail-1',
      traceId: null,
    });
    expect(result.response.status).toBe('initiated');
    expect(h.store.list(TENANT_A)[0]?.status).toBe('initiated');
    const failures = await h.metrics.registry.getSingleMetricAsString(
      'bw_kill_enqueue_failures_total',
    );
    expect(failures).toContain('bw_kill_enqueue_failures_total{scope="run"} 1');
    expect(h.logs.some((l) => l.includes('enqueue failed') && /"level":(50|"error")/.test(l))).toBe(
      true,
    );
    expect(h.audit.records.map((r) => r.action)).toEqual(['kill.triggered']);
  });

  it('fails closed without tenant context, before reading anything', async () => {
    const h = harness();
    await expect(
      h.service.trigger({
        principal: principal(['org_admin'], { tenantId: null }),
        body: { scope: 'tenant', reason: 'stop all' },
        idempotencyKey: 'no-tenant-1',
        traceId: null,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', httpStatus: 401 });
    expect(h.audit.records).toHaveLength(0);
  });

  it('never blocks a kill on an audit failure, but counts it', async () => {
    const h = harness();
    const failingAudit = new InMemoryKillAuditSink();
    failingAudit.append = () => Promise.reject(new Error('ledger down'));
    const deps = (h.service as unknown as { deps: KillServiceDeps }).deps;
    const service = new KillService({ ...deps, audit: failingAudit });
    const result = await service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'audit-fail-1',
      traceId: null,
    });
    expect(result.created).toBe(true);
    const failed = await h.metrics.registry.getSingleMetricAsString('bw_kill_audit_failures_total');
    expect(failed).toContain('action="kill.triggered"');
  });

  it('logs the agreed fields, the reason length but never the reason body', async () => {
    const h = harness();
    await h.service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'log-check-1',
      traceId: null,
    });
    const line = h.logs.find((l) => l.includes('kill triggered'));
    expect(line).toBeDefined();
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      scope: 'run',
      scopeRefId: LIVE_RUN,
      actorRef: appsec.id,
      reasonLength: runKill.reason.length,
      targetCounts: { runs: 1, sessions: 1, sandboxes: 1, keys: 1 },
    });
    expect(h.logs.join('\n')).not.toContain('hunter2');
  });

  it('emits kill.trigger with a kill.resolve child span and the latency histogram', async () => {
    const h = harness();
    h.spans.reset();
    await h.service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'span-check-1',
      traceId: null,
    });
    const spans = h.spans.getFinishedSpans();
    const parent = spans.find((s) => s.name === KILL_TRIGGER_SPAN);
    const child = spans.find((s) => s.name === 'kill.resolve');
    expect(parent).toBeDefined();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    const latency = await h.metrics.registry.getSingleMetricAsString('bw_kill_trigger_latency_ms');
    expect(latency).toContain('bw_kill_trigger_latency_ms_count{scope="run"} 1');
  });

  it('GET hides another tenant kill event (404) and requires run:read', async () => {
    const h = harness();
    const { response } = await h.service.trigger({
      principal: appsec,
      body: runKill,
      idempotencyKey: 'get-check-01',
      traceId: null,
    });
    await expect(
      h.service.get(
        principal(['org_admin'], { tenantId: '01890a5d-ac96-774b-bcce-b302099a8099' }),
        response.killEventId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.get(principal([]), response.killEventId)).rejects.toMatchObject({
      code: 'KILL_FORBIDDEN',
    });
    expect((await h.service.get(appsec, response.killEventId)).id).toBe(response.killEventId);
  });
});

describe('Temporal kill signaler', () => {
  it('signal-with-starts KillPropagationWorkflow keyed by the kill event', async () => {
    const calls: unknown[][] = [];
    const client: SignalWithStartClient = {
      signalWithStart: (...args) => {
        calls.push(args);
        return Promise.resolve({});
      },
    };
    const request = {
      killEventId: 'k1',
      tenantId: TENANT_A,
      scope: 'run' as const,
      scopeRefId: LIVE_RUN,
      targets: {
        runIds: [LIVE_RUN],
        sessionIds: [],
        sandboxIds: [],
        virtualKeyIds: [],
        egressIdentities: [],
        workflowIds: [],
      },
      triggeredAt: '2026-10-20T10:00:00.000Z',
    };
    await createTemporalKillSignaler(client).signal(request);
    expect(calls).toEqual([
      [
        KILL_PROPAGATION_WORKFLOW,
        {
          workflowId: killPropagationWorkflowId('k1'),
          taskQueue: 'kill',
          signal: KILL_TARGETS_SIGNAL,
          signalArgs: [request],
          args: [{ killEventId: 'k1', tenantId: TENANT_A }],
        },
      ],
    ]);
  });

  it('runs the signal-with-start under the request tenant context', async () => {
    let seen: string | undefined;
    const client: SignalWithStartClient = {
      signalWithStart: () => {
        seen = getActivityContext().tenantId;
        return Promise.resolve({});
      },
    };
    await createTemporalKillSignaler(client).signal({
      killEventId: 'k2',
      tenantId: TENANT_A,
      scope: 'run',
      scopeRefId: LIVE_RUN,
      targets: {
        runIds: [LIVE_RUN],
        sessionIds: [],
        sandboxIds: [],
        virtualKeyIds: [],
        egressIdentities: [],
        workflowIds: [],
      },
      triggeredAt: '2026-10-20T10:00:00.000Z',
    });
    expect(seen).toBe(TENANT_A);
  });
});
