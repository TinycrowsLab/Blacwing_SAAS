// cost.rls: tenant isolation, constraints and grants for the cost ledger and price tables (COST-001,
// CONTEXT_PACK §7, §8.6, §8.8, §8.9). Runs the real migrations against Postgres 16 (Testcontainers).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const SHA = 'b'.repeat(64);

/** Postgres error code of a rejected promise (23505 unique, 23514 check, 23503 FK, 42501 RLS / privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Runs `fn` as the platform operator (owner connection, SET ROLE bw_operator), no tenant context. */
async function asOperator<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bw_operator');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertPriceTable(
  client: pg.PoolClient,
  overrides: { model?: string; version?: number; provider?: string } = {},
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
        cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
     VALUES ($1, $2, $3, $4, 3, 15, 3.75, 0.3, now(), $5)`,
    [
      id,
      overrides.provider ?? 'anthropic',
      overrides.model ?? 'claude-sonnet-5-5',
      overrides.version ?? 1,
      SHA,
    ],
  );
  return id;
}

interface LedgerOverrides {
  tenantId?: string;
  usageEventId?: string;
  stage?: string;
  model?: string;
  inputTokens?: number;
  costUsd?: string;
  priceTableId?: string;
}

/** Inserts one ledger row under the tenant context of `tx` (the caller decides which tenant). */
async function insertLedgerRow(
  tx: pg.PoolClient,
  priceTableId: string,
  overrides: LedgerOverrides = {},
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO cost_ledger (id, tenant_id, run_id, stage, persona, provider, model, price_table_id,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, usage_event_id, occurred_at)
     VALUES ($1, $2, $3, $4, NULL, 'anthropic', $5, $6, $7, 300, 0, 50, $8, $9, now())`,
    [
      id,
      overrides.tenantId ?? tenantA,
      newId(),
      overrides.stage ?? 'execution',
      overrides.model ?? 'claude-sonnet-5-5',
      overrides.priceTableId ?? priceTableId,
      overrides.inputTokens ?? 1200,
      overrides.costUsd ?? '0.0123456789',
      overrides.usageEventId ?? `evt_${newId()}`,
    ],
  );
  return id;
}

let priceTableId = '';
let rowA = '';
let rowB = '';

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  priceTableId = await asOperator((client) => insertPriceTable(client));
  rowA = await db.withTenant(tenantA, (tx) =>
    insertLedgerRow(tx, priceTableId, { usageEventId: 'evt-shared' }),
  );
  rowB = await db.withTenant(tenantB, (tx) =>
    insertLedgerRow(tx, priceTableId, { tenantId: tenantB, usageEventId: 'evt-shared' }),
  );
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe('cost ledger tenant isolation (RLS)', () => {
  it('tenant A sees only its own ledger rows', async () => {
    const rows = await db.withTenant(
      tenantA,
      async (tx) => (await tx.query<{ id: string }>('SELECT id FROM cost_ledger')).rows,
    );
    expect(rows).toEqual([{ id: rowA }]);
  });

  it('tenant A cannot read, change or delete tenant B rows', async () => {
    await db.withTenant(tenantA, async (tx) => {
      expect((await tx.query('SELECT 1 FROM cost_ledger WHERE id = $1', [rowB])).rowCount).toBe(0);
    });
    // The runtime role has no UPDATE on the ledger at all (append-only), so the statement is refused outright.
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('UPDATE cost_ledger SET model = model WHERE id = $1', [rowB]),
        ),
      ),
    ).toBe('42501');
    const stillThere = await db.withTenant(
      tenantB,
      async (tx) => (await tx.query('SELECT 1 FROM cost_ledger WHERE id = $1', [rowB])).rowCount,
    );
    expect(stillThere).toBe(1);
  });

  it('tenant A cannot write a ledger row for tenant B', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => insertLedgerRow(tx, priceTableId, { tenantId: tenantB })),
      ),
    ).toBe('42501');
  });

  it('fails closed on cost_ledger without a tenant context', async () => {
    const client = await db.appPool.connect();
    try {
      expect(['42704', '22P02']).toContain(await pgCode(client.query('SELECT * FROM cost_ledger')));
    } finally {
      client.release();
    }
  });
});

