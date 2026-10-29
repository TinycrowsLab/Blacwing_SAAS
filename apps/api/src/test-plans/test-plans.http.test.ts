import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  APPSEC_A,
  APPSEC_B,
  AUDITOR_A,
  memoryMemberships,
  memoryTestPlanStore,
  plannedCase,
  RUN_A,
  TENANT_A,
  TENANT_B,
  type MemoryTestPlanStore,
} from './fixtures.test-helpers.js';
import { TestPlanModule } from './module.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/** Test IAM: the principal is `<user>@<tenant>` in a header the test controls. */
const USERS: Record<string, string> = {
  'appsec-a': APPSEC_A,
  'auditor-a': AUDITOR_A,
  'appsec-b': APPSEC_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

function principalOf(headers: Record<string, unknown>) {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user' as const, id: 'usr_none' } };
  return { actor: { type: 'user' as const, id: userId }, sessionTenantId: tenantId };
}

/** The JSON object of a response. Fields are read by name; the suite asserts their shape where it matters. */
function json(res: { json(): unknown }): Record<string, unknown> {
  return res.json() as Record<string, unknown>;
}

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let store: MemoryTestPlanStore;
let keySeq = 0;

beforeEach(async () => {
  metrics = createHttpMetrics();
  store = memoryTestPlanStore();
  store.seedRun(RUN_A, TENANT_A);
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    idempotencyStore: new InMemoryIdempotencyStore(),
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      TestPlanModule.forRoot({
        store,
        memberships: memoryMemberships({
          [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [AUDITOR_A]: ['auditor'] },
          [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
        }),
        logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
        registry: metrics.registry,
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

type Who = 'appsec-a' | 'auditor-a' | 'appsec-b';

/** Sends a request as `who` in tenant `a` or `b`, with an Idempotency-Key unless one is given. */
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  who: Who,
  tenant: 'a' | 'b',
  options: { payload?: unknown; ifMatch?: string; idempotencyKey?: string | null } = {},
) {
  const headers: Record<string, string> = { 'x-test-principal': `${who}@${tenant}` };
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  if (options.idempotencyKey !== null) {
    keySeq += 1;
    headers['idempotency-key'] = options.idempotencyKey ?? `key-${String(keySeq).padStart(8, '0')}`;
  }
  return app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

describe('POST /v1/runs/{runId}/test-plans', () => {
  it('creates version 1 with 201, an ETag and a Location', async () => {
    const res = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a');
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.headers.location).toBe(`/v1/runs/${RUN_A}/test-plans/1`);
    expect(json(res)).toMatchObject({ runId: RUN_A, version: 1, status: 'draft', cases: [] });
  });

  it('answers 400 when Idempotency-Key is missing', async () => {
    const res = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a', {
      idempotencyKey: null,
    });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ code: 'idempotency_key_required' });
  });

  it('replays the original result for a duplicate Idempotency-Key and does not create a second version', async () => {
    const key = 'plan-create-0001';
    const first = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a', {
      idempotencyKey: key,
    });
    const second = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a', {
      idempotencyKey: key,
    });
    expect(second.statusCode).toBe(first.statusCode);
    expect(json(second)).toEqual(json(first));
    expect(store.audits.filter((a) => a.action === 'test_plan.version_created')).toHaveLength(1);
  });

  it('refuses a read-only auditor with 403 and a cross-tenant caller with 404 (the run is not theirs)', async () => {
    const forbidden = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'auditor-a', 'a');
    expect(forbidden.statusCode).toBe(403);
    expect(json(forbidden)).toMatchObject({ code: 'permission_denied' });
    const cross = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-b', 'b');
    expect(cross.statusCode).toBe(404);
  });
});

describe('reads', () => {
  it('GET one version with its ETag, and a 404 PLAN_NOT_FOUND for an unknown one', async () => {
    await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a');
    const ok = await call('GET', `/v1/runs/${RUN_A}/test-plans/1`, 'auditor-a', 'a');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const missing = await call('GET', `/v1/runs/${RUN_A}/test-plans/9`, 'auditor-a', 'a');
    expect(missing.statusCode).toBe(404);
    expect(json(missing)).toMatchObject({ code: 'plan_not_found' });
  });

  it('lists versions with a cursor and a 400 for a forged cursor', async () => {
    for (let i = 0; i < 2; i += 1)
      await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a');
    const list = await call('GET', `/v1/runs/${RUN_A}/test-plans?limit=1`, 'auditor-a', 'a');
    expect(list.statusCode).toBe(200);
    expect(json(list).items).toHaveLength(1);
    expect(json(list).nextCursor).toEqual(expect.any(String));
    const bad = await call('GET', `/v1/runs/${RUN_A}/test-plans?cursor=%21%21`, 'auditor-a', 'a');
    expect(bad.statusCode).toBe(400);
  });
});

