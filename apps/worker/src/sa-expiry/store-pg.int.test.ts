// The SA expiry store against the real migrations (Testcontainers, Postgres 16): an active SA past its `expires_at`
// (by the database clock) becomes `expired` once, with an `authz.sa.expired` audit event in the same transaction; an
// SA not yet due, or no longer active, is left alone; tenant B can neither read nor expire tenant A's SA (RLS).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId, toPublicId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgSaExpiryStore } from './store-pg.js';

let pgHandle: PostgresHandle;
let appDb: Database;

const tenantA = newId();
const tenantB = newId();
const requester = newId();
const approver = newId();

interface Seeded {
  readonly saId: string;
}

/** An SA in `tenantId` with `expires_at` at `now() + offset` (database clock), in the given status. */
async function seed(
  tenantId: string,
  options: { readonly status: 'active' | 'draft' | 'revoked'; readonly offset: string },
): Promise<Seeded> {
  const saId = newId();
  await pgHandle.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness,
         default_budgets, test_windows, valid_from, expires_at, requester_id, approver_id, status, revocation_reason)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'low', '{}'::jsonb, '[]'::jsonb,
         now() - interval '1 day', now() + $5::interval, $6, $7, $8, $9)`,
      [
        saId,
        tenantId,
        toPublicId(saId, 'sa'),
        [newId()],
        options.offset,
        requester,
        options.status === 'active' ? approver : null,
        options.status,
        options.status === 'revoked' ? 'withdrawn by the customer' : null,
      ],
    ),
  );
  return { saId };
}

async function saRow(tenantId: string, saId: string) {
  const { rows } = await pgHandle.withTenant(tenantId, (tx) =>
    tx.query('SELECT status, version FROM standing_authorisations WHERE id = $1', [saId]),
  );
  return rows[0] as { status: string; version: number };
}

async function expiryAudits(tenantId: string, saId: string): Promise<number> {
  const { rows } = await pgHandle.withTenant(tenantId, (tx) =>
    tx.query(
      "SELECT actor->>'type' AS actor_type, actor->>'id' AS actor_id FROM audit_events WHERE action = 'authz.sa.expired' AND target->>'id' = $1",
      [saId],
    ),
  );
  for (const row of rows as { actor_type: string; actor_id: string }[]) {
    expect(row).toMatchObject({ actor_type: 'system', actor_id: 'sa-expiry' });
  }
  return rows.length;
}

beforeAll(async () => {
  pgHandle = await withPostgres({ migrations: (ownerPool) => migrateDatabase(ownerPool) });
  appDb = createDatabase(pgHandle.appPool);
}, 180_000);

afterAll(async () => {
  await (pgHandle as PostgresHandle | undefined)?.stop();
});

describe('SA expiry store (AUTHZ-010)', () => {
  it('expires an active SA past expires_at once, bumps its version and audits it', async () => {
    const sa = await seed(tenantA, { status: 'active', offset: '-1 hour' });
    const store = createPgSaExpiryStore(appDb);

    await expect(store.checkAndExpire({ tenantId: tenantA, saId: sa.saId })).resolves.toEqual({
      kind: 'expired',
    });

    expect(await saRow(tenantA, sa.saId)).toEqual({ status: 'expired', version: 2 });
    expect(await expiryAudits(tenantA, sa.saId)).toBe(1);
  });

  it('is idempotent: a second check on an expired SA is terminal and writes no second audit', async () => {
    const sa = await seed(tenantA, { status: 'active', offset: '-5 minutes' });
    const store = createPgSaExpiryStore(appDb);
    await store.checkAndExpire({ tenantId: tenantA, saId: sa.saId });

    await expect(store.checkAndExpire({ tenantId: tenantA, saId: sa.saId })).resolves.toEqual({
      kind: 'terminal',
    });
    expect(await saRow(tenantA, sa.saId)).toEqual({ status: 'expired', version: 2 });
    expect(await expiryAudits(tenantA, sa.saId)).toBe(1);
  });

  it('leaves an active SA before expires_at alone and reports the remaining time', async () => {
    const sa = await seed(tenantA, { status: 'active', offset: '2 hours' });
    const store = createPgSaExpiryStore(appDb);

    const outcome = await store.checkAndExpire({ tenantId: tenantA, saId: sa.saId });

    expect(outcome.kind).toBe('not_due');
    if (outcome.kind !== 'not_due') throw new Error('expected not_due');
    expect(outcome.remainingMs).toBeGreaterThan(60 * 60_000);
    expect(outcome.remainingMs).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(await saRow(tenantA, sa.saId)).toEqual({ status: 'active', version: 1 });
    expect(await expiryAudits(tenantA, sa.saId)).toBe(0);
  });

  it('never expires a draft or a revoked SA, even one past its expires_at', async () => {
    const draft = await seed(tenantA, { status: 'draft', offset: '-1 hour' });
    const revoked = await seed(tenantA, { status: 'revoked', offset: '-1 hour' });
    const store = createPgSaExpiryStore(appDb);

    await expect(store.checkAndExpire({ tenantId: tenantA, saId: draft.saId })).resolves.toEqual({
      kind: 'terminal',
    });
    await expect(store.checkAndExpire({ tenantId: tenantA, saId: revoked.saId })).resolves.toEqual({
      kind: 'terminal',
    });
    expect((await saRow(tenantA, draft.saId)).status).toBe('draft');
    expect((await saRow(tenantA, revoked.saId)).status).toBe('revoked');
  });

  it('cannot see or expire another tenant SA (RLS fails the lookup closed)', async () => {
    const sa = await seed(tenantA, { status: 'active', offset: '-1 hour' });
    const store = createPgSaExpiryStore(appDb);

    await expect(store.checkAndExpire({ tenantId: tenantB, saId: sa.saId })).resolves.toEqual({
      kind: 'terminal',
    });
    expect(await saRow(tenantA, sa.saId)).toEqual({ status: 'active', version: 1 });
    expect(await expiryAudits(tenantA, sa.saId)).toBe(0);
  });
});
