// Standing authorisations and assets (AUTHZ-002): tenant isolation (RLS, FORCE), fail-closed context, the
// conditional write on `version`, the audit event that commits with the change, and the no-delete grant,
// against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SodViolationError } from '@blackwing/domain/sod';
import { TenantContextMissingError } from '@blackwing/errors';
import { StandingAuthorisationId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { unverifiedAssetIds } from './asset-verification.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import {
  type GateDecisionAuditHook,
  type NewStandingAuthorisation,
  type StandingAuthorisationDecision,
  type StandingAuthorisationAuditEvent,
  StandingAuthorisationRepository,
} from './standing-authorisation.repository.js';

let db: PostgresHandle;
const tenantA = '0198f0a0-0000-7000-8000-00000000000a';
const tenantB = '0198f0a0-0000-7000-8000-00000000000b';
const requester = '0198f0a0-0000-7000-8000-0000000000a3';
const assetA = '0198f0a0-0000-7000-8000-0000000000e1';
const assetUnverifiedA = '0198f0a0-0000-7000-8000-0000000000e3';
const assetExpiredA = '0198f0a0-0000-7000-8000-0000000000e4';
const assetDeletedA = '0198f0a0-0000-7000-8000-0000000000e5';
const assetB = '0198f0a0-0000-7000-8000-0000000000f1';

/** Postgres error code of a rejected promise (42501 insufficient_privilege / RLS). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRepo(
  events: StandingAuthorisationAuditEvent[] = [],
  gateAudit: GateDecisionAuditHook = () => undefined,
) {
  return new StandingAuthorisationRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      events.push(event);
    },
    gateAudit,
  });
}

/** The approver of the approval tests: a different person from `requester`. */
const approver = '0198f0a0-0000-7000-8000-0000000000a4';
const approvalOf = {
  approverId: approver,
  signature: 'eyJhbGciOiJFZDI1NTE5In0..c2ln',
  signingKeyId: 'bw-sa-signing:v1',
  envelopeHash: 'a'.repeat(64),
};
const approvedBy = (actorId: string): StandingAuthorisationDecision => ({
  decision: 'approved',
  actorId,
  reason: null,
  decidedAt: new Date('2026-11-02T09:00:00.000Z'),
});

/** Inserts a draft and moves it to pending_approval (version 2), as a submit would. */
async function pendingSa(repo: StandingAuthorisationRepository, id: string): Promise<void> {
  await repo.insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
  await repo.writeIf(
    tenantA,
    id,
    1,
    { fields: {}, status: 'pending_approval' },
    auditOf('authz.sa.submitted', 'sa_x'),
  );
}

/** The gate decisions the database holds for one SA, read inside the tenant's context (RLS applies, FORCE). */
async function gateRowsOf(id: string) {
  const client = await db.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const { rows } = await client.query<{ decision: string; actor_id: string; gate: number }>(
      'SELECT decision, actor_id, gate FROM authz_gate_decisions WHERE subject_id = $1 AND subject_type = $2',
      [id, 'sa'],
    );
    await client.query('COMMIT');
    return rows;
  } finally {
    client.release();
  }
}

function draftFor(id: string): NewStandingAuthorisation {
  return {
    id,
    publicId: StandingAuthorisationId.fromUuid(id),
    requesterId: requester,
    assetIds: [assetA],
    scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: ['header-audit'],
    defaultBudgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 3_600_000 },
    testWindows: [{ cron: '0 2 * * 1-5', timezone: 'Europe/Berlin', durationMs: 7_200_000 }],
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  };
}

const auditOf = (action: StandingAuthorisationAuditEvent['action'], saId: string) => ({
  action,
  actorId: requester,
  saId,
  changedFields: ['maxIntrusiveness'],
});

/** The asset kinds the lookup tests need: verified, or unverified, expired or soft-deleted after verification. */
type AssetKind = 'verified' | 'unverified' | 'expired' | 'deleted';