describe('cases', () => {
  async function draft() {
    const created = await call('POST', `/v1/runs/${RUN_A}/test-plans`, 'appsec-a', 'a');
    return { planId: String(json(created).planId), etag: String(created.headers.etag) };
  }

  it('POST cases: 201 with the case, its ETag; 428 without If-Match; 412 ETAG_MISMATCH when stale', async () => {
    const plan = await draft();
    const missing = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
    });
    expect(missing.statusCode).toBe(428);
    const stale = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: '"0000000000000000"',
    });
    expect(stale.statusCode).toBe(412);
    expect(json(stale)).toMatchObject({ code: 'etag_mismatch' });
    const created = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase({ title: 'Unicode ✓ 検査' }),
      ifMatch: plan.etag,
    });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toMatchObject({ title: 'Unicode ✓ 検査', status: 'proposed' });
  });

  it('POST cases on an approved version answers 409 PLAN_VERSION_IMMUTABLE', async () => {
    const plan = await draft();
    store.setPlanStatus(plan.planId, 'approved');
    const res = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ code: 'plan_version_immutable' });
  });

  it('PATCH with If-Match edits; a concurrent second PATCH with the same ETag is 412', async () => {
    const plan = await draft();
    const added = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    const caseId = String(json(added).caseId);
    const caseEtag = String(added.headers.etag);
    const first = await call('PATCH', `/v1/test-cases/${caseId}`, 'appsec-a', 'a', {
      payload: { title: 'First' },
      ifMatch: caseEtag,
    });
    expect(first.statusCode).toBe(200);
    const second = await call('PATCH', `/v1/test-cases/${caseId}`, 'appsec-a', 'a', {
      payload: { title: 'Second' },
      ifMatch: caseEtag,
    });
    expect(second.statusCode).toBe(412);
    expect(json(second)).toMatchObject({ code: 'etag_mismatch' });
  });

  it('PATCH with an unknown field is 422 and a payload over 8 KiB is 413', async () => {
    const plan = await draft();
    const added = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    const caseId = String(json(added).caseId);
    const etag = String(added.headers.etag);
    const unknown = await call('PATCH', `/v1/test-cases/${caseId}`, 'appsec-a', 'a', {
      payload: { status: 'executed' },
      ifMatch: etag,
    });
    expect(unknown.statusCode).toBe(422);
    const huge = await call('PATCH', `/v1/test-cases/${caseId}`, 'appsec-a', 'a', {
      payload: { oracle: { type: 'status_code', params: { blob: 'x'.repeat(9 * 1024) } } },
      ifMatch: etag,
    });
    expect(huge.statusCode).toBe(413);
    expect(json(huge)).toMatchObject({ code: 'plan_payload_too_large' });
  });

  it('DELETE soft-removes: 200 with status removed, then 200 again without If-Match', async () => {
    const plan = await draft();
    const added = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    const caseId = String(json(added).caseId);
    const removed = await call('DELETE', `/v1/test-cases/${caseId}`, 'appsec-a', 'a', {
      ifMatch: String(added.headers.etag),
    });
    expect(removed.statusCode).toBe(200);
    expect(json(removed)).toMatchObject({ status: 'removed' });
    const again = await call('DELETE', `/v1/test-cases/${caseId}`, 'appsec-a', 'a');
    expect(again.statusCode).toBe(200);
  });

  it('a case of another tenant is 404 TEST_CASE_NOT_FOUND; the plan id of another tenant is 404 too', async () => {
    const plan = await draft();
    const added = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-a', 'a', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    const caseId = String(json(added).caseId);
    const foreignCase = await call('PATCH', `/v1/test-cases/${caseId}`, 'appsec-b', 'b', {
      payload: { title: 'x' },
      ifMatch: String(added.headers.etag),
    });
    expect(foreignCase.statusCode).toBe(404);
    expect(json(foreignCase)).toMatchObject({ code: 'test_case_not_found' });
    const foreignPlan = await call('POST', `/v1/test-plans/${plan.planId}/cases`, 'appsec-b', 'b', {
      payload: plannedCase(),
      ifMatch: plan.etag,
    });
    expect(foreignPlan.statusCode).toBe(404);
  });
});
