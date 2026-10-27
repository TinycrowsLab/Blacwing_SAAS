import { describe, expect, it } from 'vitest';

import { killEventSchema, type KillEvent } from '@blackwing/contracts';

import {
  harness,
  operator,
  OPERATOR_ID,
  RUN_A,
  RUN_A_DONE,
  RUN_B,
  SLUG_A,
  TENANT_A,
  TENANT_B,
  tenantMember,
  uuid,
} from './fixtures.test-helpers.js';
import {
  OPERATOR_KILL_FIRE_SPAN,
  OPERATOR_KILL_PREVIEW_SPAN,
  type OperatorKillFireInput,
} from './service.js';

/** `key` null sends no Idempotency-Key header; undefined sends a fresh one. */
const fire = (
  body: unknown,
  key?: string | null,
  principal = operator(),
): OperatorKillFireInput => ({
  principal,
  body,
  idempotencyKey: key === null ? undefined : (key ?? `key-${uuid()}`),
  traceId: null,
});

const GLOBAL = { scope: 'global', reason: 'platform incident' };
const TENANT = { scope: 'tenant', tenantId: TENANT_A, reason: 'customer request' };

async function storedEvent(h: ReturnType<typeof harness>, id: string): Promise<KillEvent> {
  const event = await h.store.get(id);
  if (event === null) throw new Error('event missing');
  return event;
}

