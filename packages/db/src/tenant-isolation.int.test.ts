// The cross-tenant isolation suite (TENANT-003, CONTEXT_PACK §8.6): RLS, fail-closed context, pool
// leakage and role limits, proven as bw_app against the REAL migrations on Postgres 16
// (Testcontainers). Run it with `pnpm test:isolation`; it is a required CI check.
//
// New tenant table? The coverage meta-test fails until the table is added to ISOLATION_TABLES with a
// row seeder. Pattern for other epics: docs/architecture/tenant-isolation-tests.md.

import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import {
  expectAllTenantTablesForceRls,
  expectAppRoleCannotBypass,
  expectEveryTenantTableCovered,
  expectFailsClosedWithoutContext,
  expectNoLeakAcrossTransactions,
  expectRlsBlocksCrossTenant,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

import type pg from 'pg';

type Seeder = (tx: pg.PoolClient, tenantId: string) => Promise<void>;

/** One valid row per tenant table. The key is the table name: this list is the coverage note. */
const ISOLATION_TABLES: Record<string, Seeder> = {
  audit_events: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, hash)
       VALUES ($1, $2, 1, now(), 'gate2.decided', 'notice', '{"type":"system"}', '{"type":"run","id":"r"}', 'success', $3)`,
      [newId(), tenantId, createHash('sha256').update(randomBytes(8)).digest()],
    );
  },
  gate_decisions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO gate_decisions (id, tenant_id, gate, subject_type, subject_id, decision, reason, auto)
       VALUES ($1, $2, 2, 'gate2_exception', $3, 'denied', 'no reply before the timeout', true)`,
      [newId(), tenantId, newId()],
    );
  },
  gate2_exceptions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO gate2_exceptions (id, tenant_id, run_id, session_id, tool_name, proposed_action,
         envelope_reason, intrusiveness, timeout_at, idempotency_key)
       VALUES ($1, $2, $3, 'sess-1', 'http.request', '{}', 'outside the envelope', 'state_changing',
         now() + interval '15 minutes', $4)`,
      [newId(), tenantId, newId(), newId()],
    );
  },
  kill_events: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO kill_events (id, tenant_id, scope, scope_ref_id, source, actor_type, actor_ref, reason)
       VALUES ($1, $2, 'run', $3, 'console', 'user', 'usr_test', 'stop the run')`,
      [newId(), tenantId, newId()],
    );
  },
  outbox: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO outbox (tenant_id, type, payload) VALUES ($1, 'audit.event', '{}')`,
      [tenantId],
    );
  },
  soc_contacts: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO soc_contacts (id, tenant_id, name, email) VALUES ($1, $2, 'SOC desk', 'soc@example.test')`,
      [newId(), tenantId],
    );
  },
  soc_kill_tokens: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO soc_kill_tokens (id, tenant_id, scope, scope_ref_id, token_sha256, expires_at)
       VALUES ($1, $2, 'tenant', NULL, $3, now() + interval '1 day')`,
      [newId(), tenantId, createHash('sha256').update(randomBytes(32)).digest()],
    );
  },
};

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  await db.stop();
});

describe('every tenant table', () => {
  it('is covered by this suite (a new tenant table without tests fails here)', async () => {
    await expect(
      expectEveryTenantTableCovered(db.ownerPool, Object.keys(ISOLATION_TABLES)),
    ).resolves.toBeInstanceOf(Array);
  });

  it('has RLS enabled and forced, with a policy', async () => {
    await expect(expectAllTenantTablesForceRls(db.ownerPool)).resolves.toBeInstanceOf(Array);
  });
});

describe.each(Object.entries(ISOLATION_TABLES))('%s', (table, insertRow) => {
  it('RLS blocks cross-tenant reads and writes', async () => {
    await expect(
      expectRlsBlocksCrossTenant(db.appPool, table, { tenantA, tenantB, insertRow }),
    ).resolves.toBeUndefined();
  });

  it('fails closed (raises) without a tenant context', async () => {
    await expect(expectFailsClosedWithoutContext(db.appPool, table)).resolves.toBeUndefined();
  });
});

describe('connections and roles', () => {
  it('a reused pooled connection never leaks tenant context', async () => {
    await expect(
      expectNoLeakAcrossTransactions(db.appPool, tenantA, tenantB),
    ).resolves.toBeUndefined();
  });

  it('bw_app cannot bypass RLS or run DDL', async () => {
    await expect(expectAppRoleCannotBypass(db.appPool)).resolves.toBeUndefined();
  });
});

/** The suite must fail when isolation regresses: break it on purpose and require a failure. */
describe('negative: the suite catches regressions', () => {
  const policy = (name: string, missingOk: string): string =>
    `CREATE POLICY ${name}_p ON ${name} FOR ALL USING (tenant_id = current_setting('app.tenant_id'${missingOk})::uuid)
       WITH CHECK (tenant_id = current_setting('app.tenant_id'${missingOk})::uuid)`;

  it('fails on the fail-open form current_setting(..., true)', async () => {
    await db.ownerPool.query('CREATE TABLE iso_open (id int, tenant_id uuid NOT NULL)');
    try {
      await db.ownerPool.query('ALTER TABLE iso_open ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(policy('iso_open', ', true'));
      await db.ownerPool.query('GRANT SELECT, DELETE ON iso_open TO bw_app');
      await expect(expectFailsClosedWithoutContext(db.appPool, 'iso_open')).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_open');
    }
  });

  it('fails on a tenant table without RLS, and on one without FORCE', async () => {
    await db.ownerPool.query('CREATE TABLE iso_bare (tenant_id uuid NOT NULL)');
    try {
      await expect(expectAllTenantTablesForceRls(db.ownerPool)).rejects.toThrow();
      await db.ownerPool.query('ALTER TABLE iso_bare ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(policy('iso_bare', ''));
      await expect(expectAllTenantTablesForceRls(db.ownerPool)).rejects.toThrow();
      await expect(
        expectEveryTenantTableCovered(db.ownerPool, Object.keys(ISOLATION_TABLES)),
      ).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_bare');
    }
  });

  it('fails when the policy has no WITH CHECK or is missing', async () => {
    await db.ownerPool.query('CREATE TABLE iso_nocheck (id int, tenant_id uuid NOT NULL)');
    try {
      await db.ownerPool.query('ALTER TABLE iso_nocheck ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(
        `CREATE POLICY p ON iso_nocheck FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
      );
      await db.ownerPool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON iso_nocheck TO bw_app');
      await db.ownerPool.query('ALTER POLICY p ON iso_nocheck WITH CHECK (true)');
      await expect(
        expectRlsBlocksCrossTenant(db.appPool, 'iso_nocheck', {
          tenantA,
          tenantB,
          insertRow: async (tx, tenantId) => {
            await tx.query('INSERT INTO iso_nocheck (id, tenant_id) VALUES (1, $1)', [tenantId]);
          },
        }),
      ).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_nocheck');
    }
  });
});
