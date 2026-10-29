// GraphQL assessment-request reads against real Postgres (SCOPE-001, API-009): RLS and the explicit tenant
// filter confine the rows to the caller's tenant, drafts are visible to their requester and to privileged
// roles only, and a foreign id reads as absent. Needs Docker (Testcontainers); run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assessmentRequests,
  createDatabase,
  memberships,
  migrateDatabase,
  tenants,
  withTenant,
} from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgAssessmentReadStore } from './postgres.js';

let handle: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const requesterA = newId();
const auditorA = newId();
const requesterB = newId();
const draftByRequester = newId();
const draftByOther = newId();
const foreignRequest = newId();

async function seedTenant(id: string, slug: string): Promise<void> {
  await withTenant(createDatabase(handle.appPool), id, (tx) =>
    tx.insert(tenants).values({ id, slug, name: slug, region: 'eu-west-1' }),
  );
}

async function seedUser(id: string): Promise<void> {
  await handle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [id, `sub-${id}`, `${id}@scope.test`, null],
  );
}

async function seedMembership(tenantId: string, userId: string, roles: string[]): Promise<void> {
  await withTenant(createDatabase(handle.appPool), tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId, roles }),
  );
}

async function seedDraft(tenantId: string, id: string, requestedBy: string): Promise<void> {
  await withTenant(createDatabase(handle.appPool), tenantId, (tx) =>
    tx.insert(assessmentRequests).values({
      id,
      tenantId,
      publicId: `areq_${id.replaceAll('-', '').slice(-20)}`,
      mode: 'black',
      objective: 'Assess the login flow',
      assetIds: [newId()],
      maxIntrusiveness: 'passive',
      budgets: {},
      trigger: 'console',
      status: 'draft',
      requestedBy,
    }),
  );
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await seedTenant(tenantA, 'acme-scope-gql');
  await seedTenant(tenantB, 'beta-scope-gql');
  for (const user of [requesterA, auditorA, requesterB]) await seedUser(user);
  await seedMembership(tenantA, requesterA, ['developer']);
  await seedMembership(tenantA, auditorA, ['auditor']);
  await seedMembership(tenantB, requesterB, ['developer']);
  await seedDraft(tenantA, draftByRequester, requesterA);
  await seedDraft(tenantA, draftByOther, auditorA);
  await seedDraft(tenantB, foreignRequest, requesterB);
});

afterAll(async () => {
  await handle.stop();
});

describe('assessment request store over Postgres (RLS)', () => {
  it("lists only the caller tenant's requests", async () => {
    const store = createPgAssessmentReadStore(createDatabase(handle.appPool));
    const rows = await store.listRequests(tenantA, {
      limit: 50,
      viewerId: requesterA,
      privileged: true,
    });
    expect(rows.map((row) => row.id).sort()).toEqual([draftByOther, draftByRequester].sort());
    expect(rows.map((row) => row.id)).not.toContain(foreignRequest);
  });

  it('shows a requester only their own draft unless the role is privileged', async () => {
    const store = createPgAssessmentReadStore(createDatabase(handle.appPool));
    const own = await store.listRequests(tenantA, {
      limit: 50,
      viewerId: requesterA,
      privileged: false,
    });
    expect(own.map((row) => row.id)).toEqual([draftByRequester]);
    const foreignDraft = await store.findRequest(tenantA, draftByOther, {
      viewerId: requesterA,
      privileged: false,
    });
    expect(foreignDraft).toBeUndefined();
  });

  it('reads a foreign tenant request as absent, not as an error', async () => {
    const store = createPgAssessmentReadStore(createDatabase(handle.appPool));
    const found = await store.findRequest(tenantA, foreignRequest, {
      viewerId: auditorA,
      privileged: true,
    });
    expect(found).toBeUndefined();
    const own = await store.findRequest(tenantB, foreignRequest, {
      viewerId: requesterB,
      privileged: false,
    });
    expect(own?.id).toBe(foreignRequest);
  });

  it('resolves the roles of a user only in the same tenant', async () => {
    const store = createPgAssessmentReadStore(createDatabase(handle.appPool));
    expect(await store.rolesOf(tenantA, auditorA)).toEqual(['auditor']);
    expect(await store.rolesOf(tenantB, auditorA)).toEqual([]);
  });

  it('fails closed without a valid tenant id', async () => {
    const store = createPgAssessmentReadStore(createDatabase(handle.appPool));
    await expect(
      store.listRequests('not-a-tenant', { limit: 5, viewerId: requesterA, privileged: true }),
    ).rejects.toThrow();
  });
});
