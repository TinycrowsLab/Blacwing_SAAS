// sod: the DB half of separation of duties (#352, CONTEXT_PACK §8.4). The generator from @blackwing/domain/sod is
// applied to real tables on Postgres 16 (Testcontainers) and must reject a same-actor write even when service code is
// skipped (a direct write), which is the point of enforcing it in the database.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sodCheckConstraint, sodTrigger, SOD_SQLSTATE } from '@blackwing/domain/sod';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

let db: PostgresHandle;

/** Postgres error code of a rejected promise, or `undefined` when it resolved. */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

beforeAll(async () => {
  db = await withPostgres();
  const owner = db.ownerPool;
  // Three tables: constraint only, trigger only, and both (the shape AUTHZ-009 will generate for gate_decisions).
  await owner.query(`
    CREATE TABLE sod_probe_check (
      id uuid PRIMARY KEY, requester_id text NOT NULL, approver_id text
    );
    CREATE TABLE sod_probe_trigger (
      id uuid PRIMARY KEY, requester_id text NOT NULL, approver_id text
    );
    CREATE TABLE sod_probe_both (
      id uuid PRIMARY KEY, requester_id text NOT NULL, approver_id text
    );
  `);
  await owner.query(
    sodCheckConstraint({
      table: 'sod_probe_check',
      requesterCol: 'requester_id',
      approverCol: 'approver_id',
    }),
  );
  await owner.query(
    sodTrigger({
      table: 'sod_probe_trigger',
      requesterCol: 'requester_id',
      approverCol: 'approver_id',
    }),
  );
  await owner.query(
    sodCheckConstraint({
      table: 'sod_probe_both',
      requesterCol: 'requester_id',
      approverCol: 'approver_id',
    }),
  );
  await owner.query(
    sodTrigger({
      table: 'sod_probe_both',
      requesterCol: 'requester_id',
      approverCol: 'approver_id',
    }),
  );
});

afterAll(async () => {
  await db.stop();
});

const insert = (table: string, requester: string | null, approver: string | null) =>
  db.ownerPool.query(`INSERT INTO ${table} (id, requester_id, approver_id) VALUES ($1, $2, $3)`, [
    newId(),
    requester,
    approver,
  ]);

describe('generated CHECK constraint', () => {
  it('rejects a same-actor insert with check_violation (23514)', async () => {
    const user = newId();
    expect(await pgCode(insert('sod_probe_check', user, user))).toBe('23514');
  });

  it('accepts distinct actors and an undecided (NULL) approver', async () => {
    expect(await pgCode(insert('sod_probe_check', newId(), newId()))).toBeUndefined();
    expect(await pgCode(insert('sod_probe_check', newId(), null))).toBeUndefined();
  });

  it('rejects a same-actor update', async () => {
    const requester = newId();
    const id = newId();
    await db.ownerPool.query(
      'INSERT INTO sod_probe_check (id, requester_id, approver_id) VALUES ($1, $2, NULL)',
      [id, requester],
    );
    expect(
      await pgCode(
        db.ownerPool.query('UPDATE sod_probe_check SET approver_id = $2 WHERE id = $1', [
          id,
          requester,
        ]),
      ),
    ).toBe('23514');
  });
});

describe('generated trigger', () => {
  it(`raises SQLSTATE ${SOD_SQLSTATE} on a same-actor insert`, async () => {
    const user = newId();
    expect(await pgCode(insert('sod_probe_trigger', user, user))).toBe(SOD_SQLSTATE);
  });

  it('raises on a same-actor update', async () => {
    const requester = newId();
    const id = newId();
    await db.ownerPool.query(
      'INSERT INTO sod_probe_trigger (id, requester_id, approver_id) VALUES ($1, $2, NULL)',
      [id, requester],
    );
    expect(
      await pgCode(
        db.ownerPool.query('UPDATE sod_probe_trigger SET approver_id = $2 WHERE id = $1', [
          id,
          requester,
        ]),
      ),
    ).toBe(SOD_SQLSTATE);
  });

  it('raises on a NULL requester (fail closed)', async () => {
    expect(await pgCode(insert('sod_probe_trigger', null, newId()))).toBe(SOD_SQLSTATE);
  });

  it('accepts distinct actors and an undecided approver', async () => {
    expect(await pgCode(insert('sod_probe_trigger', newId(), newId()))).toBeUndefined();
    expect(await pgCode(insert('sod_probe_trigger', newId(), null))).toBeUndefined();
  });
});

describe('constraint and trigger together', () => {
  it('a direct write that skips service code is still refused', async () => {
    const user = newId();
    // The trigger runs first (BEFORE), so it is the one that reports; the constraint is the backstop.
    expect(await pgCode(insert('sod_probe_both', user, user))).toBe(SOD_SQLSTATE);
    expect(await pgCode(insert('sod_probe_both', newId(), newId()))).toBeUndefined();
  });
});
