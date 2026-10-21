// outbox: atomic commit and rollback with the domain write, RLS isolation, the dedupe index, the
// payload cap and the grants, against the real migrations on Postgres 16 (Testcontainers).

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OUTBOX_PAYLOAD_MAX_BYTES, outboxPayloadBytes } from '@blackwing/contracts';
import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { crossTenantDenied } from '@blackwing/testing';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  createDatabase,
  type Database,
  migrateDatabase,
  OutboxDuplicateError,
  type TenantTx,
  withOutbox,
  withTenant,
} from './index.js';
import { assertRlsEnabled, rlsPolicySql } from './rls.js';

let db: PostgresHandle;
let app: Database;
const tenantA = newId();
const tenantB = newId();
const silent = { logger: { child: () => ({ info: () => undefined }) } } as never;

const message = (dedupeKey?: string) =>
  ({
    type: 'audit.event',
    payload: { action: 'run.created' },
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
  }) as const;

/** Postgres error code of a rejected promise (e.g. 23505 unique_violation, 23514 check, 42501 RLS / privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof pg.DatabaseError) return cause.code;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

/** The production doorway: a Drizzle transaction on the app role with `app.tenant_id` set. */
function asTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(app, tenantId, fn);
}

/** A bare transaction, as buggy code that skipped `withTenant` would have it. */
function withoutTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return app.transaction((tx) => fn(tx as TenantTx));
}

async function countOutbox(tenantId: string, where = 'true'): Promise<number> {
  return db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query(`SELECT count(*)::int AS n FROM outbox WHERE ${where}`);
    return (rows[0] as { n: number }).n;
  });
}

async function countDomain(tenantId: string): Promise<number> {
  return db.withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query('SELECT count(*)::int AS n FROM outbox_probe_domain');
    return (rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  db = await withPostgres({
    migrations: async (owner) => {
      await migrateDatabase(owner);
      // A stand-in domain table: the outbox rows must commit or roll back together with its rows.
      await owner.query(
        'CREATE TABLE outbox_probe_domain (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)',
      );
      await owner.query(rlsPolicySql('outbox_probe_domain'));
    },
  });
  app = createDatabase(db.appPool);
});

afterAll(async () => {
  await db.stop();
});

const insertDomain = (tx: TenantTx, tenantId: string) =>
  tx.execute(sql`INSERT INTO outbox_probe_domain (id, tenant_id) VALUES (${newId()}, ${tenantId})`);

