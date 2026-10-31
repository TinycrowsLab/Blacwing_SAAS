import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import {
  ADMIN_A,
  ADMIN_B,
  ASSET_UNVERIFIED_A,
  ASSET_VERIFIED_A,
  ASSET_VERIFIED_B,
  AUDITOR_A,
  activeSaA,
  GRANTED_RULE,
  memoryAssessmentStore,
  memoryAssets,
  memoryHalts,
  memoryMemberships,
  memoryPreflightAudit,
  memoryStandingAuthorisations,
  NOW,
  SA_A,
  SA_B,
  SA_EXPIRED_A,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { AssessmentRequestModule } from './module.js';
import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';

import type {
  AssessmentRequestResponse,
  PreflightDryRunResponse,
  Problem,
} from '@blackwing/contracts';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/** Test IAM: the principal comes from a header the test controls, as `<user>@<tenant>` (for example `admin-a@a`). */
const USERS: Record<string, string> = {
  'admin-a': ADMIN_A,
  'auditor-a': AUDITOR_A,
  'admin-b': ADMIN_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let store: ReturnType<typeof memoryAssessmentStore>;
let halted: Set<string>;
let saTable: Parameters<typeof memoryStandingAuthorisations>[0];
let preflightAudit: ReturnType<typeof memoryPreflightAudit>;

beforeEach(async () => {
  metrics = createHttpMetrics();
  store = memoryAssessmentStore();
  halted = new Set();
  preflightAudit = memoryPreflightAudit();
  saTable = {
    [`${TENANT_A}:${SA_A}`]: activeSaA(),
    [`${TENANT_A}:${SA_EXPIRED_A}`]: {
      ...activeSaA(),
      id: SA_EXPIRED_A,
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    [`${TENANT_B}:${SA_B}`]: { ...activeSaA(), id: SA_B, assetIds: [ASSET_VERIFIED_B] },
  };
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    idempotencyStore: new InMemoryIdempotencyStore(),
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      AssessmentRequestModule.forRoot({
        store,
        assets: memoryAssets({
          [TENANT_A]: { [ASSET_VERIFIED_A]: 'verified', [ASSET_UNVERIFIED_A]: 'unverified' },
          [TENANT_B]: { [ASSET_VERIFIED_B]: 'verified' },
        }),
        standingAuthorisations: memoryStandingAuthorisations(saTable),
        memberships: memoryMemberships({
          [TENANT_A]: { [ADMIN_A]: ['org_admin'], [AUDITOR_A]: ['auditor'] },
          [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
        }),
        halts: memoryHalts(halted),
        logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
        registry: metrics.registry,
        now: () => NOW,
        preflightAudit,
        modelProbe: { reachable: () => Promise.resolve(true) },
        targetResolver: { resolve: () => Promise.resolve(['203.0.113.10']) },
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const url = '/v1/assessment-requests';

/** The status of a request by its public id, read from the store (the store keys rows by uuid). */
function statusOf(requestPublicId: string): string | undefined {
  return [...store.rows.values()].find((row) => row.publicId === requestPublicId)?.status;
}
const as = (principal: string) => ({ 'x-test-principal': principal });

interface Call {
  readonly principal?: string;
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly path?: string;
  readonly body?: unknown;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
}

function call(options: Call) {
  const headers: Record<string, string> = {
    ...(options.principal === undefined ? {} : as(options.principal)),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
    ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
  };
  return app.inject({
    method: options.method ?? 'POST',
    url: `${url}${options.path ?? ''}`,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
  });
}

function etagOf(res: { readonly headers: Record<string, unknown> }): string {
  const etag = res.headers.etag;
  if (typeof etag !== 'string') throw new Error('the response carries no ETag');
  return etag;
}

/** A draft over the verified asset of tenant A, bound to the active SA. */
const goodDraft = {
  mode: 'grey',
  objective: 'Test the login flow',
  assetIds: [ASSET_VERIFIED_A],
  saId: SA_A,
  scopeRules: { rules: [GRANTED_RULE] },
  maxIntrusiveness: 'active_safe',
};

async function createDraft(
  body: Record<string, unknown> = goodDraft,
): Promise<AssessmentRequestResponse> {
  const res = await call({ principal: 'admin-a@a', body });
  expect(res.statusCode).toBe(201);
  return res.json<AssessmentRequestResponse>();
}

describe('POST /v1/assessment-requests (draft)', () => {
  it('creates a draft with an areq_ id, an ETag, the run budget defaults and the requester', async () => {
    const res = await call({ principal: 'admin-a@a', body: goodDraft });
    expect(res.statusCode).toBe(201);
    expect(etagOf(res)).toBe('"v0"');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<AssessmentRequestResponse>();
    expect(body.id).toMatch(/^areq_/);
    expect(body).toMatchObject({
      status: 'draft',
      mode: 'grey',
      assetIds: [ASSET_VERIFIED_A],
      saId: SA_A,
      requestedBy: ADMIN_A,
    });
    expect(body.budgets).toEqual({ costCapUsd: 5, maxRequests: 5000, maxDurationMs: 3600000 });
  });

  it('accepts a draft with no asset yet (the submit gate checks it later)', async () => {
    const draft = await createDraft({ mode: 'black', objective: 'Recon only' });
    expect(draft.assetIds).toEqual([]);
    expect(draft.saId).toBeNull();
    expect(draft.maxIntrusiveness).toBe('active_safe');
  });

  it('answers 404 when a named asset belongs to another tenant (no existence leak)', async () => {
    const res = await call({
      principal: 'admin-a@a',
      body: { ...goodDraft, assetIds: [ASSET_VERIFIED_B] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for a mixed list of own and foreign asset ids', async () => {
    const res = await call({
      principal: 'admin-a@a',
      body: { ...goodDraft, assetIds: [ASSET_VERIFIED_A, ASSET_VERIFIED_B] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a body with an unknown key, so nothing is silently dropped', async () => {
    const res = await call({ principal: 'admin-a@a', body: { ...goodDraft, tenantId: TENANT_B } });
    expect(res.statusCode).toBe(422);
  });

  it('refuses destructive as an intrusiveness ceiling', async () => {
    const res = await call({
      principal: 'admin-a@a',
      body: { ...goodDraft, maxIntrusiveness: 'destructive' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses an empty or oversized objective', async () => {
    expect(
      (await call({ principal: 'admin-a@a', body: { ...goodDraft, objective: '   ' } })).statusCode,
    ).toBe(422);
    expect(
      (await call({ principal: 'admin-a@a', body: { ...goodDraft, objective: 'x'.repeat(4001) } }))
        .statusCode,
    ).toBe(422);
  });

  it('refuses a caller without assessment:create (an auditor reads but cannot draft)', async () => {
    const res = await call({ principal: 'auditor-a@a', body: goodDraft });
    expect(res.statusCode).toBe(403);
  });

  it('answers 401 with no principal', async () => {
    expect((await call({ body: goodDraft })).statusCode).toBe(401);
  });
});

describe('PATCH /v1/assessment-requests/:id (If-Match)', () => {
  it('answers 428 without If-Match, and 412 for a stale ETag', async () => {
    const draft = await createDraft();
    const path = `/${draft.id}`;
    expect(
      (await call({ principal: 'admin-a@a', method: 'PATCH', path, body: { objective: 'New' } }))
        .statusCode,
    ).toBe(428);
    const stale = await call({
      principal: 'admin-a@a',
      method: 'PATCH',
      path,
      body: { objective: 'New' },
      ifMatch: '"v7"',
    });
    expect(stale.statusCode).toBe(412);
  });

  it('updates the draft and returns the next ETag; the old ETag is then stale', async () => {
    const draft = await createDraft();
    const path = `/${draft.id}`;
    const res = await call({
      principal: 'admin-a@a',
      method: 'PATCH',
      path,
      body: { objective: 'Renamed' },
      ifMatch: '"v0"',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AssessmentRequestResponse>().objective).toBe('Renamed');
    expect(etagOf(res)).toBe('"v1"');
    const again = await call({
      principal: 'admin-a@a',
      method: 'PATCH',
      path,
      body: { objective: 'Again' },
      ifMatch: '"v0"',
    });
    expect(again.statusCode).toBe(412);
  });

  it('refuses an empty patch and a patch naming a foreign asset (404)', async () => {
    const draft = await createDraft();
    const path = `/${draft.id}`;
    expect(
      (await call({ principal: 'admin-a@a', method: 'PATCH', path, body: {}, ifMatch: '"v0"' }))
        .statusCode,
    ).toBe(422);
    const foreign = await call({
      principal: 'admin-a@a',
      method: 'PATCH',
      path,
      body: { assetIds: [ASSET_VERIFIED_B] },
      ifMatch: '"v0"',
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('answers 404 for another tenant request, never 403', async () => {
    const draft = await createDraft();
    const res = await call({
      principal: 'admin-b@b',
      method: 'PATCH',
      path: `/${draft.id}`,
      body: { objective: 'x' },
      ifMatch: '"v0"',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/assessment-requests/:id/submit', () => {
  it('requires an Idempotency-Key', async () => {
    const draft = await createDraft();
    const res = await call({ principal: 'admin-a@a', path: `/${draft.id}/submit` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(statusOf(draft.id)).toBe('draft');
  });

  it('submits a verified, in-scope draft and marks it submitted', async () => {
    const draft = await createDraft();
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-happy',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AssessmentRequestResponse>()).toMatchObject({
      id: draft.id,
      status: 'submitted',
    });
  });

  it('replays the same Idempotency-Key with the identical response and creates nothing new', async () => {
    const draft = await createDraft();
    const first = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-replay',
    });
    const second = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-replay',
    });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(store.rows.size).toBe(1);
  });

  it('answers 422 with every failing check in one body when several fail together', async () => {
    const draft = await createDraft({
      ...goodDraft,
      assetIds: [ASSET_UNVERIFIED_A],
      scopeRules: { rules: [{ effect: 'include', host: 'other.example.test' }] },
      maxIntrusiveness: 'state_changing',
    });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-many',
    });
    expect(res.statusCode).toBe(422);
    const codes = res
      .json<Problem & { errors: { code: string; path: string }[] }>()
      .errors.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'ASSET_NOT_VERIFIED',
        'SCOPE_EXCEEDS_SA',
        'INTRUSIVENESS_NOT_AUTHORISED',
      ]),
    );
    expect(statusOf(draft.id)).toBe('draft');
  });

  it('answers 422 ASSET_NOT_VERIFIED for an unverified asset, field-addressed', async () => {
    const draft = await createDraft({ ...goodDraft, assetIds: [ASSET_UNVERIFIED_A] });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-unv',
    });
    expect(res.statusCode).toBe(422);
    const error = res
      .json<Problem & { errors: { code: string; path: string }[] }>()
      .errors.find((e) => e.code === 'ASSET_NOT_VERIFIED');
    expect(error?.path).toBe('assetIds[0]');
  });

  it('answers 422 SCOPE_EXCEEDS_SA when a scope rule is wider than the SA', async () => {
    const draft = await createDraft({
      ...goodDraft,
      scopeRules: { rules: [{ effect: 'include', host: '*.example.test' }] },
    });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-scope',
    });
    expect(res.statusCode).toBe(422);
    expect(
      res.json<Problem & { errors: { code: string }[] }>().errors.map((e) => e.code),
    ).toContain('SCOPE_EXCEEDS_SA');
  });

  it('answers 422 INTRUSIVENESS_NOT_AUTHORISED for state_changing under an SA that forbids it', async () => {
    const draft = await createDraft({ ...goodDraft, maxIntrusiveness: 'state_changing' });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-sc',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<Problem & { errors: { code: string }[] }>().errors.map((e) => e.code)).toEqual([
      'INTRUSIVENESS_NOT_AUTHORISED',
    ]);
  });

  it('answers 422 SA_EXPIRED when the standing authorisation expired before submit', async () => {
    const draft = await createDraft({ ...goodDraft, saId: SA_EXPIRED_A });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-exp',
    });
    expect(res.statusCode).toBe(422);
    expect(
      res.json<Problem & { errors: { code: string }[] }>().errors.map((e) => e.code),
    ).toContain('SA_EXPIRED');
  });

  it('answers 422 NO_ASSETS for a draft with no asset', async () => {
    const draft = await createDraft({ mode: 'black', objective: 'Recon only', saId: SA_A });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-none',
    });
    expect(res.statusCode).toBe(422);
    expect(
      res.json<Problem & { errors: { code: string }[] }>().errors.map((e) => e.code),
    ).toContain('NO_ASSETS');
  });

  it('answers 422 BUDGET_EXCEEDS_SA when a budget is above the SA defaults', async () => {
    const draft = await createDraft({ ...goodDraft, budgets: { costCapUsd: 50 } });
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-budget',
    });
    expect(res.statusCode).toBe(422);
    expect(
      res.json<Problem & { errors: { code: string }[] }>().errors.map((e) => e.code),
    ).toContain('BUDGET_EXCEEDS_SA');
  });

  it('answers 409 tenant_halted while the kill switch is active for the tenant', async () => {
    const draft = await createDraft();
    halted.add(TENANT_A);
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-halt',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('tenant_halted');
  });

  it('answers 404 for another tenant request and never submits it', async () => {
    const draft = await createDraft();
    const res = await call({
      principal: 'admin-b@b',
      path: `/${draft.id}/submit`,
      idempotencyKey: 'idem-key-xt',
    });
    expect(res.statusCode).toBe(404);
    expect(statusOf(draft.id)).toBe('draft');
  });
});

describe('reads and withdraw', () => {
  it('GET detail answers the ETag and 404 for a malformed or foreign id', async () => {
    const draft = await createDraft();
    const ok = await call({ principal: 'auditor-a@a', method: 'GET', path: `/${draft.id}` });
    expect(ok.statusCode).toBe(200);
    expect(etagOf(ok)).toBe('"v0"');
    expect(
      (await call({ principal: 'auditor-a@a', method: 'GET', path: '/not-an-id' })).statusCode,
    ).toBe(404);
    expect(
      (await call({ principal: 'admin-b@b', method: 'GET', path: `/${draft.id}` })).statusCode,
    ).toBe(404);
  });

  it('GET list returns only the caller tenant rows', async () => {
    await createDraft();
    await createDraft();
    const res = await call({ principal: 'auditor-a@a', method: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(2);
    const other = await call({ principal: 'admin-b@b', method: 'GET' });
    expect(other.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('withdraws a draft with If-Match and refuses without it', async () => {
    const draft = await createDraft();
    expect((await call({ principal: 'admin-a@a', path: `/${draft.id}/withdraw` })).statusCode).toBe(
      428,
    );
    const res = await call({
      principal: 'admin-a@a',
      path: `/${draft.id}/withdraw`,
      ifMatch: '"v0"',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AssessmentRequestResponse>().status).toBe('withdrawn');
  });
});

describe('POST /v1/assessment-requests/:id/preflight (#579 dry run)', () => {
  it('answers the read-only report with no-store, and audits the run', async () => {
    const draft = await createDraft();
    const res = await call({ principal: 'admin-a@a', path: `/${draft.id}/preflight` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<PreflightDryRunResponse>();
    expect(body).toMatchObject({
      requestId: draft.id,
      dryRun: true,
      ok: true,
      blockingFailures: [],
    });
    expect(body.results.map((result) => result.id)).not.toContain('loginPerRole');
    expect(body.results.map((result) => result.id)).not.toContain('deliverSocNotice');
    expect(preflightAudit.events).toHaveLength(1);
    expect(preflightAudit.events[0]?.action).toBe('scope.preflight.dry_run');
  });

  it('answers ok false with the unverified asset named and remediated', async () => {
    const draft = await createDraft({ ...goodDraft, assetIds: [ASSET_UNVERIFIED_A] });
    const res = await call({ principal: 'admin-a@a', path: `/${draft.id}/preflight` });
    const body = res.json<PreflightDryRunResponse>();
    expect(body.ok).toBe(false);
    expect(body.blockingFailures).toEqual(['verifyAssetsVerified']);
    expect(
      body.results.find((result) => result.id === 'verifyAssetsVerified')?.remediation,
    ).toBeTruthy();
  });

  it('leaves the request unchanged', async () => {
    const draft = await createDraft();
    await call({ principal: 'admin-a@a', path: `/${draft.id}/preflight` });
    const after = await call({ principal: 'admin-a@a', method: 'GET', path: `/${draft.id}` });
    expect(after.json<AssessmentRequestResponse>().status).toBe('draft');
    expect(etagOf(after)).toBe('"v0"');
  });

  it('answers 409 tenant_halted and audits nothing while the kill switch is active', async () => {
    const draft = await createDraft();
    halted.add(TENANT_A);
    const res = await call({ principal: 'admin-a@a', path: `/${draft.id}/preflight` });
    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('tenant_halted');
    expect(preflightAudit.events).toEqual([]);
  });

  it('refuses a caller without assessment:create (403) and a foreign id (404)', async () => {
    const draft = await createDraft();
    expect(
      (await call({ principal: 'auditor-a@a', path: `/${draft.id}/preflight` })).statusCode,
    ).toBe(403);
    expect(
      (await call({ principal: 'admin-b@b', path: `/${draft.id}/preflight` })).statusCode,
    ).toBe(404);
    expect((await call({ principal: 'admin-a@a', path: '/not-an-id/preflight' })).statusCode).toBe(
      404,
    );
    expect(preflightAudit.events).toEqual([]);
  });
});