/** Inserts an asset of the owner `requester`, named after its kind (see the lookup tests). */
async function insertAsset(
  tx: { query(text: string, values?: unknown[]): Promise<unknown> },
  id: string,
  tenantId: string,
  kind: AssetKind,
): Promise<void> {
  const verified = kind !== 'unverified';
  await tx.query(
    `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id,
       verification_status, verification_method, verified_at, verification_expires_at, deleted_at)
     VALUES ($1, $2, $3, 'web_app', $4, '[{"kind":"host","value":"app.example.test"}]'::jsonb, 'prod', $5,
       $6, $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      `asset_${id.replaceAll('-', '')}`,
      kind,
      requester,
      verified ? 'verified' : 'unverified',
      verified ? 'dns_txt' : null,
      verified ? new Date('2026-10-01T00:00:00.000Z') : null,
      kind === 'expired' ? new Date('2026-10-02T00:00:00.000Z') : null,
      kind === 'deleted' ? new Date('2026-10-03T00:00:00.000Z') : null,
    ],
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  for (const [id, slug] of [
    [tenantA, 'sa-a'],
    [tenantB, 'sa-b'],
  ] as const) {
    await db.withTenant(id, async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, region, plan) VALUES ($1, $2, $3, 'eu-west-1', 'team')`,
        [id, slug, `Tenant ${slug}`],
      );
    });
  }
  await db.withTenant(tenantA, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, 'sub-sa-requester', 'requester@example.com', 'Requester')`,
      [requester],
    );
    await insertAsset(tx, assetA, tenantA, 'verified');
    await insertAsset(tx, assetUnverifiedA, tenantA, 'unverified');
    await insertAsset(tx, assetExpiredA, tenantA, 'expired');
    await insertAsset(tx, assetDeletedA, tenantA, 'deleted');
  });
  await db.withTenant(tenantB, async (tx) => {
    await insertAsset(tx, assetB, tenantB, 'verified');
  });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('standing authorisations: create and read', () => {
  it('inserts a draft at version 1 and records the audit event in the same transaction', async () => {
    const events: StandingAuthorisationAuditEvent[] = [];
    const repo = makeRepo(events);
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    const row = await repo.insertDraft(tenantA, draftFor(id), {
      action: 'authz.sa.created',
      actorId: requester,
      saId: StandingAuthorisationId.fromUuid(id),
      changedFields: ['assetIds'],
    });
    expect(row).toMatchObject({
      id,
      status: 'draft',
      version: 1,
      tenantId: tenantA,
      approverId: null,
      signature: null,
    });
    expect(events).toEqual([
      expect.objectContaining({ action: 'authz.sa.created', tenantId: tenantA }),
    ]);
    expect((await repo.read(tenantA, id))?.publicId).toBe(StandingAuthorisationId.fromUuid(id));
  });

  it('hides another tenant draft from a tenant context (RLS on standing_authorisations)', async () => {
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await makeRepo().insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    expect(await makeRepo().read(tenantB, id)).toBeUndefined();
  });

  it('fails closed with no tenant context, before any query runs', async () => {
    await expect(makeRepo().read('', 'x')).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('pages in id order, strictly after the cursor id', async () => {
    const repo = makeRepo();
    const ids = [1, 2, 3].map(() =>
      StandingAuthorisationId.toUuid(StandingAuthorisationId.generate()),
    );
    for (const id of ids)
      await repo.insertDraft(tenantB, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    const all = await repo.list(tenantB, { limit: 10 });
    const sorted = all.map((row) => row.id);
    expect(sorted).toEqual([...sorted].sort());
    const after = await repo.list(tenantB, {
      ...(sorted[0] === undefined ? {} : { afterId: sorted[0] }),
      limit: 10,
    });
    expect(after.map((row) => row.id)).toEqual(sorted.slice(1));
  });
});

describe('standing authorisations: conditional write', () => {
  it('applies a write only at the expected version, bumps it, and audits the change', async () => {
    const events: StandingAuthorisationAuditEvent[] = [];
    const repo = makeRepo(events);
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await repo.insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    const updated = await repo.writeIf(
      tenantA,
      id,
      1,
      { fields: { maxIntrusiveness: 'passive' } },
      auditOf('authz.sa.updated', 'sa_x'),
    );
    expect(updated).toMatchObject({ version: 2, maxIntrusiveness: 'passive' });
    expect(events.at(-1)).toMatchObject({ action: 'authz.sa.updated', tenantId: tenantA });
    expect(
      await repo.writeIf(
        tenantA,
        id,
        1,
        { fields: { maxIntrusiveness: 'state_changing' } },
        auditOf('authz.sa.updated', 'sa_x'),
      ),
    ).toBeUndefined();
    expect((await repo.read(tenantA, id))?.maxIntrusiveness).toBe('passive');
  });

  it('refuses a write from another tenant (RLS), and leaves the row untouched', async () => {
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    const repo = makeRepo();
    await repo.insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    expect(
      await repo.writeIf(
        tenantB,
        id,
        1,
        { fields: {}, status: 'revoked' },
        auditOf('authz.sa.updated', 'sa_x'),
      ),
    ).toBeUndefined();
    expect((await repo.read(tenantA, id))?.status).toBe('draft');
  });

  it('rolls the write back when the audit hook fails (no unaudited change)', async () => {
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await makeRepo().insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    const failing = new StandingAuthorisationRepository({
      db: createDatabase(db.appPool),
      audit: () => {
        throw new Error('audit unavailable');
      },
      gateAudit: () => undefined,
    });
    await expect(
      failing.writeIf(
        tenantA,
        id,
        1,
        { fields: { maxIntrusiveness: 'passive' } },
        auditOf('authz.sa.updated', 'sa_x'),
      ),
    ).rejects.toThrow('audit unavailable');
    expect((await makeRepo().read(tenantA, id))?.version).toBe(1);
  });
});

describe('standing authorisations: approval (AUTHZ-008)', () => {
  it('activates the SA and records the gate decision and its audit in the same transaction', async () => {
    const events: StandingAuthorisationAuditEvent[] = [];
    const gateEvents: unknown[] = [];
    const repo = makeRepo(events, (event) => {
      gateEvents.push(event);
    });
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await pendingSa(repo, id);
    const active = await repo.writeIf(
      tenantA,
      id,
      2,
      { fields: {}, status: 'active', approval: approvalOf, decision: approvedBy(approver) },
      auditOf('authz.sa.approved', 'sa_x'),
    );
    expect(active).toMatchObject({
      status: 'active',
      version: 3,
      approverId: approver,
      signature: approvalOf.signature,
      signingKeyId: 'bw-sa-signing:v1',
      envelopeHash: approvalOf.envelopeHash,
    });
    expect(await gateRowsOf(id)).toEqual([{ decision: 'approved', actor_id: approver, gate: 1 }]);
    expect(gateEvents).toEqual([
      expect.objectContaining({
        action: 'authz.gate.decision',
        subjectType: 'sa',
        decision: 'approved',
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ action: 'authz.sa.approved', actorId: requester });
  });

  it('refuses the requester as the approver in the database too (SoD), and changes nothing', async () => {
    const repo = makeRepo();
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await pendingSa(repo, id);
    await expect(
      repo.writeIf(
        tenantA,
        id,
        2,
        {
          fields: {},
          status: 'active',
          approval: { ...approvalOf, approverId: requester },
          decision: approvedBy(requester),
        },
        auditOf('authz.sa.approved', 'sa_x'),
      ),
    ).rejects.toBeInstanceOf(SodViolationError);
    const row = await repo.read(tenantA, id);
    expect(row).toMatchObject({ status: 'pending_approval', version: 2, approverId: null });
    expect(await gateRowsOf(id)).toEqual([]);
  });

  it('rolls the approval back when its gate audit fails (no decision without an audit trail)', async () => {
    const repo = makeRepo([], () => {
      throw new Error('audit unavailable');
    });
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await pendingSa(repo, id);
    await expect(
      repo.writeIf(
        tenantA,
        id,
        2,
        { fields: {}, status: 'active', approval: approvalOf, decision: approvedBy(approver) },
        auditOf('authz.sa.approved', 'sa_x'),
      ),
    ).rejects.toThrow('audit unavailable');
    expect(await repo.read(tenantA, id)).toMatchObject({ status: 'pending_approval', version: 2 });
    expect(await gateRowsOf(id)).toEqual([]);
  });

  it('records a rejection as a gate decision with its reason and returns the SA to draft', async () => {
    const repo = makeRepo();
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await pendingSa(repo, id);
    const draft = await repo.writeIf(
      tenantA,
      id,
      2,
      {
        fields: {},
        status: 'draft',
        decision: {
          decision: 'rejected',
          actorId: approver,
          reason: 'too broad',
          decidedAt: new Date(),
        },
      },
      auditOf('authz.sa.rejected', 'sa_x'),
    );
    expect(draft).toMatchObject({ status: 'draft', version: 3, approverId: null });
    expect(await gateRowsOf(id)).toEqual([{ decision: 'rejected', actor_id: approver, gate: 1 }]);
  });
});

describe('standing authorisations: database guarantees', () => {
  it('refuses a raw insert whose tenant does not match the context (WITH CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
           VALUES (gen_random_uuid(), $1, 'sa_cross', ARRAY[$2]::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '1 day', $3)`,
          [tenantB, assetA, requester],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('never deletes a standing authorisation: the runtime role has no DELETE grant', async () => {
    const id = StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
    await makeRepo().insertDraft(tenantA, draftFor(id), auditOf('authz.sa.created', 'sa_x'));
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM standing_authorisations WHERE id = $1', [id]),
      ),
    );
    expect(code).toBe('42501');
  });

  it('refuses a status outside the lifecycle (CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE standing_authorisations SET status = 'approved' WHERE tenant_id = $1`, [
          tenantA,
        ]),
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('assets: verification lookup', () => {
  it('returns no ids for a verified, live, unexpired asset of the caller tenant', async () => {
    expect(await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [assetA])).toEqual([]);
  });

  it('returns the unverified ids of the request, and only those', async () => {
    expect(
      await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [assetA, assetUnverifiedA]),
    ).toEqual([assetUnverifiedA]);
  });

  it('treats an expired verification as unverified (fail closed)', async () => {
    expect(await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [assetExpiredA])).toEqual([
      assetExpiredA,
    ]);
  });

  it('treats a soft-deleted asset as unverified', async () => {
    expect(await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [assetDeletedA])).toEqual([
      assetDeletedA,
    ]);
  });

  it('treats another tenant asset as unverified (fail closed, RLS hides the row)', async () => {
    expect(await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [assetB])).toEqual([
      assetB,
    ]);
  });

  it('hides another tenant asset rows from a tenant context', async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT id FROM assets WHERE id = $1', [assetB]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('answers no unverified ids for an empty request without a query', async () => {
    expect(await unverifiedAssetIds(createDatabase(db.appPool), tenantA, [])).toEqual([]);
  });
});