describe('outbox: atomicity with the domain write', () => {
  it('commits the domain row and its outbox rows together', async () => {
    const before = { domain: await countDomain(tenantA), outbox: await countOutbox(tenantA) };
    const ids = await asTenant(tenantA, async (tx) => {
      await insertDomain(tx, tenantA);
      return withOutbox(
        tx,
        [message(), { type: 'notify.send', payload: { template: 't' } }],
        silent,
      );
    });
    expect(ids).toHaveLength(2);
    expect(await countDomain(tenantA)).toBe(before.domain + 1);
    expect(await countOutbox(tenantA)).toBe(before.outbox + 2);
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT id, tenant_id, type, status, attempts FROM outbox WHERE id = ANY($1)', [
        ids,
      ]),
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows as { tenant_id: string; status: string; attempts: number }[]) {
      expect(row).toMatchObject({ tenant_id: tenantA, status: 'pending', attempts: 0 });
    }
  });

  it('rolls back the outbox rows when the transaction fails after withOutbox', async () => {
    const before = { domain: await countDomain(tenantA), outbox: await countOutbox(tenantA) };
    await expect(
      asTenant(tenantA, async (tx) => {
        await insertDomain(tx, tenantA);
        await withOutbox(tx, [message('rollback-1'), message('rollback-2')], silent);
        throw new Error('domain step failed');
      }),
    ).rejects.toThrow('domain step failed');
    expect(await countDomain(tenantA)).toBe(before.domain);
    expect(await countOutbox(tenantA)).toBe(before.outbox);
    // The keys were never committed, so they are free again.
    await asTenant(tenantA, (tx) => withOutbox(tx, [message('rollback-1')], silent));
  });

  it('rolls back the outbox rows when the domain write fails after withOutbox', async () => {
    const before = await countOutbox(tenantA);
    const id = newId();
    await expect(
      asTenant(tenantA, async (tx) => {
        await withOutbox(tx, [message()], silent);
        // Duplicate primary key: the domain insert fails after the outbox insert.
        await tx.execute(sql`INSERT INTO outbox_probe_domain VALUES (${id}, ${tenantA})`);
        await tx.execute(sql`INSERT INTO outbox_probe_domain VALUES (${id}, ${tenantA})`);
      }),
    ).rejects.toThrow();
    expect(await countOutbox(tenantA)).toBe(before);
  });

  it('shares the caller transaction: the rows are invisible to other connections until commit', async () => {
    let seenInside = -1;
    let seenFromOutside = -1;
    await asTenant(tenantA, async (tx) => {
      await withOutbox(tx, [message('visibility')], silent);
      const inside = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = 'visibility'`,
      );
      seenInside = inside.rows[0]?.n ?? -1;
      seenFromOutside = await countOutbox(tenantA, "dedupe_key = 'visibility'");
    });
    expect(seenInside).toBe(1);
    expect(seenFromOutside).toBe(0);
    expect(await countOutbox(tenantA, "dedupe_key = 'visibility'")).toBe(1);
  });
});

describe('outbox: tenant context fails closed', () => {
  it('refuses to write without app.tenant_id, outside and inside a transaction', async () => {
    const before = await countOutbox(tenantA);
    await expect(
      withOutbox(app as unknown as TenantTx, [message()], silent),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(withoutTenant((tx) => withOutbox(tx, [message()], silent))).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    expect(await countOutbox(tenantA)).toBe(before);
  });

  it('refuses a context that a finished transaction left empty on the pooled connection', async () => {
    await asTenant(tenantA, (tx) => withOutbox(tx, [message()], silent));
    await expect(withoutTenant((tx) => withOutbox(tx, [message()], silent))).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('refuses a malformed tenant context', async () => {
    await expect(
      withoutTenant(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
        return withOutbox(tx, [message()], silent);
      }),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('rejects a raw insert that names another tenant (WITH CHECK)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO outbox (id, tenant_id, type, payload) VALUES ($1, $2, 'audit.event', '{}')`,
          [newId(), tenantB],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a raw read with no tenant context errors instead of returning rows', async () => {
    const code = await pgCode(db.appPool.query('SELECT * FROM outbox'));
    expect(['42704', '22P02']).toContain(code);
  });
});

describe('outbox: RLS isolation between tenants', () => {
  let rowA: string;

  beforeAll(async () => {
    [rowA = ''] = await asTenant(tenantA, (tx) => withOutbox(tx, [message('iso-a')], silent));
    await asTenant(tenantB, (tx) => withOutbox(tx, [message('iso-b')], silent));
  });

  it('is enabled, forced and has exactly the canonical tenant policy', async () => {
    await expect(assertRlsEnabled(db.ownerPool, 'outbox')).resolves.toBeUndefined();
  });

  it('hides tenant A rows from tenant B selects (and A can read them)', async () => {
    const result = await crossTenantDenied(
      (tenantId) =>
        db.withTenant(tenantId, (tx) => tx.query('SELECT * FROM outbox WHERE id = $1', [rowA])),
      { ownerTenantId: tenantA, otherTenantId: tenantB, subject: 'outbox row' },
    );
    expect(result.denial).toBe('empty');
  });

  it('shows each tenant only its own rows, including counts', async () => {
    for (const [tenant, other] of [
      [tenantA, tenantB],
      [tenantB, tenantA],
    ] as const) {
      const rows = await db.withTenant(tenant, (tx) => tx.query('SELECT tenant_id FROM outbox'));
      expect(rows.rows.length).toBeGreaterThan(0);
      expect((rows.rows as { tenant_id: string }[]).every((row) => row.tenant_id === tenant)).toBe(
        true,
      );
      expect(await countOutbox(other, `tenant_id = '${tenant}'`)).toBe(0);
    }
  });

  it('cannot update or delete another tenant row: zero rows affected', async () => {
    const updated = await db.withTenant(tenantB, (tx) =>
      tx.query("UPDATE outbox SET status = 'failed' WHERE id = $1", [rowA]),
    );
    const deleted = await db.withTenant(tenantB, (tx) =>
      tx.query('DELETE FROM outbox WHERE id = $1', [rowA]),
    );
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    expect(await countOutbox(tenantA, `id = '${rowA}' AND status = 'pending'`)).toBe(1);
  });

  it('applies to the table owner too (FORCE ROW LEVEL SECURITY)', async () => {
    const code = await pgCode(db.ownerPool.query('SELECT * FROM outbox'));
    expect(['42704', '22P02']).toContain(code);
  });
});

