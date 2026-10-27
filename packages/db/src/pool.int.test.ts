// DB-001: the two-role model against Postgres 16 (Testcontainers). The runtime role is a plain RLS
// subject: it cannot assume the owner, alter tables, switch RLS off or bypass it (CONTEXT_PACK §7, §8.6).

import net from 'node:net';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { type AppDatabase, createAppDatabase, type Tx, verifyAppRole } from './client.js';
import { migrateDatabase } from './migrate.js';
import { createOwnerPool } from './owner.js';
import { DbUnavailableError, type DbLogger } from './pool.js';

let handle: PostgresHandle;
let app: AppDatabase;
const lines: { fields: unknown; message: string }[] = [];
const logger = {
  info: (fields: unknown, message: string) => lines.push({ fields, message }),
  warn: (fields: unknown, message: string) => lines.push({ fields, message }),
  error: (fields: unknown, message: string) => lines.push({ fields, message }),
} as unknown as DbLogger;

function envFor(role: 'app' | 'owner', extra: Record<string, string> = {}): Record<string, string> {
  const config = handle.connectionConfig(role);
  const password = typeof config.password === 'string' ? config.password : '';
  return {
    NODE_ENV: 'test',
    PGHOST: config.host ?? '',
    PGPORT: String(config.port),
    PGDATABASE: config.database ?? '',
    ...(role === 'app'
      ? { PG_APP_USER: config.user ?? '', PG_APP_PASSWORD: password }
      : { PG_OWNER_USER: config.user ?? '', PG_OWNER_PASSWORD: password }),
    ...extra,
  };
}

async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : String(error);
  }
  return undefined;
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  app = createAppDatabase({ source: envFor('app'), logger });
}, 180_000);

afterAll(async () => {
  await (app as AppDatabase | undefined)?.close();
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (handle as PostgresHandle | undefined)?.stop();
});

describe('app role (bw_app)', () => {
  it('has no BYPASSRLS and is not a superuser', async () => {
    const { rows } = await app.pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'bw_app'",
    );
    expect(rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    await expect(verifyAppRole(app.pool)).resolves.toBeUndefined();
  });

  it('cannot SET ROLE to the owner or the platform operator', async () => {
    for (const role of ['bw_owner', 'bw_operator', 'postgres']) {
      const client = await app.pool.connect();
      try {
        expect(await pgCode(client.query(`SET ROLE ${role}`))).toBe('42501');
      } finally {
        client.release();
      }
    }
  });

  it('cannot alter tables, switch RLS off, create objects or bypass RLS', async () => {
    const denied = [
      'ALTER TABLE kill_events DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE kill_events NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE kill_events ADD COLUMN x int',
      'DROP POLICY IF EXISTS kill_events_tenant_isolation ON kill_events',
      'CREATE TABLE bw_app_owned (id int)',
    ];
    for (const statement of denied) {
      expect(await pgCode(app.pool.query(statement)), statement).toBe('42501');
    }
    const client = await app.pool.connect();
    try {
      // With row_security off, a non-BYPASSRLS role gets an error instead of unfiltered rows.
      await client.query('SET row_security = off');
      expect(await pgCode(client.query('SELECT count(*) FROM kill_events'))).toBe('42501');
    } finally {
      client.release(true);
    }
  });

  it('runs Drizzle queries and transactions as bw_app with the pinned search_path', async () => {
    const result = await app.db.execute<{ user: string; search_path: string }>(
      sql`SELECT current_user AS user, current_setting('search_path') AS search_path`,
    );
    expect(result.rows).toEqual([{ user: 'bw_app', search_path: 'public' }]);
    const inTx = await app.db.transaction(async (tx: Tx) => {
      const rows = await tx.execute<{ n: number }>(sql`SELECT 1 AS n`);
      return rows.rows[0]?.n;
    });
    expect(inTx).toBe(1);
  });

  it('pingDb reports ok', async () => {
    await expect(app.ping()).resolves.toMatchObject({ ok: true });
  });

  it('verifyAppRole refuses the owner connection (fails closed)', async () => {
    const owner = createOwnerPool({ source: envFor('owner'), logger });
    try {
      await expect(verifyAppRole(owner)).rejects.toMatchObject({ code: 'DB_ROLE_UNSAFE' });
      const { rows } = await owner.query<{ user: string }>('SELECT current_user AS user');
      expect(rows[0]?.user).toBe('bw_owner');
    } finally {
      await owner.end();
    }
  });
});

describe('pool behaviour', () => {
  it('queues on exhaustion and fails waiters with pool_exhausted after the acquire timeout', async () => {
    const small = createAppDatabase({
      source: envFor('app', { PG_POOL_MAX: '1', PG_ACQUIRE_TIMEOUT: '200ms' }),
      logger,
    });
    try {
      const held = await small.pool.connect();
      const queued = small.pool.query('SELECT 1').catch((e: unknown) => e);
      const error = await queued;
      expect(error).toBeInstanceOf(DbUnavailableError);
      expect(error).toMatchObject({ reason: 'pool_exhausted', code: 'DB_UNAVAILABLE' });
      expect(lines.some((line) => line.message === 'db.pool.exhausted')).toBe(true);
      // A waiter that arrives while the client is released in time is served.
      const late = small.pool.query('SELECT 1');
      held.release();
      await expect(late).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await small.close();
    }
  });

  it('reports unhealthy while the connection is lost and recovers by itself', async () => {
    // A TCP relay between the pool and Postgres that can drop every connection.
    const sockets = new Set<net.Socket>();
    let accepting = true;
    const relay = net.createServer((inbound) => {
      if (!accepting) {
        inbound.destroy();
        return;
      }
      const outbound = net.connect(handle.port, handle.host);
      for (const s of [inbound, outbound]) {
        sockets.add(s);
        s.on('error', () => undefined);
        s.on('close', () => sockets.delete(s));
      }
      inbound.pipe(outbound).pipe(inbound);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    if (address === null || typeof address === 'string') throw new Error('no relay port');
    const viaRelay = createAppDatabase({
      source: envFor('app', { PGHOST: '127.0.0.1', PGPORT: String(address.port) }),
      logger,
    });
    try {
      await expect(viaRelay.ping()).resolves.toMatchObject({ ok: true });
      accepting = false;
      for (const s of sockets) s.destroy();
      await expect(viaRelay.ping(500)).resolves.toMatchObject({ ok: false });
      accepting = true;
      await expect(viaRelay.ping()).resolves.toMatchObject({ ok: true });
      expect(JSON.stringify(lines)).not.toContain(envFor('app').PG_APP_PASSWORD);
    } finally {
      await viaRelay.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) =>
        relay.close(() => {
          resolve();
        }),
      );
    }
  });
});
