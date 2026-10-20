// Reusing one Postgres container across withPostgres calls (dev opt-in) stays isolated: every call
// gets its own database, and the cluster-wide role bootstrap is idempotent. In CI reuse is forced off.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { readTestEnv } from './env.js';
import { withPostgres } from './postgres.js';

const MIGRATIONS = fileURLToPath(new URL('./__fixtures__/migrations/', import.meta.url));
const cache = mkdtempSync(path.join(tmpdir(), 'bw-pg-reuse-'));
const started = new Set<string>();

afterAll(async () => {
  const client = await getContainerRuntimeClient();
  for (const id of started) {
    const container = client.container.getById(id);
    await client.container.stop(container, { timeout: 0 }).catch(() => undefined);
    await client.container.remove(container, { removeVolumes: true }).catch(() => undefined);
  }
  rmSync(cache, { recursive: true, force: true });
});

describe('withPostgres with reuse', () => {
  it('shares the container but never the database', async () => {
    // A private cache dir gives this file its own derived credentials, hence its own container hash.
    vi.stubEnv('XDG_CACHE_HOME', cache);
    const [first, second] = await Promise.all([
      withPostgres({ migrations: MIGRATIONS, reuse: true }),
      withPostgres({ migrations: MIGRATIONS, reuse: true }),
    ]);
    started.add(first.containerId);
    started.add(second.containerId);
    try {
      expect(second.database).not.toBe(first.database);
      // Shared in dev; in CI reuse is forced off, so each call has its own container.
      expect(second.containerId === first.containerId).toBe(!readTestEnv().CI);
      const tenant = '01900000-0000-7000-8000-000000000001';
      await first.withTenant(tenant, (tx) =>
        tx.query("INSERT INTO rls_probe (tenant_id, body) VALUES ($1, 'first')", [tenant]),
      );
      const seen = await second.withTenant(tenant, (tx) => tx.query('SELECT body FROM rls_probe'));
      expect(seen.rows).toEqual([]);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
    // A reused server keeps running, but the earlier calls' databases are gone.
    const third = await withPostgres({ reuse: true });
    started.add(third.containerId);
    try {
      const { rows } = await third.ownerPool.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [[first.database, second.database]],
      );
      expect(rows).toEqual([]);
    } finally {
      await third.stop();
    }
  });
});