describe('preview (blast radius)', () => {
  it('counts what a global kill would stop across every tenant', async () => {
    const h = harness();
    const radius = await h.service.preview(operator(), { scope: 'global' }, null);
    expect(radius).toEqual({
      runsAffected: 2,
      sandboxesAffected: 3,
      tenantsAffected: 2,
      sessionsAffected: 3,
    });
  });

  it('counts only the named tenant, with its slug, and ignores finished runs', async () => {
    const h = harness();
    const radius = await h.service.preview(
      operator(),
      { scope: 'tenant', tenantId: TENANT_A },
      null,
    );
    expect(radius).toEqual({
      runsAffected: 1,
      sandboxesAffected: 2,
      tenantsAffected: 1,
      sessionsAffected: 2,
      tenantSlug: SLUG_A,
    });
  });

  it('is audited in the operator stream and traced', async () => {
    const h = harness();
    await h.service.preview(operator(), { scope: 'global' }, 'a'.repeat(32));
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.records[0]).toMatchObject({
      action: 'operator.kill_previewed',
      tenantId: null,
      actor: { type: 'operator', id: OPERATOR_ID },
      target: { type: 'platform', id: 'global' },
      traceId: 'a'.repeat(32),
      metadata: { scope: 'global', runsAffected: 2 },
    });
    expect(h.spans.getFinishedSpans().map((s) => s.name)).toContain(OPERATOR_KILL_PREVIEW_SPAN);
  });

  it('rejects a malformed query (422) and an unknown tenant (404)', async () => {
    const h = harness();
    for (const query of [
      { scope: 'run' },
      { scope: 'tenant' },
      { scope: 'global', tenantId: TENANT_A },
      { scope: 'global', extra: '1' },
      {},
    ]) {
      await expect(h.service.preview(operator(), query, null)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(
      h.service.preview(operator(), { scope: 'tenant', tenantId: uuid() }, null),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.audit.records).toHaveLength(0);
  });
});

describe('fire', () => {
  it('records a global kill, hands every target to the kill path and audits all streams', async () => {
    const h = harness();
    const response = await h.service.fire(fire(GLOBAL));
    expect(response.status).toBe('initiated');

    const event = killEventSchema.parse(await storedEvent(h, response.killEventId));
    expect(event).toMatchObject({
      scope: 'global',
      tenantId: null,
      source: 'operator',
      actorType: 'operator',
      actorRef: OPERATOR_ID,
      reason: GLOBAL.reason,
      haltMs: null,
    });

    expect(h.signaler.requests).toHaveLength(1);
    const [request] = h.signaler.requests;
    expect(request).toMatchObject({ killEventId: event.id, tenantId: null, scope: 'global' });
    expect(request?.targets.runIds.sort()).toEqual([RUN_A, RUN_B].sort());
    expect(request?.targets.sandboxIds).toEqual(['sbx-a1', 'sbx-a2', 'sbx-b1']);

    const fired = h.audit.records.filter((r) => r.action === 'operator.kill_fired');
    expect(fired.map((r) => r.tenantId).sort()).toEqual([null, TENANT_A, TENANT_B].sort());
    for (const record of fired) {
      expect(record).toMatchObject({
        severity: 'critical',
        outcome: 'success',
        reason: GLOBAL.reason,
        actor: { type: 'operator', id: OPERATOR_ID },
        metadata: { scope: 'global', tenantId: null, status: 'initiated', killEventId: event.id },
      });
    }
    expect(h.spans.getFinishedSpans().map((s) => s.name)).toContain(OPERATOR_KILL_FIRE_SPAN);
    expect(
      await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_fired_total'),
    ).toContain('scope="global",result="accepted"} 1');
    expect(h.logs.join('\n')).toContain('operator kill fired');
  });

  it('keeps a tenant kill inside its tenant', async () => {
    const h = harness();
    const response = await h.service.fire(fire(TENANT));
    const event = await storedEvent(h, response.killEventId);
    expect(event).toMatchObject({ scope: 'tenant', tenantId: TENANT_A, scopeRefId: null });
    const [request] = h.signaler.requests;
    expect(request).toMatchObject({ tenantId: TENANT_A, scope: 'tenant' });
    expect(request?.targets.runIds).toEqual([RUN_A]);
    expect(request?.targets.runIds).not.toContain(RUN_B);
    expect(request?.targets.runIds).not.toContain(RUN_A_DONE);
    const fired = h.audit.records.filter((r) => r.action === 'operator.kill_fired');
    expect(fired.map((r) => r.tenantId).sort()).toEqual([null, TENANT_A].sort());
    expect(fired[0]?.target).toEqual({ type: 'tenant', id: TENANT_A });
  });

  it('is complete at once, in zero time, when nothing is running', async () => {
    const h = harness({ runs: [] });
    const response = await h.service.fire(fire(GLOBAL));
    expect(response.status).toBe('halted');
    expect(await storedEvent(h, response.killEventId)).toMatchObject({
      haltMs: 0,
      status: 'halted',
    });
    expect(h.signaler.requests).toHaveLength(0);
  });

  it('requires an Idempotency-Key (400) and rejects bad bodies (422) before storing anything', async () => {
    const h = harness();
    await expect(h.service.fire(fire(GLOBAL, null))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    await expect(h.service.fire(fire(GLOBAL, 'short'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    for (const body of [
      null,
      'GLOBAL',
      { scope: 'run', reason: 'incident' },
      { scope: 'global', reason: 'ab' },
      { scope: 'global', reason: 'incident', tenantId: TENANT_A },
      { scope: 'tenant', reason: 'incident' },
      { scope: 'global', reason: 'incident', confirm: 'GLOBAL' },
    ]) {
      await expect(h.service.fire(fire(body))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(
      h.service.fire(fire({ scope: 'tenant', tenantId: uuid(), reason: 'incident' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await h.store.list(10)).toHaveLength(0);
    expect(h.signaler.requests).toHaveLength(0);
  });

  it('replays the same Idempotency-Key without a second kill, and refuses it with another body', async () => {
    const h = harness();
    const first = await h.service.fire(fire(GLOBAL, 'double-submit-1'));
    const again = await h.service.fire(fire(GLOBAL, 'double-submit-1'));
    expect(again).toEqual(first);
    expect(await h.store.list(10)).toHaveLength(1);
    expect(h.signaler.requests).toHaveLength(1);
    await expect(
      h.service.fire(fire({ ...GLOBAL, reason: 'something else' }, 'double-submit-1')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
  });

  it('answers KILL_ALREADY_IN_PROGRESS for another key while a kill of that scope is open', async () => {
    const h = harness();
    const first = await h.service.fire(fire(GLOBAL));
    await expect(h.service.fire(fire(GLOBAL))).rejects.toMatchObject({
      code: 'KILL_ALREADY_IN_PROGRESS',
      httpStatus: 409,
      detail: expect.stringContaining(first.killEventId) as string,
    });
    expect(await h.store.list(10)).toHaveLength(1);
    expect(h.signaler.requests).toHaveLength(1);
    // A different scope is not blocked by it.
    await expect(h.service.fire(fire(TENANT))).resolves.toMatchObject({ status: 'initiated' });
  });

  it('dedupes two operators firing at once to a single kill event', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.service.fire(fire(GLOBAL, 'race-key-a1', operator({ id: 'op-1' }))),
      h.service.fire(fire(GLOBAL, 'race-key-b2', operator({ id: 'op-2' }))),
      h.service.fire(fire(GLOBAL, 'race-key-a1', operator({ id: 'op-1' }))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'KILL_ALREADY_IN_PROGRESS' } });
    expect(await h.store.list(10)).toHaveLength(1);
    expect(h.signaler.requests).toHaveLength(1);
  });

  it('surfaces a KILL_PARTIAL naming each component that would not stop, never "all stopped"', async () => {
    const h = harness();
    const first = await h.service.fire(fire(GLOBAL, 'partial-key-1'));
    const stored = await storedEvent(h, first.killEventId);
    h.store.put({
      ...stored,
      status: 'partially_halted',
      haltMs: 11_000,
      completedAt: '2026-10-20T10:00:11.000Z',
      affected: {
        sandboxResults: [
          { sandboxId: 'sbx-a1', outcome: 'terminated' },
          { sandboxId: 'sbx-b1', outcome: 'failed' },
        ],
        workflowResults: [{ workflowId: 'wf-run-x', outcome: 'failed' }],
      },
    });
    await expect(h.service.fire(fire(GLOBAL, 'partial-key-1'))).rejects.toMatchObject({
      code: 'KILL_PARTIAL',
      httpStatus: 424,
      detail: expect.stringMatching(/sandbox sbx-b1.*workflow wf-run-x/) as string,
    });
    expect(
      await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_fired_total'),
    ).toContain('result="partial"} 1');
  });

  it('does not report success when the kill path cannot be reached', async () => {
    const h = harness({
      signaler: { signal: () => Promise.reject(new Error('temporal down')) },
    });
    await expect(h.service.fire(fire(GLOBAL))).rejects.toMatchObject({
      code: 'TEMPORAL_UNAVAILABLE',
      httpStatus: 503,
    });
    const [event] = await h.store.list(10);
    expect(event?.status).toBe('initiated');
    // The attempt is still on the ledger, and the failure was logged.
    expect(h.audit.records.some((r) => r.action === 'operator.kill_fired')).toBe(true);
    expect(h.logs.join('\n')).toContain('enqueue failed');
  });

  it('still fires when the audit ledger is down, and counts the failures', async () => {
    const h = harness({ audit: { append: () => Promise.reject(new Error('ledger down')) } });
    await expect(h.service.fire(fire(GLOBAL))).resolves.toMatchObject({ status: 'initiated' });
    expect(h.signaler.requests).toHaveLength(1);
    // One append per stream: the operator stream and each of the two affected tenants.
    expect(
      await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_audit_failures_total'),
    ).toContain('action="operator.kill_fired"} 3');
  });
});

describe('authorisation (operator only)', () => {
  it('refuses a tenant member on every method, before reading or writing anything', async () => {
    const h = harness();
    const member = tenantMember();
    const denied = { code: 'NOT_OPERATOR', httpStatus: 403 };
    await expect(h.service.preview(member, { scope: 'global' }, null)).rejects.toMatchObject(
      denied,
    );
    await expect(h.service.fire(fire(GLOBAL, undefined, member))).rejects.toMatchObject(denied);
    await expect(h.service.list(member)).rejects.toMatchObject(denied);
    await expect(h.service.get(member, uuid())).rejects.toMatchObject(denied);
    expect(await h.store.list(10)).toHaveLength(0);
    expect(h.signaler.requests).toHaveLength(0);
    expect(h.audit.records).toHaveLength(0);
    expect(
      await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_fired_total'),
    ).toContain('result="forbidden"} 1');
  });

  it('refuses an operator role without the global-kill permission and a tenant principal claiming no role', async () => {
    const h = harness();
    await expect(
      h.service.fire(
        fire(GLOBAL, undefined, operator({ permissions: ['platform:tenant_support'] })),
      ),
    ).rejects.toMatchObject({ code: 'NOT_OPERATOR' });
    await expect(
      h.service.fire(fire(GLOBAL, undefined, operator({ role: 'tenant_admin' }))),
    ).rejects.toMatchObject({ code: 'NOT_OPERATOR' });
    expect(await h.store.list(10)).toHaveLength(0);
  });
});

describe('history and status (simulated kill)', () => {
  it('lists operator kills newest first and shows phases and halt time once the kill path reports them', async () => {
    const h = harness();
    const first = await h.service.fire(fire(GLOBAL));
    const stored = await storedEvent(h, first.killEventId);

    // The kill path confirms each phase; the console reads them back, never infers them.
    h.store.put({
      ...stored,
      status: 'propagating',
      egressBlockedAt: '2026-10-20T10:00:00.400Z',
    });
    expect(await h.service.get(operator(), first.killEventId)).toMatchObject({
      status: 'propagating',
      egressBlockedAt: '2026-10-20T10:00:00.400Z',
      sandboxesTerminatedAt: null,
      haltMs: null,
    });
    expect(
      await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_halt_ms'),
    ).not.toContain('_count 1');

    h.store.put({
      ...stored,
      status: 'halted',
      egressBlockedAt: '2026-10-20T10:00:03.000Z',
      sandboxesTerminatedAt: '2026-10-20T10:00:12.000Z',
      keysRevokedAt: '2026-10-20T10:00:12.100Z',
      workflowsCancelledAt: '2026-10-20T10:00:12.200Z',
      completedAt: '2026-10-20T10:00:12.200Z',
      haltMs: 12_200,
    });
    const detail = await h.service.get(operator(), first.killEventId);
    expect(detail).toMatchObject({
      status: 'halted',
      haltMs: 12_200,
      scope: 'global',
      tenantId: null,
    });
    await h.service.get(operator(), first.killEventId);
    // Observed once, with both SLA breaches counted.
    expect(await h.metrics.registry.getSingleMetricAsString('bw_operator_kill_halt_ms')).toContain(
      'bw_operator_kill_halt_ms_count 1',
    );
    const breaches = await h.metrics.registry.getSingleMetricAsString(
      'bw_operator_kill_sla_breach_total',
    );
    expect(breaches).toContain('target="gateway"} 1');
    expect(breaches).toContain('target="sandboxes"} 1');

    h.clock.advance(1000);
    const second = await h.service.fire(fire(TENANT));
    const list = await h.service.list(operator());
    expect(list.map((e) => e.id)).toEqual([second.killEventId, first.killEventId]);
    expect(list[0]).toEqual({
      id: second.killEventId,
      scope: 'tenant',
      tenantId: TENANT_A,
      actor: OPERATOR_ID,
      reason: TENANT.reason,
      firedAt: '2026-10-20T10:00:01.000Z',
      haltMs: null,
      status: 'initiated',
    });
  });

  it('answers 404 for an unknown id, a malformed id and an event that was not an operator kill', async () => {
    const h = harness();
    await expect(h.service.get(operator(), uuid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.get(operator(), 'not-a-uuid')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const first = await h.service.fire(fire(GLOBAL));
    const stored = await storedEvent(h, first.killEventId);
    const tenantKill = { ...stored, id: uuid(), source: 'api' } as KillEvent;
    h.store.put(tenantKill);
    await expect(h.service.get(operator(), tenantKill.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
