import { describe, expect, it } from 'vitest';

import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  ADMIN,
  ADMIN_B,
  AUDITOR,
  harness,
  type Harness,
  MANAGER,
  PLAN_APPROVER,
  PRIMARY,
  principal,
  REQUESTER,
  SECONDARY,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';

import type { OncallRoster } from '@blackwing/contracts';

const member = (userId: string, level: number, orderIndex: number, channelRefs = [newId()]) => ({
  userId,
  level,
  orderIndex,
  channelRefs,
});

/** Creates an active Berlin roster through the service as an Org Admin. */
async function createRoster(
  h: Harness,
  body: Record<string, unknown> = {},
  tenantId = TENANT_A,
  userId = ADMIN,
): Promise<OncallRoster> {
  return h.service.createRoster(
    principal(tenantId, userId),
    {
      name: 'Primary rotation',
      timezone: 'Europe/Berlin',
      members: [member(PRIMARY, 0, 0), member(SECONDARY, 1, 0), member(MANAGER, 2, 0)],
      ...body,
    },
    null,
  );
}

async function counter(h: Harness, name: string): Promise<number> {
  const metric = (await h.registry.getMetricsAsJSON()).find((m) => m.name === name);
  return metric?.values.reduce((sum, v) => sum + v.value, 0) ?? 0;
}