describe('cost ledger append-only grants (§8.8)', () => {
  it('the runtime role cannot UPDATE, DELETE or TRUNCATE the ledger, even its own row', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('UPDATE cost_ledger SET model = model WHERE id = $1', [rowA]),
        ),
      ),
    ).toBe('42501');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => tx.query('DELETE FROM cost_ledger WHERE id = $1', [rowA])),
      ),
    ).toBe('42501');
    expect(await pgCode(db.withTenant(tenantA, (tx) => tx.query('TRUNCATE cost_ledger')))).toBe(
      '42501',
    );
  });

  it('a correction is a new compensating row, not an edit', async () => {
    const compensating = await db.withTenant(tenantA, (tx) =>
      insertLedgerRow(tx, priceTableId, { costUsd: '0', usageEventId: 'evt-correction-1' }),
    );
    expect(compensating).not.toBe(rowA);
  });
});

describe('cost ledger constraints', () => {
  it('rejects a duplicate usage event id for the same tenant (idempotent ingestion)', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          insertLedgerRow(tx, priceTableId, { usageEventId: 'evt-shared' }),
        ),
      ),
    ).toBe('23505');
  });

  it('allows the same usage event id in another tenant (the key is per tenant)', async () => {
    // rowB was inserted with the same usage_event_id as rowA in beforeAll; that insert must have succeeded.
    const rows = await db.withTenant(
      tenantB,
      async (tx) =>
        (
          await tx.query<{ usage_event_id: string }>(
            'SELECT usage_event_id FROM cost_ledger WHERE id = $1',
            [rowB],
          )
        ).rows,
    );
    expect(rows).toEqual([{ usage_event_id: 'evt-shared' }]);
  });

  it.each([
    ['a negative token count', { inputTokens: -1 }],
    ['a token count above the cap', { inputTokens: 1_000_000_001 }],
    ['a negative cost', { costUsd: '-0.01' }],
    ['an unknown stage', { stage: 'exfiltration' }],
    ['a dated model id', { model: 'claude-sonnet-5-5-20261001' }],
  ])('rejects %s (23514)', async (_label, overrides) => {
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => insertLedgerRow(tx, priceTableId, overrides))),
    ).toBe('23514');
  });

  it('rejects a row whose price table pin does not exist (23503)', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          insertLedgerRow(tx, newId(), { usageEventId: 'evt-orphan' }),
        ),
      ),
    ).toBe('23503');
  });
});

describe('price tables (platform reference data, §8.9)', () => {
  it('tenants read the price tables without any tenant context', async () => {
    const client = await db.appPool.connect();
    try {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM price_tables');
      expect(rows.map((r) => r.id)).toContain(priceTableId);
    } finally {
      client.release();
    }
  });

  it('a tenant cannot insert, update or delete a price table', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
                cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
             VALUES ($1, 'anthropic', 'claude-haiku-5-5', 1, 1, 5, 1.25, 0.1, now(), $2)`,
            [newId(), SHA],
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('UPDATE price_tables SET active = false WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBe('42501');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('DELETE FROM price_tables WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBe('42501');
  });

  it('unique (provider, model, version): a second version is allowed, a duplicate is not', async () => {
    await asOperator((client) => insertPriceTable(client, { version: 2 }));
    expect(await pgCode(asOperator((client) => insertPriceTable(client, { version: 2 })))).toBe(
      '23505',
    );
  });

  it('a price cannot be changed in place, even by the operator; only active may flip', async () => {
    expect(
      await pgCode(
        asOperator((client) =>
          client.query('UPDATE price_tables SET input_per_mtok = 99 WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBe('23001');
    expect(
      await pgCode(
        asOperator((client) =>
          client.query('UPDATE price_tables SET active = false WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBeUndefined();
  });

  it('a price row is immutable: the operator may flip active, never change a price (§8.9)', async () => {
    expect(
      await pgCode(
        asOperator((client) =>
          client.query('UPDATE price_tables SET output_per_mtok = 99 WHERE id = $1', [
            priceTableId,
          ]),
        ),
      ),
    ).toBe('23001');
    expect(
      await pgCode(
        asOperator((client) =>
          client.query('UPDATE price_tables SET active = false WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBe(undefined);
  });

  it('the operator role cannot delete a price table', async () => {
    expect(
      await pgCode(
        asOperator((client) =>
          client.query('DELETE FROM price_tables WHERE id = $1', [priceTableId]),
        ),
      ),
    ).toBe('42501');
  });
});