describe('outbox: dedupe key', () => {
  it('rejects a duplicate key within a tenant with OutboxDuplicateError and rolls the tx back', async () => {
    await asTenant(tenantA, (tx) => withOutbox(tx, [message('dup-1')], silent));
    const domainBefore = await countDomain(tenantA);
    const error = await asTenant(tenantA, async (tx) => {
      await insertDomain(tx, tenantA);
      await withOutbox(tx, [message('dup-1')], silent);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxDuplicateError);
    expect(error).toMatchObject({ code: 'CONFLICT', dedupeKey: 'dup-1' });
    expect(await countDomain(tenantA)).toBe(domainBefore);
    expect(await countOutbox(tenantA, "dedupe_key = 'dup-1'")).toBe(1);
  });

  it('is enforced by the unique index itself (raw SQL: 23505)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO outbox (id, tenant_id, type, payload, dedupe_key)
           VALUES ($1, $2, 'audit.event', '{}', 'dup-1')`,
          [newId(), tenantA],
        ),
      ),
    );
    expect(code).toBe('23505');
  });

  it('allows the same key for another tenant', async () => {
    await asTenant(tenantB, (tx) => withOutbox(tx, [message('dup-1')], silent));
    expect(await countOutbox(tenantB, "dedupe_key = 'dup-1'")).toBe(1);
  });

  it('never collides rows without a key', async () => {
    await asTenant(tenantA, (tx) => withOutbox(tx, [message(), message(), message()], silent));
    expect(await countOutbox(tenantA, 'dedupe_key IS NULL')).toBeGreaterThanOrEqual(3);
  });

  it('is a partial unique index on (tenant_id, dedupe_key) plus the relay index', async () => {
    const { rows } = await db.ownerPool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'outbox'",
    );
    const defs = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
    expect(defs.outbox_tenant_dedupe_key_idx).toMatch(
      /UNIQUE INDEX .*\(tenant_id, dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)/,
    );
    expect(defs.outbox_status_available_at_idx).toMatch(/\(status, available_at\)/);
  });
});

describe('outbox: row defaults and constraints', () => {
  it('takes available_at and created_at from the database clock', async () => {
    const [id = ''] = await asTenant(tenantA, (tx) => withOutbox(tx, [message()], silent));
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query(
        `SELECT available_at = created_at AS same, available_at <= now() AS not_future,
                dispatched_at IS NULL AS undispatched, last_error IS NULL AS no_error
           FROM outbox WHERE id = $1`,
        [id],
      ),
    );
    expect(rows[0]).toEqual({ same: true, not_future: true, undispatched: true, no_error: true });
  });

  it('bumps updated_at when the relay updates a row', async () => {
    const [id = ''] = await asTenant(tenantA, (tx) => withOutbox(tx, [message()], silent));
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query(
        `UPDATE outbox SET status = 'dispatched', dispatched_at = clock_timestamp(), attempts = attempts + 1
          WHERE id = $1 RETURNING updated_at > created_at AS bumped`,
        [id],
      ),
    );
    expect(rows[0]).toEqual({ bumped: true });
  });

  it.each([
    ['an unknown status', "UPDATE outbox SET status = 'bogus'"],
    ['a dispatched row without dispatched_at', "UPDATE outbox SET status = 'dispatched'"],
    ['negative attempts', 'UPDATE outbox SET attempts = -1'],
  ])('rejects %s (23514)', async (_label, statement) => {
    const [id = ''] = await asTenant(tenantA, (tx) => withOutbox(tx, [message()], silent));
    expect(
      await pgCode(db.withTenant(tenantA, (tx) => tx.query(`${statement} WHERE id = $1`, [id]))),
    ).toBe('23514');
  });

  it('rejects a raw insert with an unknown type or a non-object payload (23514)', async () => {
    for (const [type, payload] of [
      ['nope', '{}'],
      ['audit.event', '[1]'],
      ['audit.event', '"text"'],
    ] as const) {
      const code = await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('INSERT INTO outbox (id, tenant_id, type, payload) VALUES ($1, $2, $3, $4)', [
            newId(),
            tenantA,
            type,
            payload,
          ]),
        ),
      );
      expect(code).toBe('23514');
    }
  });
});

describe('outbox: payload cap', () => {
  const sized = (bytes: number, filler = 'x'): Record<string, unknown> => ({
    b: filler.repeat(bytes - 9),
  });
  const storedSize = async (id: string): Promise<number> => {
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT octet_length(payload::text) AS n FROM outbox WHERE id = $1', [id]),
    );
    return (rows[0] as { n: number }).n;
  };

  it('stores a payload of exactly 64 KiB and rejects one byte more (client and database)', async () => {
    const [id = ''] = await asTenant(tenantA, (tx) =>
      withOutbox(tx, [{ ...message(), payload: sized(OUTBOX_PAYLOAD_MAX_BYTES) as never }], silent),
    );
    expect(await storedSize(id)).toBe(OUTBOX_PAYLOAD_MAX_BYTES);

    const over = sized(OUTBOX_PAYLOAD_MAX_BYTES + 1);
    await expect(
      asTenant(tenantA, (tx) => withOutbox(tx, [{ ...message(), payload: over as never }], silent)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Bypassing the client check, the database constraint still holds.
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          'INSERT INTO outbox (id, tenant_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)',
          [newId(), tenantA, 'audit.event', JSON.stringify(over)],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('measures multi-byte text in bytes, not characters', async () => {
    const payload = sized(OUTBOX_PAYLOAD_MAX_BYTES - 1, 'é');
    const wide = { b: 'é'.repeat((OUTBOX_PAYLOAD_MAX_BYTES - 9) / 2) };
    expect(outboxPayloadBytes(wide)).toBeLessThanOrEqual(OUTBOX_PAYLOAD_MAX_BYTES);
    const [id = ''] = await asTenant(tenantA, (tx) =>
      withOutbox(tx, [{ ...message(), payload: wide }], silent),
    );
    expect(await storedSize(id)).toBe(outboxPayloadBytes(wide));
    expect(outboxPayloadBytes(payload)).toBeGreaterThan(OUTBOX_PAYLOAD_MAX_BYTES);
  });

  it('the client size estimate equals the jsonb text size, so an accepted payload always fits', async () => {
    const payloads = [
      { a: 1, b: [1, 2, { c: null, d: true }], e: 'text "quoted" \\ \n', f: {}, g: [] },
      { n: -3.5, m: 100, big: 12345678901234, unicode: '日本語 😀' },
      Object.fromEntries(Array.from({ length: 200 }, (_v, i) => [`key${String(i)}`, i])),
    ];
    for (const payload of payloads) {
      const [id = ''] = await asTenant(tenantA, (tx) =>
        withOutbox(tx, [{ ...message(), payload }], silent),
      );
      expect(await storedSize(id)).toBe(outboxPayloadBytes(payload));
    }
  });

  it('never under-counts numbers that Postgres expands from exponent form', async () => {
    const payload = { small: 1e-7, large: 1e21, tiny: 1.5e-300 };
    const [id = ''] = await asTenant(tenantA, (tx) =>
      withOutbox(tx, [{ ...message(), payload }], silent),
    );
    expect(outboxPayloadBytes(payload)).toBeGreaterThanOrEqual(await storedSize(id));
  });
});

describe('outbox: privileges', () => {
  it('lets bw_app do DML but not TRUNCATE; the operator role and PUBLIC get nothing', async () => {
    expect(await pgCode(db.appPool.query('TRUNCATE outbox'))).toBe('42501');
    const { rows: operator } = await db.ownerPool.query<{ privileges: boolean[] }>(
      `SELECT array_agg(has_table_privilege(role, 'outbox', privilege)) AS privileges
         FROM unnest(ARRAY['bw_operator']) AS role,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege`,
    );
    expect(operator[0]?.privileges.some(Boolean)).toBe(false);
    const { rows } = await db.ownerPool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'outbox' AND grantee <> 'bw_owner' ORDER BY privilege_type`,
    );
    expect(rows).toEqual(
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((privilege_type) => ({
        grantee: 'bw_app',
        privilege_type,
      })),
    );
  });
});
