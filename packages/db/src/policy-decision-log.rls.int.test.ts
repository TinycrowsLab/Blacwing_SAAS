// policy-decision-log.rls: append-only tenant decision rows, row-level isolation and the check constraints for the
// `policy_decision_logs` table (POLICY-004, CONTEXT_PACK §7, §8.6, §8.7). Runs the real migrations against
// Postgres 16 (Testcontainers) and goes through the app role, so RLS and the grants apply.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase } from './client.js';
import { migrateDatabase } from './index.js';
import {
  PolicyDecisionLogRepository,
  type PolicyDecisionLogRecord,
} from './policy-decision-log.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Postgres error code of a rejected promise (23514 check, 42501 insufficient privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function record(
  tenantId: string,
  overrides: Partial<PolicyDecisionLogRecord> = {},
): PolicyDecisionLogRecord {
  return {
    tenantId,
    runId: undefined,
    action: 'Egress::Action::httpRequest',
    decision: 'deny',
    determiningPolicyIds: ['baseline.destructive.egress'],
    errored: false,
    latencyMs: 3,
    contextDigest: sha('{"tenantId":"x"}'),
    nowUtc: '2026-10-20T12:00:00.000Z',
    ...overrides,
  };
}

const repo = () => new PolicyDecisionLogRepository({ db: createDatabase(db.appPool) });

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  await db.stop();
});

describe('policy decision logs (POLICY-004)', () => {
  it('appends a decision for its own tenant and lists it newest first, with the digest and no raw context', async () => {
    await repo().write(
      record(tenantA, { determiningPolicyIds: ['baseline.destructive.egress', 'tenant.x'] }),
    );
    await repo().write(record(tenantA, { decision: 'allow', errored: false, latencyMs: 1 }));

    const rows = await repo().listRecent(tenantA, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.decision).toBe('allow');
    expect(rows[1]?.determiningPolicyIds).toEqual(['baseline.destructive.egress', 'tenant.x']);
    expect(rows[1]?.contextDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(rows[1] ?? {})).not.toContain('context');
    expect(rows[1]?.nowUtc.toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('stores an errored deny and records the run id when one is given', async () => {
    const runId = newId();
    await repo().write(record(tenantA, { errored: true, runId }));
    const [latest] = await repo().listRecent(tenantA, 1);
    expect(latest).toMatchObject({ decision: 'deny', errored: true, runId });
  });

  it('refuses a row that violates the check constraints (bad decision, errored allow, bad digest, negative latency)', async () => {
    const insert = (values: {
      decision: string;
      errored: boolean;
      digest: string;
      latency: number;
    }) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO policy_decision_logs
             (id, tenant_id, action, decision, determining_policy_ids, errored, latency_ms, context_digest, now_utc)
           VALUES ($1, $2, 'a', $3, '{}', $4, $5, $6, now())`,
          [newId(), tenantA, values.decision, values.errored, values.latency, values.digest],
        ),
      );
    const good = { decision: 'deny', errored: false, digest: sha(''), latency: 0 };
    expect(await pgCode(insert({ ...good, decision: 'maybe' }))).toBe('23514');
    expect(await pgCode(insert({ ...good, decision: 'allow', errored: true }))).toBe('23514');
    expect(await pgCode(insert({ ...good, digest: 'not-a-digest' }))).toBe('23514');
    expect(await pgCode(insert({ ...good, latency: -1 }))).toBe('23514');
  });

  it('isolates tenants: another tenant lists none of this tenant decisions and cannot insert under this tenant id', async () => {
    expect(await repo().listRecent(tenantB, 10)).toEqual([]);
    const crossInsert = db.withTenant(tenantB, (tx) =>
      tx.query(
        `INSERT INTO policy_decision_logs
           (id, tenant_id, action, decision, determining_policy_ids, errored, latency_ms, context_digest, now_utc)
         VALUES ($1, $2, 'a', 'deny', '{}', false, 0, $3, now())`,
        [newId(), tenantA, sha('')],
      ),
    );
    expect(await pgCode(crossInsert)).toBe('42501');
  });

  it('refuses a write whose tenant id is not a valid id (fails closed before any SQL)', async () => {
    await expect(repo().write(record('not-a-uuid'))).rejects.toBeDefined();
  });

  it('FORCE row level security applies to the owner role too: it sees no rows of another tenant', async () => {
    const client = await db.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM policy_decision_logs WHERE tenant_id = $1',
        [tenantA],
      );
      expect(rows[0]?.n).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('fails closed without a tenant context', async () => {
    const code = await pgCode(db.appPool.query('SELECT count(*) FROM policy_decision_logs'));
    expect(code).toBeDefined();
    expect(code).not.toBe('not-a-database-error');
  });

  it('the app role cannot update or delete a decision (append-only)', async () => {
    const update = db.withTenant(tenantA, (tx) =>
      tx.query("UPDATE policy_decision_logs SET decision = 'allow'"),
    );
    const remove = db.withTenant(tenantA, (tx) => tx.query('DELETE FROM policy_decision_logs'));
    expect(await pgCode(update)).toBe('42501');
    expect(await pgCode(remove)).toBe('42501');
  });
});
