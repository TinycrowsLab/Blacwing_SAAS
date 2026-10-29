// The submit-gate reads of SCOPE-005 and the audit writes of the request lifecycle, against the real migrations on
// Postgres 16 (Testcontainers). Run with `pnpm test:int`. Every read is tenant-scoped: another tenant's row is never
// returned, and a read with no tenant fails closed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  AssessmentRequestRepository,
  type AssessmentRequestAuditEvent,
} from './assessment-request.repository.js';
import { AssetCatalogRepository } from './asset-catalog.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import { StandingAuthorisationReader } from './standing-authorisation-reader.repository.js';
import { TenantHaltRepository } from './tenant-halt.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const requester = newId();

/** Inserts an asset of `tenantId` owned by a fresh user; a verified one records its method and time (§8.10). */
async function insertAsset(tenantId: string, status = 'verified'): Promise<string> {
  const id = newId();
  const owner = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
      owner,
      `scope-${owner}`,
      `scope-${owner}@example.test`,
    ]);
    await tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status, verification_method, verified_at)
       VALUES ($1, $2, $3, 'web_app', 'Checkout API', '[{"kind":"host","value":"app.example.com"}]', 'staging', $4, $5, $6, $7)`,
      [
        id,
        tenantId,
        `asset_${id.replaceAll('-', '')}`,
        owner,
        status,
        status === 'verified' ? 'dns_txt' : null,
        status === 'verified' ? new Date() : null,
      ],
    );
  });
  return id;
}

/** Inserts an active standing authorisation of `tenantId` covering `assetId`, and returns its id. */
async function insertSa(tenantId: string, assetId: string): Promise<string> {
  const id = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
       VALUES ($1, $2, $3, $4::uuid[], '{"rules":[]}', 'active_safe', '{}', '[]', now() - interval '1 day', now() + interval '30 days', $5)`,
      [id, tenantId, `sa_${id.replaceAll('-', '')}`, [assetId], requester],
    );
  });
  return id;
}

