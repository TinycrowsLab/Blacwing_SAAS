import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { ConcurrencyError, runWithTenantContext } from '@blackwing/db';
import { createLogger } from '@blackwing/logger';

import {
  APPSEC_A,
  AUDITOR_A,
  APPSEC_B,
  memoryMemberships,
  memoryTestPlanStore,
  plannedCase,
  RUN_A,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { createTestPlanMetrics } from './metrics.js';
import { TestPlanService, type TestPlanPrincipal } from './service.js';

const NO_ROLE = '0198f0a0-0000-7000-8000-0000000000c9';
const MEMBERS = memoryMemberships({
  [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [AUDITOR_A]: ['auditor'] },
  [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'], [NO_ROLE]: [] },
});

/** Runs `fn` as the principal, under the tenant context the guard would set. */
function asPrincipal<T>(principal: TestPlanPrincipal, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(
    { tenantId: principal.tenantId, actor: { type: 'user', id: principal.actorId } },
    fn,
  );
}

function setup() {
  const store = memoryTestPlanStore();
  const registry = new Registry();
  const metrics = createTestPlanMetrics(registry);
  const service = new TestPlanService({
    store,
    memberships: MEMBERS,
    metrics,
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
  });
  store.seedRun(RUN_A, TENANT_A);
  const editor: TestPlanPrincipal = { tenantId: TENANT_A, actorId: APPSEC_A };
  const reader: TestPlanPrincipal = { tenantId: TENANT_A, actorId: AUDITOR_A };
  const call = <T>(principal: TestPlanPrincipal, fn: () => Promise<T>) =>
    asPrincipal(principal, fn);
  return { store, service, registry, editor, reader, call };
}

/** Creates a draft version with one case and returns the ids and ETags a client would hold. */
async function draftWithCase(ctx: ReturnType<typeof setup>) {
  const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
  const added = await ctx.call(ctx.editor, () =>
    ctx.service.addCase(ctx.editor, created.body.planId, created.etag, plannedCase()),
  );
  return { planId: created.body.planId, plan: added, caseId: added.case.body.caseId };
}

describe('createVersion', () => {
  it('numbers versions from 1 and copies only the non-removed cases of the newest version', async () => {
    const ctx = setup();
    const first = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    expect(first.body.version).toBe(1);
    expect(first.body.cases).toEqual([]);
    const draft = await draftWithCase(ctx);
    const kept = await ctx.call(ctx.editor, () =>
      ctx.service.addCase(
        ctx.editor,
        draft.planId,
        draft.plan.planEtag,
        plannedCase({ title: 'Kept' }),
      ),
    );
    await ctx.call(ctx.editor, () =>
      ctx.service.removeCase(ctx.editor, draft.caseId, draft.plan.case.etag),
    );
    const second = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    expect(second.body.version).toBe(3);
    expect(second.body.cases.map((c) => c.title)).toEqual(['Kept']);
    expect(second.body.cases.map((c) => c.caseId)).not.toContain(kept.case.body.caseId);
  });

  it('retries after a lost version race and succeeds on the next attempt', async () => {
    const ctx = setup();
    ctx.store.failNextVersionWithConcurrency();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    expect(created.body.version).toBe(1);
  });

  it('gives up after repeated lost races', async () => {
    const ctx = setup();
    const original = ctx.store.createVersion.bind(ctx.store);
    ctx.store.createVersion = () => Promise.reject(new ConcurrencyError('test plan version'));
    await expect(
      ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A)),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    ctx.store.createVersion = original;
  });

  it('refuses a read-only member and a principal with no role (403 FORBIDDEN)', async () => {
    const ctx = setup();
    await expect(
      ctx.call(ctx.reader, () => ctx.service.createVersion(ctx.reader, RUN_A)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stranger: TestPlanPrincipal = { tenantId: TENANT_A, actorId: NO_ROLE };
    await expect(
      ctx.call(stranger, () => ctx.service.createVersion(stranger, RUN_A)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a caller whose id is not a UUID (fails closed, no membership to read)', async () => {
    const ctx = setup();
    const bad: TestPlanPrincipal = { tenantId: TENANT_A, actorId: 'usr_none' };
    await expect(ctx.call(bad, () => ctx.service.createVersion(bad, RUN_A))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('is not visible to another tenant: a plan written in A is not found from B (RLS)', async () => {
    const ctx = setup();
    await draftWithCase(ctx);
    const other: TestPlanPrincipal = { tenantId: TENANT_B, actorId: APPSEC_B };
    await expect(
      ctx.call(other, () => ctx.service.getVersion(other, RUN_A, 1)),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});

describe('reads', () => {
  it('lists versions with a keyset cursor and rejects a forged cursor', async () => {
    const ctx = setup();
    for (let i = 0; i < 3; i += 1) {
      await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    }
    const page1 = await ctx.call(ctx.reader, () =>
      ctx.service.listVersions(ctx.reader, RUN_A, { limit: 2 }),
    );
    expect(page1.items.map((v) => v.version)).toEqual([1, 2]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ctx.call(ctx.reader, () =>
      ctx.service.listVersions(ctx.reader, RUN_A, { limit: 2, cursor: page1.nextCursor ?? '' }),
    );
    expect(page2.items.map((v) => v.version)).toEqual([3]);
    expect(page2.nextCursor).toBeNull();
    await expect(
      ctx.call(ctx.reader, () =>
        ctx.service.listVersions(ctx.reader, RUN_A, { cursor: 'bogus!!' }),
      ),
    ).rejects.toThrow('invalid cursor');
  });

  it('rejects a page size above 200 with a validation error', async () => {
    const ctx = setup();
    await expect(
      ctx.call(ctx.reader, () => ctx.service.listVersions(ctx.reader, RUN_A, { limit: 201 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers PLAN_NOT_FOUND for an unknown version', async () => {
    const ctx = setup();
    await expect(
      ctx.call(ctx.reader, () => ctx.service.getVersion(ctx.reader, RUN_A, 7)),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});

describe('addCase', () => {
  it('requires If-Match (428) and refuses a stale plan ETag (412 ETAG_MISMATCH)', async () => {
    const ctx = setup();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.addCase(ctx.editor, created.body.planId, undefined, plannedCase()),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.addCase(ctx.editor, created.body.planId, '"v0"', plannedCase()),
      ),
    ).rejects.toMatchObject({ code: 'ETAG_MISMATCH' });
  });

  it('refuses a case on an approved version with PLAN_VERSION_IMMUTABLE (409), even with a valid ETag', async () => {
    const ctx = setup();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    ctx.store.setPlanStatus(created.body.planId, 'approved');
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.addCase(ctx.editor, created.body.planId, created.etag, plannedCase()),
      ),
    ).rejects.toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE' });
  });

  it('bumps the plan ETag, returns the case ETag and audits the creation', async () => {
    const ctx = setup();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    const added = await ctx.call(ctx.editor, () =>
      ctx.service.addCase(
        ctx.editor,
        created.body.planId,
        created.etag,
        plannedCase({ title: 'Unicode ✓ 検査' }),
      ),
    );
    expect(added.planEtag).not.toBe(created.etag);
    expect(added.case.body.title).toBe('Unicode ✓ 検査');
    expect(ctx.store.audits.map((a) => a.action)).toContain('test_case.created');
  });

  it('refuses a destructive case (422) and an oversized oracle (413)', async () => {
    const ctx = setup();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.addCase(
          ctx.editor,
          created.body.planId,
          created.etag,
          plannedCase({ class: 'destructive' }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const huge = plannedCase({
      oracle: { type: 'status_code', params: { blob: 'x'.repeat(9 * 1024) } },
    });
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.addCase(ctx.editor, created.body.planId, created.etag, huge),
      ),
    ).rejects.toMatchObject({ code: 'PLAN_PAYLOAD_TOO_LARGE' });
  });

  it('refuses a malformed body (422) that names fields, not values', async () => {
    const ctx = setup();
    const created = await ctx.call(ctx.editor, () => ctx.service.createVersion(ctx.editor, RUN_A));
    const error = await ctx
      .call(ctx.editor, () =>
        ctx.service.addCase(ctx.editor, created.body.planId, created.etag, {
          title: 'x',
          extra: 1,
        }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(error)).not.toContain('"x"');
  });
});

describe('updateCase and removeCase', () => {
  it('edits a case under If-Match and refuses a stale ETag (concurrent PATCH: second fails)', async () => {
    const ctx = setup();
    const { caseId, plan } = await draftWithCase(ctx);
    const first = await ctx.call(ctx.editor, () =>
      ctx.service.updateCase(ctx.editor, caseId, plan.case.etag, { title: 'Renamed' }),
    );
    expect(first.body.title).toBe('Renamed');
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.updateCase(ctx.editor, caseId, plan.case.etag, { title: 'Lost update' }),
      ),
    ).rejects.toMatchObject({ code: 'ETAG_MISMATCH' });
  });

  it('requires If-Match on a PATCH and rejects an empty patch', async () => {
    const ctx = setup();
    const { caseId, plan } = await draftWithCase(ctx);
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.updateCase(ctx.editor, caseId, undefined, { title: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    await expect(
      ctx.call(ctx.editor, () => ctx.service.updateCase(ctx.editor, caseId, plan.case.etag, {})),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers TEST_CASE_NOT_FOUND for an unknown case', async () => {
    const ctx = setup();
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.updateCase(ctx.editor, '0198f0a0-0000-7000-8000-0000000000ff', '"v1"', {
          title: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'TEST_CASE_NOT_FOUND' });
  });

  it('refuses to edit a case of an approved version (PLAN_VERSION_IMMUTABLE)', async () => {
    const ctx = setup();
    const { caseId, plan, planId } = await draftWithCase(ctx);
    ctx.store.setPlanStatus(planId, 'approved');
    await expect(
      ctx.call(ctx.editor, () =>
        ctx.service.updateCase(ctx.editor, caseId, plan.case.etag, { title: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE' });
    await expect(
      ctx.call(ctx.editor, () => ctx.service.removeCase(ctx.editor, caseId, plan.case.etag)),
    ).rejects.toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE' });
  });

  it('soft-removes a case once, and a second DELETE is an idempotent 200 that audits nothing new', async () => {
    const ctx = setup();
    const { caseId, plan } = await draftWithCase(ctx);
    const removed = await ctx.call(ctx.editor, () =>
      ctx.service.removeCase(ctx.editor, caseId, plan.case.etag),
    );
    expect(removed.body.status).toBe('removed');
    const auditsAfterFirst = ctx.store.audits.filter(
      (a) => a.action === 'test_case.removed',
    ).length;
    const again = await ctx.call(ctx.editor, () =>
      ctx.service.removeCase(ctx.editor, caseId, undefined),
    );
    expect(again.body.status).toBe('removed');
    expect(ctx.store.audits.filter((a) => a.action === 'test_case.removed').length).toBe(
      auditsAfterFirst,
    );
  });

  it('refuses a DELETE with a stale If-Match (412) and a live DELETE with none (428)', async () => {
    const ctx = setup();
    const { caseId, plan } = await draftWithCase(ctx);
    await expect(
      ctx.call(ctx.editor, () => ctx.service.removeCase(ctx.editor, caseId, undefined)),
    ).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    await expect(
      ctx.call(ctx.editor, () => ctx.service.removeCase(ctx.editor, caseId, '"v0"')),
    ).rejects.toMatchObject({ code: 'ETAG_MISMATCH' });
    expect(plan.case.body.status).toBe('proposed');
  });

  it('counts committed mutations by operation on the registry', async () => {
    const ctx = setup();
    const { caseId, plan } = await draftWithCase(ctx);
    await ctx.call(ctx.editor, () =>
      ctx.service.updateCase(ctx.editor, caseId, plan.case.etag, { title: 'y' }),
    );
    const text = await ctx.registry.metrics();
    expect(text).toContain('test_plan_mutations_total{op="add_case"} 1');
    expect(text).toContain('test_plan_mutations_total{op="update_case"} 1');
    expect(text).toContain('test_plan_mutations_total{op="create_version"} 1');
  });
});
