// Reversal journal (REVERSAL-001): tenant isolation, fail-closed without a tenant context, the status enum and the
// size CHECKs, composite foreign keys, append-only grants, and the repository's create, read and status-update rules,
// against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { reversalJournalRepository } from './reversal-journal.repository.js';
import { type TenantTx, withTenant } from './with-tenant.js';

import type { ReversalJournalEntry } from '@blackwing/domain';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Waits past a millisecond so two writes never share an `updated_at` at millisecond precision. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const database = () => createDatabase(db.appPool);
const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
  withTenant(database(), tenantId, fn);

/** A run, a plan and a test case in one tenant (the journal's composite foreign keys need them). */
async function seedCase(tenantId: string): Promise<{ runId: string; caseId: string }> {
  const runId = newId();
  const planId = newId();
  const caseId = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [runId, tenantId]);
    await tx.query(
      'INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)',
      [planId, tenantId, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget, status, oracle)
       VALUES ($1, $2, $3, 'state_changing', 'journal case', '[{"host":"j.example.test"}]', '{"maxRequests":5}', 'proposed', null)`,
      [caseId, tenantId, planId],
    );
  });
  return { runId, caseId };
}

const createInput = (
  tenantId: string,
  runId: string,
  caseId: string,
  overrides: Record<string, unknown> = {},
) => ({
  tenantId,
  runId,
  testCaseId: caseId,
  action: 'create order',
  target: { kind: 'endpoint', ref: 'orders.create', method: 'POST', urlTemplate: '/orders/{id}' },
  undoInstructions: { type: 'delete_created_resource', params: { resourceId: 'ord_1' } },
  ...overrides,
});

/** Journals an entry in a tenant and returns it. */
async function journal(
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<ReversalJournalEntry> {
  const { runId, caseId } = await seedCase(tenantId);
  return inTenant(tenantId, (tx) =>
    reversalJournalRepository.create(tx, createInput(tenantId, runId, caseId, overrides)),
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('migration and schema', () => {
  it('creates the table with forced RLS, the tenant policy and the enum/size CHECKs', async () => {
    const rls = await db.withTenant(tenantA, (tx) =>
      tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'reversal_journal_entries'`,
      ),
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const checks = await db.withTenant(tenantA, (tx) =>
      tx.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'reversal_journal_entries'::regclass AND contype = 'c'`,
      ),
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'reversal_journal_entries_undo_status_check',
        'reversal_journal_entries_target_object_check',
        'reversal_journal_entries_undo_object_check',
      ]),
    );
  });
});

describe('create and read', () => {
  it('journals a pending entry with an rvj_ public id, and reads it back', async () => {
    const entry = await journal(tenantA);
    expect(entry).toMatchObject({
      undoStatus: 'pending',
      undoAttempts: 0,
      undoneAt: null,
      intrusivenessClass: 'state_changing',
      subtaskId: null,
      tenantId: tenantA,
    });
    expect(entry.publicId).toMatch(/^rvj_[0-9a-hjkmnp-tv-z]{26}$/);
    const found = await inTenant(tenantA, (tx) => reversalJournalRepository.getById(tx, entry.id));
    expect(found).toEqual(entry);
  });

  it('stores the action in NFC form', async () => {
    const entry = await journal(tenantA, { action: 'café order' });
    expect(entry.action).toBe('café order');
  });

  it('accepts an evidence reference in place of an oversized undo descriptor', async () => {
    const evidenceId = newId();
    const entry = await journal(tenantA, { undoInstructions: { evidenceId } });
    expect(entry.undoInstructions).toEqual({ evidenceId });
  });

  it('refuses a missing tenant and an oversized inline descriptor before any write', async () => {
    const { runId, caseId } = await seedCase(tenantA);
    const withoutTenant: Record<string, unknown> = createInput(tenantA, runId, caseId);
    delete withoutTenant.tenantId;
    await expect(
      inTenant(tenantA, (tx) => reversalJournalRepository.create(tx, withoutTenant)),
    ).rejects.toThrow(ValidationError);
    const big = createInput(tenantA, runId, caseId, {
      undoInstructions: { type: 'http_request', params: { blob: 'x'.repeat(17_000) } },
    });
    await expect(
      inTenant(tenantA, (tx) => reversalJournalRepository.create(tx, big)),
    ).rejects.toThrow(ValidationError);
  });

  it('fails closed without a tenant context', async () => {
    await expect(
      withTenant(database(), '', (tx) => reversalJournalRepository.getById(tx, newId())),
    ).rejects.toThrow(TenantContextMissingError);
  });

  it('lists a run oldest first, and filters by undo status', async () => {
    const { runId, caseId } = await seedCase(tenantA);
    const first = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.create(tx, createInput(tenantA, runId, caseId)),
    );
    await tick();
    const second = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.create(tx, createInput(tenantA, runId, caseId)),
    );
    await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, second.id, 'not_needed', {
        expectedUpdatedAt: second.updatedAt,
      }),
    );
    const all = await inTenant(tenantA, (tx) => reversalJournalRepository.listByRun(tx, runId));
    expect(all.map((e) => e.id)).toEqual([first.id, second.id]);
    const pending = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.listByRun(tx, runId, { status: 'pending' }),
    );
    expect(pending.map((e) => e.id)).toEqual([first.id]);
  });
});

describe('tenant isolation (RLS)', () => {
  it('a row of tenant A is invisible to tenant B: getById and listByRun', async () => {
    const entry = await journal(tenantA);
    const seen = await inTenant(tenantB, (tx) => reversalJournalRepository.getById(tx, entry.id));
    expect(seen).toBeNull();
    const runList = await inTenant(tenantB, (tx) =>
      reversalJournalRepository.listByRun(tx, entry.runId),
    );
    expect(runList).toEqual([]);
  });

  it("tenant B cannot update tenant A's entry", async () => {
    const entry = await journal(tenantA);
    await expect(
      inTenant(tenantB, (tx) =>
        reversalJournalRepository.setUndoStatus(tx, entry.id, 'undone', {
          expectedUpdatedAt: entry.updatedAt,
        }),
      ),
    ).rejects.toThrow(NotFoundError);
    const still = await inTenant(tenantA, (tx) => reversalJournalRepository.getById(tx, entry.id));
    expect(still?.undoStatus).toBe('pending');
  });

  it("tenant B cannot journal against tenant A's run or case (composite foreign keys)", async () => {
    const { runId, caseId } = await seedCase(tenantA);
    await expect(
      inTenant(tenantB, (tx) =>
        reversalJournalRepository.create(tx, createInput(tenantB, runId, caseId)),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a write that names another tenant than the transaction (RLS WITH CHECK)', async () => {
    const { runId, caseId } = await seedCase(tenantA);
    await expect(
      inTenant(tenantB, (tx) =>
        reversalJournalRepository.create(tx, createInput(tenantA, runId, caseId)),
      ),
    ).rejects.toThrow();
  });

  it('a raw insert with no tenant context fails closed (no tenant GUC set)', async () => {
    const id = newId();
    const code = await pgCode(
      db.appPool.query(
        `INSERT INTO reversal_journal_entries (id, public_id, tenant_id, run_id, test_case_id, action, target, undo_instructions)
         VALUES ($1, $2, $3, $4, $5, 'x', '{"kind":"record","ref":"x"}', '{"type":"restore_field","params":{}}')`,
        [id, `rvj_${id.replaceAll('-', '')}`, tenantA, newId(), newId()],
      ),
    );
    expect(code).toBeDefined();
  });
});

describe('database constraints', () => {
  it('rejects an unknown undo_status (enum CHECK, 23514)', async () => {
    const entry = await journal(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE reversal_journal_entries SET undo_status = 'reverted' WHERE id = $1`, [
          entry.id,
        ]),
      ),
    );
    expect(code).toBe('23514');
  });

  it('rejects an inline target above 16 KiB (size CHECK, 23514)', async () => {
    const { runId, caseId } = await seedCase(tenantA);
    const id = newId();
    const huge = JSON.stringify({ kind: 'resource', ref: 'x'.repeat(17_000) });
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO reversal_journal_entries (id, public_id, tenant_id, run_id, test_case_id, action, target, undo_instructions)
           VALUES ($1, $2, $3, $4, $5, 'x', $6, '{"type":"restore_field","params":{}}')`,
          [id, `rvj_${id.replaceAll('-', '')}`, tenantA, runId, caseId, huge],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('rejects a non-state_changing intrusiveness class and a negative attempt count', async () => {
    const entry = await journal(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(
            `UPDATE reversal_journal_entries SET intrusiveness_class = 'passive' WHERE id = $1`,
            [entry.id],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE reversal_journal_entries SET undo_attempts = -1 WHERE id = $1`, [
            entry.id,
          ]),
        ),
      ),
    ).toBe('23514');
  });

  it('the runtime role cannot delete a journal entry (append-only closure)', async () => {
    const entry = await journal(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`DELETE FROM reversal_journal_entries WHERE id = $1`, [entry.id]),
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('setUndoStatus', () => {
  it('moves pending to failed, then failed to undone: attempts count, undone_at is stamped', async () => {
    const entry = await journal(tenantA);
    const failed = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'failed', {
        expectedUpdatedAt: entry.updatedAt,
      }),
    );
    expect(failed).toMatchObject({ undoStatus: 'failed', undoAttempts: 1, undoneAt: null });
    await tick();
    const undone = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'undone', {
        expectedUpdatedAt: failed.updatedAt,
      }),
    );
    expect(undone).toMatchObject({ undoStatus: 'undone', undoAttempts: 2 });
    expect(undone.undoneAt).not.toBeNull();
    expect(undone.updatedAt > failed.updatedAt).toBe(true);
  });

  it('refuses an illegal move with a typed ConflictError and leaves the row as it was', async () => {
    const entry = await journal(tenantA);
    const undone = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'undone', {
        expectedUpdatedAt: entry.updatedAt,
      }),
    );
    await tick();
    await expect(
      inTenant(tenantA, (tx) =>
        reversalJournalRepository.setUndoStatus(tx, entry.id, 'pending', {
          expectedUpdatedAt: undone.updatedAt,
        }),
      ),
    ).rejects.toThrow(ConflictError);
    const after = await inTenant(tenantA, (tx) => reversalJournalRepository.getById(tx, entry.id));
    expect(after?.undoStatus).toBe('undone');
  });

  it('a stale writer cannot overwrite a newer status (optimistic guard on updated_at)', async () => {
    const entry = await journal(tenantA);
    // Two writers both read the entry at the same version.
    await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'failed', {
        expectedUpdatedAt: entry.updatedAt,
      }),
    );
    await tick();
    await expect(
      inTenant(tenantA, (tx) =>
        reversalJournalRepository.setUndoStatus(tx, entry.id, 'undone', {
          expectedUpdatedAt: entry.updatedAt,
        }),
      ),
    ).rejects.toThrow(PreconditionFailedError);
    const after = await inTenant(tenantA, (tx) => reversalJournalRepository.getById(tx, entry.id));
    expect(after?.undoStatus).toBe('failed');
  });

  it('refuses an unknown status and a missing entry', async () => {
    const entry = await journal(tenantA);
    await expect(
      inTenant(tenantA, (tx) =>
        reversalJournalRepository.setUndoStatus(tx, entry.id, 'reverted', {
          expectedUpdatedAt: entry.updatedAt,
        }),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      inTenant(tenantA, (tx) =>
        reversalJournalRepository.setUndoStatus(tx, newId(), 'undone', {
          expectedUpdatedAt: entry.updatedAt,
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('a failed undo may be retried back to pending', async () => {
    const entry = await journal(tenantA);
    const failed = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'failed', {
        expectedUpdatedAt: entry.updatedAt,
      }),
    );
    await tick();
    const retry = await inTenant(tenantA, (tx) =>
      reversalJournalRepository.setUndoStatus(tx, entry.id, 'pending', {
        expectedUpdatedAt: failed.updatedAt,
      }),
    );
    expect(retry).toMatchObject({ undoStatus: 'pending', undoAttempts: 1, undoneAt: null });
  });
});
