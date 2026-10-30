// Input-manifest uploads (SCOPE-006): the upload repository only reads and writes the manifests of the tenant of its
// transaction, against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { InputManifestRepository } from './input-manifest.repository.js';

let db: PostgresHandle;
let repo: InputManifestRepository;
const tenantA = newId();
const tenantB = newId();
const manifestA = newId();
const manifestB = newId();

const spec = {
  uploadId: newId(),
  kind: 'openapi',
  objectKey: `inputs/${tenantA}/${manifestA}/x-api.json`,
  sha256: 'c'.repeat(64),
  sizeBytes: 20,
  contentType: 'application/json',
  status: 'uploaded_pending_scan',
};

/** Reads `spec_objects` of a manifest as the given tenant, bypassing the repository. */
async function specObjectsOf(tenantId: string, manifestId: string): Promise<unknown[] | undefined> {
  return db.withTenant(tenantId, async (tx) => {
    const result = await tx.query<{ spec_objects: unknown[] }>(
      'SELECT spec_objects FROM input_manifests WHERE id = $1',
      [manifestId],
    );
    return result.rows[0]?.spec_objects;
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  repo = new InputManifestRepository(createDatabase(db.appPool));
  for (const [tenantId, manifestId] of [
    [tenantA, manifestA],
    [tenantB, manifestB],
  ] as const) {
    await db.withTenant(tenantId, (tx) =>
      tx.query('INSERT INTO input_manifests (id, tenant_id) VALUES ($1, $2)', [
        manifestId,
        tenantId,
      ]),
    );
  }
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('InputManifestRepository (SCOPE-006, tenant isolation)', () => {
  it('locks and reads a manifest of its own tenant', async () => {
    const row = await repo.transact(tenantA, (tx) => repo.lockById(tx, manifestA));
    expect(row).toMatchObject({ id: manifestA, tenantId: tenantA, specObjects: [] });
  });

  it('reads another tenant manifest as absent', async () => {
    const row = await repo.transact(tenantA, (tx) => repo.lockById(tx, manifestB));
    expect(row).toBeUndefined();
  });

  it('writes spec objects to its own manifest', async () => {
    await repo.transact(tenantA, async (tx) => {
      await repo.lockById(tx, manifestA);
      await repo.setSpecObjects(tx, manifestA, [spec]);
    });
    expect(await specObjectsOf(tenantA, manifestA)).toEqual([spec]);
  });

  it('cannot write to another tenant manifest: the write touches nothing', async () => {
    await repo.transact(tenantA, (tx) => repo.setSpecObjects(tx, manifestB, [spec]));
    expect(await specObjectsOf(tenantB, manifestB)).toEqual([]);
  });

  it('refuses to run outside a tenant context (fails closed)', async () => {
    await expect(repo.transact('', (tx) => repo.lockById(tx, manifestA))).rejects.toThrow();
  });
});