describe('OncallService.resolveResponders', () => {
  it('orders responders by escalation level, then order_index', async () => {
    const h = harness();
    const second = newId();
    await createRoster(h, {
      members: [
        member(MANAGER, 2, 0),
        member(SECONDARY, 1, 1),
        member(second, 1, 0),
        member(PRIMARY, 0, 0),
      ],
    });

    const resolved = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: REQUESTER, planApproverId: null },
    });

    expect(resolved.responders.map((r) => r.userId)).toEqual([PRIMARY, second, SECONDARY, MANAGER]);
    expect(resolved.steps.map((s) => s.level)).toEqual([0, 1, 2]);
    expect(resolved.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    expect(resolved.excludedForSod).toBe(0);
    expect(await counter(h, 'oncall_resolve_total')).toBe(1);
  });

  it('excludes the requester and the plan approver before ordering, skipping emptied levels', async () => {
    const h = harness();
    await createRoster(h, {
      members: [member(REQUESTER, 0, 0), member(PLAN_APPROVER, 1, 0), member(MANAGER, 2, 0)],
    });

    const resolved = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: REQUESTER, planApproverId: PLAN_APPROVER },
    });

    expect(resolved.responders.map((r) => r.userId)).toEqual([MANAGER]);
    expect(resolved.steps).toHaveLength(1);
    expect(resolved.steps[0]?.stepIndex).toBe(0);
    expect(resolved.excludedForSod).toBe(2);
    // Each emptied level leaves one audit event and one skip count.
    expect(h.audit.records.map((r) => r.action)).toEqual([
      'oncall.sod_skipped',
      'oncall.sod_skipped',
    ]);
    expect(await counter(h, 'oncall_sod_skips_total')).toBe(2);
  });

  it('matches SoD identities case-insensitively', async () => {
    const h = harness();
    await createRoster(h, { members: [member(PRIMARY, 0, 0), member(MANAGER, 2, 0)] });

    const resolved = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: PRIMARY.toUpperCase(), planApproverId: null },
    });

    expect(resolved.responders.map((r) => r.userId)).toEqual([MANAGER]);
  });

  it('fails with GATE2_NO_ELIGIBLE_APPROVER when every member on call is barred by SoD', async () => {
    const h = harness();
    await createRoster(h, { members: [member(REQUESTER, 0, 0)] });

    await expect(
      h.service.resolveResponders({
        tenantId: TENANT_A,
        runId: newId(),
        exclude: { requesterId: REQUESTER, planApproverId: null },
      }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ELIGIBLE_APPROVER' });
    expect(await counter(h, 'oncall_resolve_total')).toBe(1);
  });

  it('refuses to resolve without a named requester (SoD cannot be applied)', async () => {
    const h = harness();
    await createRoster(h);

    await expect(
      h.service.resolveResponders({
        tenantId: TENANT_A,
        runId: newId(),
        exclude: { requesterId: '', planApproverId: null },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails with GATE2_NO_ONCALL_CONFIGURED when the tenant has no roster, or only an inactive one', async () => {
    const h = harness();
    const exclude = { requesterId: REQUESTER, planApproverId: null };

    await expect(
      h.service.resolveResponders({ tenantId: TENANT_A, runId: newId(), exclude }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ONCALL_CONFIGURED' });
    await createRoster(h, { active: false });
    await expect(
      h.service.resolveResponders({ tenantId: TENANT_A, runId: newId(), exclude }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ONCALL_CONFIGURED' });
    expect(await counter(h, 'oncall_empty_roster_total')).toBe(2);
  });

  it('never pages a member without a notification channel, and logs it by user reference', async () => {
    const h = harness();
    await createRoster(h, {
      members: [member(PRIMARY, 0, 0, []), member(SECONDARY, 1, 0)],
    });

    const resolved = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: REQUESTER, planApproverId: null },
    });

    expect(resolved.responders.map((r) => r.userId)).toEqual([SECONDARY]);
    expect(h.events()).toContain('oncall.no_channel');
  });

  it('fails toward deny when nobody on call has a channel', async () => {
    const h = harness();
    await createRoster(h, { members: [member(PRIMARY, 0, 0, [])] });

    await expect(
      h.service.resolveResponders({
        tenantId: TENANT_A,
        runId: newId(),
        exclude: { requesterId: REQUESTER, planApproverId: null },
      }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ONCALL_CONFIGURED' });
  });

  it('selects the member whose schedule window contains the instant, in the roster timezone', async () => {
    const h = harness();
    // 09:00 to 17:00 Berlin on 30 Oct 2026 is 08:00Z to 16:00Z (CET, UTC+1 after the 25 Oct change).
    await createRoster(h, {
      members: [member(PRIMARY, 0, 0), member(SECONDARY, 0, 1)],
      schedules: [{ userId: PRIMARY, startsAt: '2026-10-30T09:00', endsAt: '2026-10-30T17:00' }],
    });
    const exclude = { requesterId: REQUESTER, planApproverId: null };

    const during = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude,
      at: new Date('2026-10-30T08:00:00.000Z'),
    });
    const after = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude,
      at: new Date('2026-10-30T16:00:00.000Z'),
    });

    expect(during.responders.map((r) => r.userId)).toEqual([PRIMARY, SECONDARY]);
    // The window end is exclusive: at 16:00Z PRIMARY is off, and the static member remains.
    expect(after.responders.map((r) => r.userId)).toEqual([SECONDARY]);
  });

  it('reads a wall-clock rotation boundary across the DST change in the roster zone (not UTC or server time)', async () => {
    const h = harness();
    // Berlin switches to CEST at 01:00Z on 29 Mar 2026. A 09:00 local handover is 08:00Z before the
    // switch and 07:00Z after it, so the window must end at 07:00Z, not 08:00Z.
    await createRoster(h, {
      members: [member(PRIMARY, 0, 0), member(SECONDARY, 0, 1)],
      schedules: [{ userId: PRIMARY, startsAt: '2026-03-28T09:00', endsAt: '2026-03-29T09:00' }],
    });
    const exclude = { requesterId: REQUESTER, planApproverId: null };
    const at = (iso: string) =>
      h.service
        .resolveResponders({ tenantId: TENANT_A, runId: newId(), exclude, at: new Date(iso) })
        .then((r) => r.responders.map((x) => x.userId));

    expect(await at('2026-03-28T08:00:00.000Z')).toEqual([PRIMARY, SECONDARY]);
    expect(await at('2026-03-29T06:59:59.999Z')).toEqual([PRIMARY, SECONDARY]);
    expect(await at('2026-03-29T07:00:00.000Z')).toEqual([SECONDARY]);
  });

  it('writes no SoD audit event when nobody on call is barred', async () => {
    const h = harness();
    await createRoster(h);

    await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: REQUESTER, planApproverId: null },
    });

    expect(h.audit.records).toEqual([]);
    expect(h.events()).toContain('oncall.resolve');
  });

  it('still pages when the sod_skipped audit append fails, and counts the failure', async () => {
    const h = harness();
    await createRoster(h, { members: [member(REQUESTER, 0, 0), member(MANAGER, 2, 0)] });
    h.audit.failNext();

    const resolved = await h.service.resolveResponders({
      tenantId: TENANT_A,
      runId: newId(),
      exclude: { requesterId: REQUESTER, planApproverId: null },
    });

    expect(resolved.responders.map((r) => r.userId)).toEqual([MANAGER]);
    expect(await counter(h, 'oncall_audit_failures_total')).toBe(1);
  });
});