/** Opens a tenant kill; `reenabled` closes it again. */
async function insertTenantKill(tenantId: string, reenabled: boolean): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO kill_events (id, tenant_id, scope, source, actor_type, actor_ref, reason, reenabled_at, reenabled_by)
       VALUES ($1, $2, 'tenant', 'console', 'user', 'usr_test', 'integration', $3, $4)`,
      [newId(), tenantId, reenabled ? new Date() : null, reenabled ? requester : null],
    );
  });
}

const createInput = (assetIds: string[], saId: string | null = null) => ({
  mode: 'grey',
  objective: 'Assess the checkout flow',
  assetIds,
  saId,
  maxIntrusiveness: 'active_safe',
  budgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 600_000 },
  scopeRules: { rules: [] },
  trigger: 'api',
  requestedBy: requester,
});

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('AssetCatalogRepository.findInTenant (SCOPE-005, §8.10)', () => {
  it('returns the live assets of the named tenant with their owner, and never another tenant’s asset', async () => {
    const mine = await insertAsset(tenantA);
    const theirs = await insertAsset(tenantB);
    const repo = new AssetCatalogRepository({ db: createDatabase(db.appPool) });
    const found = await repo.findInTenant(tenantA, [mine, theirs]);
    expect(found.map((row) => row.id)).toEqual([mine]);
    expect(found[0]?.verificationStatus).toBe('verified');
    expect(found[0]?.ownerUserId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an unverified asset visible to the gate, which then refuses it', async () => {
    const pending = await insertAsset(tenantA, 'unverified');
    const repo = new AssetCatalogRepository({ db: createDatabase(db.appPool) });
    expect((await repo.findInTenant(tenantA, [pending]))[0]?.verificationStatus).toBe('unverified');
  });

  it('reads nothing for an empty list, refuses a non-UUID id, and fails closed with no tenant', async () => {
    const repo = new AssetCatalogRepository({ db: createDatabase(db.appPool) });
    expect(await repo.findInTenant(tenantA, [])).toEqual([]);
    await expect(repo.findInTenant(tenantA, ['not-a-uuid'])).rejects.toThrow();
    await expect(repo.findInTenant('', [newId()])).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });
});

describe('StandingAuthorisationReader.findInTenant (SCOPE-005)', () => {
  it('finds the SA of the named tenant and treats another tenant’s SA as absent', async () => {
    const asset = await insertAsset(tenantA);
    const sa = await insertSa(tenantA, asset);
    const reader = new StandingAuthorisationReader({ db: createDatabase(db.appPool) });
    expect((await reader.findInTenant(tenantA, sa))?.assetIds).toEqual([asset]);
    expect((await reader.findInTenant(tenantA, sa))?.defaultBudgets).toEqual({});
    expect(await reader.findInTenant(tenantB, sa)).toBeUndefined();
  });

  it('fails closed with no tenant context', async () => {
    const reader = new StandingAuthorisationReader({ db: createDatabase(db.appPool) });
    await expect(reader.findInTenant('', newId())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });
});

describe('TenantHaltRepository.isHalted (SCOPE-005 kill switch, §8.5)', () => {
  it('is not halted with no kill, halted by an open tenant kill, and clear again once re-enabled', async () => {
    const halt = new TenantHaltRepository({ db: createDatabase(db.appPool) });
    const fresh = newId();
    await db.withTenant(fresh, async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'Halt tenant', 'eu')`,
        [fresh, `halt-${fresh.replaceAll('-', '')}`],
      );
    });
    expect(await halt.isHalted(fresh)).toBe(false);
    await insertTenantKill(fresh, false);
    expect(await halt.isHalted(fresh)).toBe(true);
  });

  it('does not let another tenant’s open kill halt this tenant, and ignores a re-enabled kill', async () => {
    const halt = new TenantHaltRepository({ db: createDatabase(db.appPool) });
    await insertTenantKill(tenantB, false);
    expect(await halt.isHalted(tenantA)).toBe(false);
    await insertTenantKill(tenantA, true);
    expect(await halt.isHalted(tenantA)).toBe(false);
  });

  it('fails closed with no tenant context', async () => {
    const halt = new TenantHaltRepository({ db: createDatabase(db.appPool) });
    await expect(halt.isHalted('')).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('AssessmentRequestRepository audit writes (SCOPE-005 §8.8)', () => {
  const repoOf = (tenant: string, events: AssessmentRequestAuditEvent[]) =>
    new AssessmentRequestRepository({
      db: createDatabase(db.appPool),
      audit: (event) => {
        events.push(event);
      },
      tenant: () => tenant,
    });

  it('audits a draft edit as scope.request.updated with the actor', async () => {
    const events: AssessmentRequestAuditEvent[] = [];
    const repo = repoOf(tenantA, events);
    const created = await repo.create(createInput([newId()]));
    await repo.updateDraft(created.id, 0, { objective: 'Edited objective' }, requester);
    expect(events.at(-1)).toMatchObject({
      action: 'scope.request.updated',
      requestId: created.id,
      actorId: requester,
    });
  });

  it('audits a submit as scope.request.submitted with the bound SA and the assets', async () => {
    const events: AssessmentRequestAuditEvent[] = [];
    const repo = repoOf(tenantA, events);
    const asset = await insertAsset(tenantA);
    const sa = await insertSa(tenantA, asset);
    const created = await repo.create(createInput([asset], sa));
    const submitted = await repo.transition(created.id, 0, 'submitted', requester);
    expect(submitted.status).toBe('submitted');
    expect(events.at(-1)).toMatchObject({
      action: 'scope.request.submitted',
      from: 'draft',
      to: 'submitted',
      saId: sa,
      assetIds: [asset],
    });
  });

  it('audits a withdrawal as scope.request.withdrawn', async () => {
    const events: AssessmentRequestAuditEvent[] = [];
    const repo = repoOf(tenantA, events);
    const created = await repo.create(createInput([newId()]));
    await repo.transition(created.id, 0, 'withdrawn', requester);
    expect(events.at(-1)).toMatchObject({ action: 'scope.request.withdrawn', to: 'withdrawn' });
  });
});
