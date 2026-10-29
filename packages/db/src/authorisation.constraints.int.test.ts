// Standing authorisations (AUTHZ-001): the database CHECK, unique and RLS rules, proven as bw_app against the
// real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`. The rules here are the last line
// of defence: a bypassed creation validator still cannot store a destructive ceiling, an inverted window or an
// SA without assets (§8.1, §8.3, §8.6).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

/** Postgres error codes: 23514 check_violation, 23505 unique_violation, 42501 insufficient_privilege. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RLS_VIOLATION = '42501';

interface SaRow {
  readonly tenantId: string;
  readonly publicId: string;
  readonly assetIds: readonly string[];
  readonly scopeRules: string;
  readonly maxIntrusiveness: string;
  readonly defaultBudgets: string;
  readonly testWindows: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly version: number;
}

const INSERT_SQL = `INSERT INTO standing_authorisations
  (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows,
   valid_from, expires_at, requester_id, status, version)
  VALUES ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz, $11, $12, $13)`;

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

function validRow(overrides: Partial<SaRow> = {}): SaRow {
  return {
    tenantId: tenantA,
    publicId: `sa_${newId().replaceAll('-', '')}`,
    assetIds: [newId()],
    scopeRules: '{"include":{"hosts":["app.example.test"]}}',
    maxIntrusiveness: 'active_safe',
    defaultBudgets: '{"requests":100}',
    testWindows: '[{"cron":"0 9 * * 1-5","tz":"Europe/Berlin"}]',
    validFrom: '2026-01-01T00:00:00Z',
    expiresAt: '2026-12-31T00:00:00Z',
    status: 'draft',
    version: 1,
    ...overrides,
  };
}

/**
 * Inserts one row as bw_app under `tenant` (or with no tenant context at all). Resolves to the Postgres
 * error code of a rejected insert, or `undefined` when the row was stored.
 */
async function insertSa(
  row: SaRow,
  tenant: string | null = row.tenantId,
): Promise<string | undefined> {
  const client = await db.appPool.connect();
  try {
    await client.query('BEGIN');
    if (tenant !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    }
    await client.query(INSERT_SQL, [
      newId(),
      row.tenantId,
      row.publicId,
      row.assetIds,
      row.scopeRules,
      row.maxIntrusiveness,
      row.defaultBudgets,
      row.testWindows,
      row.validFrom,
      row.expiresAt,
      newId(),
      row.status,
      row.version,
    ]);
    await client.query('COMMIT');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  } finally {
    client.release();
  }
}

describe('standing_authorisations constraints', () => {
  it('stores a valid draft', async () => {
    await expect(insertSa(validRow())).resolves.toBeUndefined();
  });

  it.each(['passive', 'active_safe', 'state_changing'])(
    'accepts the selectable ceiling %s',
    async (ceiling) => {
      await expect(insertSa(validRow({ maxIntrusiveness: ceiling }))).resolves.toBeUndefined();
    },
  );

  it('refuses destructive as a ceiling (§8.3)', async () => {
    await expect(insertSa(validRow({ maxIntrusiveness: 'destructive' }))).resolves.toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses an unknown ceiling', async () => {
    await expect(insertSa(validRow({ maxIntrusiveness: 'wormable' }))).resolves.toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses an unknown status', async () => {
    await expect(insertSa(validRow({ status: 'approved' }))).resolves.toBe(CHECK_VIOLATION);
  });

  it('refuses a window that is inverted', async () => {
    await expect(
      insertSa(validRow({ validFrom: '2026-12-31T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' })),
    ).resolves.toBe(CHECK_VIOLATION);
  });

  it('refuses a window that is empty (valid_from equals expires_at)', async () => {
    const instant = '2026-06-01T00:00:00Z';
    await expect(insertSa(validRow({ validFrom: instant, expiresAt: instant }))).resolves.toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses an SA that covers no asset', async () => {
    await expect(insertSa(validRow({ assetIds: [] }))).resolves.toBe(CHECK_VIOLATION);
  });

  it('refuses a scope_rules value that is not an object', async () => {
    await expect(insertSa(validRow({ scopeRules: '["app.example.test"]' }))).resolves.toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses test_windows that is not an array', async () => {
    await expect(insertSa(validRow({ testWindows: '{"cron":"0 9 * * *"}' }))).resolves.toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses a version below 1', async () => {
    await expect(insertSa(validRow({ version: 0 }))).resolves.toBe(CHECK_VIOLATION);
  });

  it('refuses a duplicate public id', async () => {
    const row = validRow();
    await expect(insertSa(row)).resolves.toBeUndefined();
    await expect(insertSa({ ...row, assetIds: [newId()] })).resolves.toBe(UNIQUE_VIOLATION);
  });

  it('refuses a row written under another tenant context (WITH CHECK, §8.6)', async () => {
    await expect(insertSa(validRow({ tenantId: tenantB }), tenantA)).resolves.toBe(RLS_VIOLATION);
  });

  it('refuses a write with no tenant context at all (fails closed)', async () => {
    await expect(insertSa(validRow(), null)).resolves.toMatch(/^\w{5}$/);
  });
});
