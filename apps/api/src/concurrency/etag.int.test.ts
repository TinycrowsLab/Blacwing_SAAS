// Optimistic concurrency against real Postgres (API-007, #59): a real version bump decides the race.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { type Widget, type WidgetRepo, widgetsModule } from './fixtures.test-helpers.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let postgres: PostgresHandle;
let pool: pg.Pool;
let app: NestFastifyApplication;

class PgWidgetRepo implements WidgetRepo {
  constructor(private readonly db: pg.Pool) {}

  async get(id: string): Promise<Widget | null> {
    const res = await this.db.query<Widget>(
      'SELECT id, name, state_version FROM etag_widgets WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateName(id: string, expectedVersion: number, name: string): Promise<Widget | null> {
    const res = await this.db.query<Widget>(
      'UPDATE etag_widgets SET name = $1, state_version = state_version + 1 WHERE id = $2 AND state_version = $3 RETURNING id, name, state_version',
      [name, id, expectedVersion],
    );
    return res.rows[0] ?? null;
  }

  async delete(id: string, expectedVersion: number): Promise<boolean> {
    const res = await this.db.query(
      'DELETE FROM etag_widgets WHERE id = $1 AND state_version = $2',
      [id, expectedVersion],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

beforeAll(async () => {
  postgres = await withPostgres();
  const owner = new pg.Pool(postgres.connectionConfig('owner'));
  await owner.query(
    'CREATE TABLE etag_widgets (id text PRIMARY KEY, name text NOT NULL, state_version integer NOT NULL DEFAULT 1)',
  );
  await owner.query("INSERT INTO etag_widgets (id, name) VALUES ('w', 'start')");
  await owner.query('GRANT SELECT, UPDATE, DELETE ON etag_widgets TO bw_app');
  await owner.end();
  pool = new pg.Pool(postgres.connectionConfig('app'));
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    imports: [widgetsModule(new PgWidgetRepo(pool))],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  await postgres.stop();
});

describe('concurrent PATCH against Postgres', () => {
  it('exactly one of N racing writers wins; the losers get 412', async () => {
    const etag = (await app.inject({ method: 'GET', url: '/v1/widgets/w' })).headers.etag;
    expect(etag).toBe('"v1"');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: 'PATCH',
          url: '/v1/widgets/w',
          headers: { 'if-match': String(etag) },
          payload: { name: `writer-${String(i)}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 412)).toHaveLength(9);
    const row = await pool.query<{ state_version: number }>(
      "SELECT state_version FROM etag_widgets WHERE id = 'w'",
    );
    expect(row.rows[0]?.state_version).toBe(2);
  });
});
