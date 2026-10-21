// kill.rls: tenant isolation, fail-closed tenant context and constraints for the kill-switch tables
// (KILL-001, CONTEXT_PACK §7, §8.5, §8.6). Runs the real migrations against Postgres 16 (Testcontainers).

import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { killEventSchema, socContactSchema, socKillTokenSchema } from '@blackwing/contracts';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase, migrationNames } from './index.js';

const TABLES = ['kill_events', 'soc_contacts', 'soc_kill_tokens'] as const;

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const logged: { fields: Record<string, unknown>; message: string }[] = [];

const tokenHash = (): Buffer => createHash('sha256').update(randomBytes(32)).digest();

/** Postgres error code of a rejected promise (e.g. 23505 unique_violation, 42501 RLS / privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

async function insertKillEvent(
  tx: pg.PoolClient,
  tenantId: string | null,
  overrides: { scope?: string; scopeRefId?: string | null } = {},
): Promise<string> {
  const id = newId();
  const scope = overrides.scope ?? 'run';
  const scopeRefId = overrides.scopeRefId === undefined ? newId() : overrides.scopeRefId;
  await tx.query(
    `INSERT INTO kill_events (id, tenant_id, scope, scope_ref_id, source, actor_type, actor_ref, reason)
     VALUES ($1, $2, $3, $4, 'console', 'user', 'usr_test', 'stop the run')`,
    [id, tenantId, scope, scopeRefId],
  );
  return id;
}

async function insertContact(tx: pg.PoolClient, tenantId: string): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO soc_contacts (id, tenant_id, name, email) VALUES ($1, $2, 'SOC desk', 'SOC@Example.test')`,
    [id, tenantId],
  );
  return id;
}

async function insertToken(
  tx: pg.PoolClient,
  tenantId: string,
  options: { hash?: Buffer; contactId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO soc_kill_tokens (id, tenant_id, scope, scope_ref_id, token_sha256, contact_id, expires_at)
     VALUES ($1, $2, 'tenant', NULL, $3, $4, now() + interval '1 day')`,
    [id, tenantId, options.hash ?? tokenHash(), options.contactId ?? null],
  );
  return id;
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

type Table = (typeof TABLES)[number];
const ids = { a: {} as Record<Table, string>, b: {} as Record<Table, string> };

beforeAll(async () => {
  db = await withPostgres({
    migrations: (owner) =>
      migrateDatabase(owner, { info: (fields, message) => logged.push({ fields, message }) }),
  });
  for (const [key, tenant] of [
    ['a', tenantA],
    ['b', tenantB],
  ] as const) {
    await db.withTenant(tenant, async (tx) => {
      const contact = await insertContact(tx, tenant);
      ids[key] = {
        kill_events: await insertKillEvent(tx, tenant),
        soc_contacts: contact,
        soc_kill_tokens: await insertToken(tx, tenant, { contactId: contact }),
      };
    });
  }
});

afterAll(async () => {
  await db.stop();
});

describe('kill.rls migrations', () => {
  it('applies the forward-only migrations as the owner and logs their names', async () => {
    expect(migrationNames()).toEqual(['0000_extensions', '0001_kill_switch', '0002_column_mixins']);
    expect(logged.map((entry) => entry.message)).toEqual([
      'db.migrate.start',
      'db.migrate.applied',
      'db.migrate.applied',
      'db.migrate.applied',
      'db.migrate.done',
    ]);
    expect(
      logged.slice(1, 4).map((entry) => (entry.fields as { version: string }).version),
    ).toEqual(['0000_extensions', '0001_kill_switch', '0002_column_mixins']);
    const { rows } = await db.ownerPool.query<{
      relname: string;
      owner: string;
      rls: boolean;
      force: boolean;
    }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c WHERE c.relname = ANY($1) ORDER BY c.relname`,
      [TABLES],
    );
    expect(rows).toEqual(
      TABLES.map((relname) => ({ relname, owner: 'bw_owner', rls: true, force: true })),
    );
  });

  it('is idempotent: re-running records nothing new', async () => {
    const client = await db.ownerPool.connect();
    try {
      await migrateDatabase(client);
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*) FROM drizzle.__drizzle_migrations',
      );
      expect(rows[0]?.count).toBe('3');
    } finally {
      client.release();
    }
  });

  it('has the required indexes', async () => {
    const { rows } = await db.ownerPool.query<{ indexdef: string }>(
      'SELECT indexdef FROM pg_indexes WHERE tablename = ANY($1)',
      [TABLES],
    );
    const defs = rows.map((row) => row.indexdef).join('\n');
    expect(defs).toContain('kill_events USING btree (tenant_id, scope, scope_ref_id)');
    expect(defs).toContain('kill_events USING btree (tenant_id, triggered_at DESC NULLS LAST)');
    expect(defs).toContain('soc_kill_tokens USING btree (token_sha256)');
    expect(defs).toContain('soc_contacts USING btree (tenant_id, asset_id)');
  });
});

describe('kill.rls tenant isolation', () => {
  it.each(TABLES)('tenant A reads only its own %s rows', async (table) => {
    const rows = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM ${table}`))
          .rows,
    );
    expect(rows).toEqual([{ id: ids.a[table], tenant_id: tenantA }]);
  });

  it.each(TABLES)(
    'tenant A cannot read, update or delete tenant B %s rows by id',
    async (table) => {
      const target = ids.b[table];
      await db.withTenant(tenantA, async (tx) => {
        expect((await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [target])).rowCount).toBe(0);
        expect(
          (await tx.query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [target]))
            .rowCount,
        ).toBe(0);
      });
      const still = await db.withTenant(
        tenantB,
        async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [target])).rowCount,
      );
      expect(still).toBe(1);
    },
  );

  it.each(['soc_contacts', 'soc_kill_tokens'] as const)(
    'tenant A cannot delete tenant B %s rows (kill_events allows no DELETE at all)',
    async (table) => {
      const target = ids.b[table];
      const deleted = await db.withTenant(
        tenantA,
        async (tx) => (await tx.query(`DELETE FROM ${table} WHERE id = $1`, [target])).rowCount,
      );
      expect(deleted).toBe(0);
    },
  );

  it.each(TABLES)('tenant A cannot write a %s row for tenant B', async (table) => {
    const code = await pgCode(
      db.withTenant(tenantA, async (tx) => {
        if (table === 'kill_events') await insertKillEvent(tx, tenantB);
        else if (table === 'soc_contacts') await insertContact(tx, tenantB);
        else await insertToken(tx, tenantB);
      }),
    );
    expect(code).toBe('42501');
  });

  it.each(TABLES)('fails closed on %s without a tenant context', async (table) => {
    const client = await db.appPool.connect();
    try {
      // No SET LOCAL: current_setting() raises (42704 on a fresh session, 22P02 once a previous
      // transaction on this pooled connection defined and reset the setting to '').
      expect(['42704', '22P02']).toContain(await pgCode(client.query(`SELECT * FROM ${table}`)));
      // Set and reset by an earlier transaction on the same connection: '' is not a uuid.
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await client.query('COMMIT');
      expect(await pgCode(client.query(`SELECT * FROM ${table}`))).toBe('22P02');
    } finally {
      client.release();
    }
  });

  it('the app role cannot delete kill-ledger rows', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM kill_events WHERE id = $1', [ids.a.kill_events]),
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('kill.rls global kill events (operator path)', () => {
  it('the app role cannot insert a global event with no tenant', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        insertKillEvent(tx, null, { scope: 'global', scopeRefId: null }),
      ),
    );
    expect(code).toBe('42501');
  });

  it('the operator inserts and reads global events; tenants never see them', async () => {
    const globalId = await asOperator((client) =>
      insertKillEvent(client, null, { scope: 'global', scopeRefId: null }),
    );
    const operatorView = await asOperator(
      async (client) => (await client.query<{ id: string }>('SELECT id FROM kill_events')).rows,
    );
    // The operator policy reaches global rows only: no tenant rows.
    expect(operatorView).toEqual([{ id: globalId }]);
    for (const tenant of [tenantA, tenantB]) {
      const seen = await db.withTenant(
        tenant,
        async (tx) =>
          (await tx.query('SELECT 1 FROM kill_events WHERE id = $1', [globalId])).rowCount,
      );
      expect(seen).toBe(0);
    }
  });

  it('the operator cannot write tenant rows or non-global events', async () => {
    expect(await pgCode(asOperator((client) => insertKillEvent(client, tenantA)))).toBe('42501');
    expect(await pgCode(asOperator((client) => insertContact(client, tenantA)))).toBe('42501');
  });
});

describe('kill.rls constraints', () => {
  it('run and asset scopes require scope_ref_id; tenant and global scopes forbid it', async () => {
    for (const scope of ['run', 'asset']) {
      expect(
        await pgCode(
          db.withTenant(tenantA, (tx) => insertKillEvent(tx, tenantA, { scope, scopeRefId: null })),
        ),
      ).toBe('23514');
    }
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) => insertKillEvent(tx, tenantA, { scope: 'tenant' })),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          insertKillEvent(tx, tenantA, { scope: 'tenant', scopeRefId: null }),
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects unknown scope, source and status values', async () => {
    await db.withTenant(tenantA, async (tx) => {
      await tx.query('SAVEPOINT s');
      expect(
        await pgCode(insertKillEvent(tx, tenantA, { scope: 'planet', scopeRefId: null })),
      ).toBe('23514');
      await tx.query('ROLLBACK TO SAVEPOINT s');
      expect(
        await pgCode(
          tx.query("UPDATE kill_events SET status = 'paused' WHERE id = $1", [ids.a.kill_events]),
        ),
      ).toBe('23514');
      await tx.query('ROLLBACK TO SAVEPOINT s');
      expect(
        await pgCode(
          tx.query("UPDATE kill_events SET source = 'email' WHERE id = $1", [ids.a.kill_events]),
        ),
      ).toBe('23514');
      await tx.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  it('a SOC kill token may not carry the global scope', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO soc_kill_tokens (id, tenant_id, scope, token_sha256, expires_at)
           VALUES ($1, $2, 'global', $3, now() + interval '1 day')`,
          [newId(), tenantA, tokenHash()],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('rejects a duplicate token hash, also across tenants (the caller regenerates)', async () => {
    const hash = tokenHash();
    await db.withTenant(tenantA, (tx) => insertToken(tx, tenantA, { hash }));
    expect(await pgCode(db.withTenant(tenantA, (tx) => insertToken(tx, tenantA, { hash })))).toBe(
      '23505',
    );
    expect(await pgCode(db.withTenant(tenantB, (tx) => insertToken(tx, tenantB, { hash })))).toBe(
      '23505',
    );
  });

  it('stores only a 32-byte digest and keeps use_count within max_uses', async () => {
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          insertToken(tx, tenantA, { hash: Buffer.from('raw-token') }),
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query('UPDATE soc_kill_tokens SET use_count = max_uses + 1 WHERE id = $1', [
            ids.a.soc_kill_tokens,
          ]),
        ),
      ),
    ).toBe('23514');
  });

  it("a token cannot reference another tenant's SOC contact", async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => insertToken(tx, tenantA, { contactId: ids.b.soc_contacts })),
    );
    expect(code).toBe('23503');
  });

  it('times are server-generated: triggered_at defaults to now()', async () => {
    const row = await db.withTenant(tenantA, async (tx) => {
      const { rows } = await tx.query<{ skew_ms: number }>(
        `SELECT abs(extract(epoch FROM (triggered_at - now())) * 1000)::int AS skew_ms
           FROM kill_events WHERE id = $1`,
        [await insertKillEvent(tx, tenantA)],
      );
      return rows[0];
    });
    expect(row?.skew_ms).toBe(0);
  });
});

describe('kill.rls contract round-trip', () => {
  const iso = (value: unknown): string | null =>
    value instanceof Date ? value.toISOString() : null;

  it('rows read back through RLS parse with the Zod contracts', async () => {
    await db.withTenant(tenantA, async (tx) => {
      const [event] = (
        await tx.query('SELECT * FROM kill_events WHERE id = $1', [ids.a.kill_events])
      ).rows as Record<string, unknown>[];
      const [contact] = (
        await tx.query('SELECT * FROM soc_contacts WHERE id = $1', [ids.a.soc_contacts])
      ).rows as Record<string, unknown>[];
      const [token] = (
        await tx.query('SELECT * FROM soc_kill_tokens WHERE id = $1', [ids.a.soc_kill_tokens])
      ).rows as Record<string, unknown>[];
      if (!event || !contact || !token) throw new Error('fixture rows missing');

      const parsedEvent = killEventSchema.parse({
        id: event.id,
        tenantId: event.tenant_id,
        scope: event.scope,
        scopeRefId: event.scope_ref_id,
        source: event.source,
        actorType: event.actor_type,
        actorRef: event.actor_ref,
        reason: event.reason,
        status: event.status,
        triggeredAt: iso(event.triggered_at),
        egressBlockedAt: iso(event.egress_blocked_at),
        sandboxesTerminatedAt: iso(event.sandboxes_terminated_at),
        keysRevokedAt: iso(event.keys_revoked_at),
        workflowsCancelledAt: iso(event.workflows_cancelled_at),
        completedAt: iso(event.completed_at),
        haltMs: event.halt_ms,
        affected: event.affected,
        reenabledAt: iso(event.reenabled_at),
        reenabledBy: event.reenabled_by,
        createdAt: iso(event.created_at),
        updatedAt: iso(event.updated_at),
      });
      expect(parsedEvent.status).toBe('initiated');
      expect(parsedEvent.affected).toEqual({});

      const parsedContact = socContactSchema.parse({
        id: contact.id,
        tenantId: contact.tenant_id,
        assetId: contact.asset_id,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        notifyPrewindow: contact.notify_prewindow,
        notifyStart: contact.notify_start,
        notifyEnd: contact.notify_end,
        locale: contact.locale,
        status: contact.status,
        createdAt: iso(contact.created_at),
        updatedAt: iso(contact.updated_at),
      });
      expect(parsedContact).toMatchObject({ locale: 'en', status: 'active', notifyStart: true });

      const hash = token.token_sha256;
      const parsedToken = socKillTokenSchema.parse({
        id: token.id,
        tenantId: token.tenant_id,
        scope: token.scope,
        scopeRefId: token.scope_ref_id,
        tokenSha256: Buffer.isBuffer(hash) ? hash.toString('hex') : null,
        contactId: token.contact_id,
        expiresAt: iso(token.expires_at),
        maxUses: token.max_uses,
        useCount: token.use_count,
        lastUsedAt: iso(token.last_used_at),
        revokedAt: iso(token.revoked_at),
        createdAt: iso(token.created_at),
        updatedAt: iso(token.updated_at),
      });
      expect(parsedToken).toMatchObject({ maxUses: 1, useCount: 0, contactId: ids.a.soc_contacts });
    });
  });

  it('soc_contacts.email is case-insensitive (citext)', async () => {
    const count = await db.withTenant(
      tenantA,
      async (tx) =>
        (await tx.query("SELECT 1 FROM soc_contacts WHERE email = 'soc@example.TEST'")).rowCount,
    );
    expect(count).toBe(1);
  });
});