describe('OncallService.assertConfigured (run preflight)', () => {
  it('refuses a run when no one is on call with a channel', async () => {
    const h = harness();
    await expect(h.service.assertConfigured(TENANT_A)).rejects.toMatchObject({
      code: 'GATE2_NO_ONCALL_CONFIGURED',
    });
    await createRoster(h);
    await expect(h.service.assertConfigured(TENANT_A)).resolves.toBeUndefined();
  });
});

describe('OncallService.getEscalationStep', () => {
  const exceptionFor = (h: Harness, exceptionId = newId(), tenantId = TENANT_A) => {
    const runId = newId();
    h.exceptions.add(tenantId, {
      exceptionId,
      runId,
      requesterId: REQUESTER,
      planApproverId: PLAN_APPROVER,
    });
    return { exceptionId, runId };
  };

  it('returns the responders of a step, the total, and whether it is the last', async () => {
    const h = harness();
    await createRoster(h);
    const { exceptionId } = exceptionFor(h);

    const first = await h.service.getEscalationStep({
      tenantId: TENANT_A,
      exceptionId,
      stepIndex: 0,
    });
    const last = await h.service.getEscalationStep({
      tenantId: TENANT_A,
      exceptionId,
      stepIndex: 2,
    });

    expect(first).toMatchObject({ level: 0, totalSteps: 3, isLast: false });
    expect(first.responders.map((r) => r.userId)).toEqual([PRIMARY]);
    expect(last).toMatchObject({ level: 2, isLast: true });
  });

  it('answers GATE2_NO_ELIGIBLE_APPROVER past the last step (the operator pause path)', async () => {
    const h = harness();
    await createRoster(h);
    const { exceptionId } = exceptionFor(h);

    await expect(
      h.service.getEscalationStep({ tenantId: TENANT_A, exceptionId, stepIndex: 3 }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ELIGIBLE_APPROVER' });
  });

  it('rejects a negative or non-integer step index', async () => {
    const h = harness();
    await createRoster(h);
    const { exceptionId } = exceptionFor(h);

    await expect(
      h.service.getEscalationStep({ tenantId: TENANT_A, exceptionId, stepIndex: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.service.getEscalationStep({ tenantId: TENANT_A, exceptionId, stepIndex: 0.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("answers not found for an unknown exception and for another tenant's exception (no oracle)", async () => {
    const h = harness();
    await createRoster(h);
    const { exceptionId } = exceptionFor(h, newId(), TENANT_B);

    await expect(
      h.service.getEscalationStep({ tenantId: TENANT_A, exceptionId, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.service.getEscalationStep({ tenantId: TENANT_A, exceptionId: newId(), stepIndex: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OncallService roster management (RBAC, validation, concurrency, audit)', () => {
  it('lets an Org Admin create a roster and audits it in the same write', async () => {
    const h = harness();
    const roster = await createRoster(h);

    expect(roster).toMatchObject({ tenantId: TENANT_A, active: true, stateVersion: 0 });
    expect(roster.members.map((m) => m.userId)).toEqual([PRIMARY, SECONDARY, MANAGER]);
    expect(h.store.auditLog).toHaveLength(1);
    expect(h.store.auditLog[0]).toMatchObject({
      action: 'oncall.roster.updated',
      tenantId: TENANT_A,
      target: { type: 'config', id: roster.id },
      outcome: 'success',
      metadata: { rosterId: roster.id, change: 'created', stateVersion: 0, members: 3 },
    });
  });

  it('refuses writes for roles without settings:write, and for callers with no roles', async () => {
    const h = harness();
    await expect(
      h.service.createRoster(
        principal(TENANT_A, AUDITOR, ['auditor']),
        { name: 'x', timezone: 'UTC' },
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      h.service.createRoster(
        principal(TENANT_A, AUDITOR, []),
        { name: 'x', timezone: 'UTC' },
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.store.auditLog).toEqual([]);
  });

  it('refuses a principal with no tenant context (fails closed)', async () => {
    const h = harness();
    await expect(
      h.service.listRosters({ type: 'user', id: ADMIN, tenantId: null, roles: ['org_admin'] }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an invalid body with a validation error naming the fields, not the values', async () => {
    const h = harness();
    await expect(
      h.service.createRoster(
        principal(TENANT_A, ADMIN),
        { name: 'x', timezone: 'Mars/Olympus', members: [], sneaky: true },
        null,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an offset (not an IANA zone) as the roster timezone', async () => {
    const h = harness();
    await expect(
      h.service.createRoster(principal(TENANT_A, ADMIN), { name: 'x', timezone: '+02:00' }, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects two members sharing an order_index within one level (the order must be deterministic)', async () => {
    const h = harness();
    await expect(
      createRoster(h, { members: [member(PRIMARY, 0, 0), member(SECONDARY, 0, 0)] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a schedule window for someone who is not a member', async () => {
    const h = harness();
    await expect(
      createRoster(h, {
        schedules: [{ userId: newId(), startsAt: '2026-10-30T09:00', endsAt: '2026-10-30T17:00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a schedule window that ends before it starts', async () => {
    const h = harness();
    await expect(
      createRoster(h, {
        schedules: [{ userId: PRIMARY, startsAt: '2026-10-30T17:00', endsAt: '2026-10-30T09:00' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('allows one active roster per tenant: a second active one is a conflict, an inactive one is not', async () => {
    const h = harness();
    await createRoster(h);

    await expect(createRoster(h, { name: 'Second' })).rejects.toBeInstanceOf(ConflictError);
    await expect(createRoster(h, { name: 'Standby', active: false })).resolves.toMatchObject({
      active: false,
    });
  });

  it('refuses a duplicate roster name in the same tenant', async () => {
    const h = harness();
    await createRoster(h, { active: false });
    await expect(createRoster(h, { active: false })).rejects.toBeInstanceOf(ConflictError);
  });

  it('updates a roster under its ETag, bumps stateVersion and audits the change', async () => {
    const h = harness();
    const roster = await createRoster(h);

    const updated = await h.service.updateRoster(
      principal(TENANT_A, ADMIN),
      roster.id,
      { members: [member(MANAGER, 0, 0)] },
      0,
      null,
    );

    expect(updated.stateVersion).toBe(1);
    expect(updated.members.map((m) => m.userId)).toEqual([MANAGER]);
    expect(h.store.auditLog.at(-1)).toMatchObject({
      action: 'oncall.roster.updated',
      metadata: { change: 'updated', stateVersion: 1, members: 1 },
    });
  });

  it('refuses an update made against a stale version (412), and writes nothing', async () => {
    const h = harness();
    const roster = await createRoster(h);
    await h.service.updateRoster(principal(TENANT_A, ADMIN), roster.id, { name: 'A' }, 0, null);

    await expect(
      h.service.updateRoster(principal(TENANT_A, ADMIN), roster.id, { name: 'B' }, 0, null),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await h.service.getRoster(principal(TENANT_A, ADMIN), roster.id)).name).toBe('A');
    expect(h.store.auditLog).toHaveLength(2);
  });

  it('refuses an empty patch', async () => {
    const h = harness();
    const roster = await createRoster(h);
    await expect(
      h.service.updateRoster(principal(TENANT_A, ADMIN), roster.id, {}, 0, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not write the change when its audit event cannot be stored (fail closed, §8.8)', async () => {
    const h = harness();
    h.store.failNextAudit();

    await expect(createRoster(h)).rejects.toThrow('audit ledger unavailable');
    expect(await h.service.listRosters(principal(TENANT_A, ADMIN))).toEqual([]);
  });

  it('keeps tenants apart: another tenant cannot read, update or list a roster', async () => {
    const h = harness();
    const roster = await createRoster(h);

    await expect(
      h.service.getRoster(principal(TENANT_B, ADMIN_B), roster.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.service.updateRoster(principal(TENANT_B, ADMIN_B), roster.id, { name: 'x' }, 0, null),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await h.service.listRosters(principal(TENANT_B, ADMIN_B))).toEqual([]);
    await expect(
      h.service.resolveResponders({
        tenantId: TENANT_B,
        runId: newId(),
        exclude: { requesterId: REQUESTER, planApproverId: null },
      }),
    ).rejects.toMatchObject({ code: 'GATE2_NO_ONCALL_CONFIGURED' });
  });

  it('answers not found for a malformed roster id instead of leaking a parser error', async () => {
    const h = harness();
    await expect(
      h.service.getRoster(principal(TENANT_A, ADMIN), 'not-a-uuid'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
