// policy-snapshot.rls: tenant isolation, immutability, the object-key binding and the audit-in-transaction rule for
// the `policy_snapshots` table (POLICY-007, CONTEXT_PACK §7, §8.6, §8.8, §8.9). Runs the real migrations against
// Postgres 16 (Testcontainers) and goes through the app role, so RLS and the grants apply.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from './client.js';
import { migrateDatabase } from './index.js';
import {
  type PolicySnapshotAuditEvent,
  PolicySnapshotRepository,
  type PolicySnapshotRecordInput,
} from './policy-snapshot.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Postgres error code of a rejected promise (23514 check, 42501 insufficient privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    // Drizzle and the transaction wrapper add layers; walk the `cause` chain to the driver error.
    for (let link: unknown = error; link !== undefined; link = (link as Error).cause) {
      if (link instanceof pg.DatabaseError) return link.code;
    }
    return 'not-a-database-error';
  }
  return undefined;
}

const events: PolicySnapshotAuditEvent[] = [];
let sequence = 0;
const repo = (audit: (event: PolicySnapshotAuditEvent) => void = (e) => events.push(e)) =>
  new PolicySnapshotRepository({ db: createDatabase(db.appPool), audit });

function record(
  tenantId: string,
  overrides: Partial<PolicySnapshotRecordInput> = {},
): PolicySnapshotRecordInput {
  sequence += 1;
  const snapshotSha256 = sha(`${tenantId}:${String(sequence)}`);
  return {
    tenantId,
    snapshotSha256,
    signingKeyId: 'bw-sa-signing:v1',
    baselineVersion: '1.0.0',
    tenantPolicyVersion: 2,
    objectKey: `t/${tenantId}/policy-snapshots/${snapshotSha256}.jws`,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  await db.stop();
});

describe('policy snapshots (POLICY-007)', () => {
  it('records a snapshot, audits it in the same transaction and reads the tenant current one back', async () => {
    const input = record(tenantA);
    await repo().insert(input);

    expect(events).toContainEqual({
      action: 'policy.snapshot.built',
      tenantId: tenantA,
      snapshotSha256: input.snapshotSha256,
      signingKeyId: 'bw-sa-signing:v1',
      baselineVersion: '1.0.0',
      tenantPolicyVersion: 2,
    });
    const current = await repo().latestForTenant(tenantA);
    expect(current).toMatchObject({
      tenantId: tenantA,
      snapshotSha256: input.snapshotSha256,
      objectKey: input.objectKey,
      tenantPolicyVersion: 2,
    });
  });

  it('makes the newest snapshot the current one, and keeps the older row', async () => {
    const older = record(tenantA);
    const newer = record(tenantA, { tenantPolicyVersion: 3 });
    await repo().insert(older);
    await repo().insert(newer);
    expect((await repo().latestForTenant(tenantA))?.snapshotSha256).toBe(newer.snapshotSha256);
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.query<{ n: string }>(`SELECT count(*) AS n FROM policy_snapshots`),
    );
    expect(Number(rows.rows[0]?.n)).toBeGreaterThanOrEqual(3);
  });

  it('records a baseline-only snapshot with a null tenant policy version', async () => {
    await repo().insert(record(tenantB, { tenantPolicyVersion: null }));
    expect((await repo().latestForTenant(tenantB))?.tenantPolicyVersion).toBeNull();
  });

  it('isolates tenants: another tenant reads none of this tenant snapshots and cannot write under this tenant id', async () => {
    const otherTenant = newId();
    expect(await repo().latestForTenant(otherTenant)).toBeUndefined();
    const crossInsert = db.withTenant(tenantB, (tx) =>
      tx.query(
        `INSERT INTO policy_snapshots (id, tenant_id, snapshot_sha256, signing_key_id, baseline_version, object_key)
         VALUES ($1, $2, $3, 'bw-sa-signing:v1', '1.0.0', $4)`,
        [newId(), tenantA, sha('cross'), `t/${tenantA}/policy-snapshots/cross.jws`],
      ),
    );
    expect(await pgCode(crossInsert)).toBe('42501');
  });

  it('refuses an object key under another tenant prefix (23514)', async () => {
    const bad = record(tenantA, { objectKey: `t/${tenantB}/policy-snapshots/x.jws` });
    expect(await pgCode(repo().insert(bad))).toBe('23514');
  });

  it('refuses a snapshot digest that is not 64 lowercase hex characters, and a non-positive policy version', async () => {
    const insert = (values: { sha: string; version: number }) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO policy_snapshots (id, tenant_id, snapshot_sha256, signing_key_id, baseline_version, tenant_policy_version, object_key)
           VALUES ($1, $2, $3, 'bw-sa-signing:v1', '1.0.0', $4, $5)`,
          [newId(), tenantA, values.sha, values.version, `t/${tenantA}/policy-snapshots/z.jws`],
        ),
      );
    expect(await pgCode(insert({ sha: 'NOT-A-DIGEST', version: 1 }))).toBe('23514');
    expect(await pgCode(insert({ sha: sha('z').toUpperCase(), version: 1 }))).toBe('23514');
    expect(await pgCode(insert({ sha: sha('z'), version: 0 }))).toBe('23514');
  });

  it('is immutable for the app role: no update, no delete, no truncate', async () => {
    const row = await repo().latestForTenant(tenantA);
    expect(row).toBeDefined();
    // Lazy: each statement starts only when awaited, so no rejection is left unhandled.
    const update = () =>
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE policy_snapshots SET signing_key_id = 'forged' WHERE id = $1`, [row?.id]),
      );
    const remove = () =>
      db.withTenant(tenantA, (tx) =>
        tx.query(`DELETE FROM policy_snapshots WHERE id = $1`, [row?.id]),
      );
    const truncate = () => db.withTenant(tenantA, (tx) => tx.query(`TRUNCATE policy_snapshots`));
    expect(await pgCode(update())).toBe('42501');
    expect(await pgCode(remove())).toBe('42501');
    expect(await pgCode(truncate())).toBe('42501');
  });

  it('records nothing when the audit hook fails: the row and its audit event are one unit', async () => {
    const before = (await repo().latestForTenant(tenantA))?.id;
    const failing = repo(() => {
      throw new Error('audit ledger unavailable');
    });
    await expect(failing.insert(record(tenantA, { tenantPolicyVersion: 9 }))).rejects.toThrow(
      'audit ledger unavailable',
    );
    expect((await repo().latestForTenant(tenantA))?.id).toBe(before);
  });
});
