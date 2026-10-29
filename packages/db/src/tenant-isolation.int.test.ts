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

import { publicId } from './columns.js';
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
  assessment_requests: async (tx, tenantId) => {
    const id = newId();
    await tx.query(
      `INSERT INTO assessment_requests (id, tenant_id, public_id, mode, objective, asset_ids, max_intrusiveness, budgets, trigger, requested_by)
       VALUES ($1, $2, $3, 'black', 'iso objective', '{}', 'passive', '{}', 'console', $4)`,
      [id, tenantId, `areq_${id.replaceAll('-', '')}`, newId()],
    );
  },
  input_manifests: async (tx, tenantId) => {
    await tx.query(`INSERT INTO input_manifests (id, tenant_id) VALUES ($1, $2)`, [
      newId(),
      tenantId,
    ]);
  },
  persona_overrides: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO persona_overrides (tenant_id, persona, max_turns) VALUES ($1, 'osint', 5)`,
      [tenantId],
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
  secrets: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO secrets (id, tenant_id, name, envelope) VALUES ($1, $2, 'iso-secret', '{"ct":"x"}')`,
      [newId(), tenantId],
    );
  },
  secret_versions: async (tx, tenantId) => {
    const secretId = newId();
    await tx.query(
      `INSERT INTO secrets (id, tenant_id, name, envelope) VALUES ($1, $2, 'iso-versioned', '{"ct":"x"}')`,
      [secretId, tenantId],
    );
    await tx.query(
      `INSERT INTO secret_versions (tenant_id, secret_id, version, envelope) VALUES ($1, $2, 1, '{"ct":"x"}')`,
      [tenantId, secretId],
    );
  },
  memberships: async (tx, tenantId) => {
    // The membership's parent is the tenant row itself (FK), and `tenants` is RLS-keyed on its id, so
    // the row is inserted under its own tenant context (a foreign tenant id is refused by RLS).
    await tx.query(
      `INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'Isolation tenant', 'eu')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, `iso-${tenantId.replaceAll('-', '')}`],
    );
    // memberships references the global users table, so each row gets its own user (no RLS on users).
    const userId = newId();
    await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
      userId,
      `iso-${userId}`,
      `iso-${userId}@example.test`,
    ]);
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{admin}')`,
      [tenantId, userId],
    );
  },
  assets: async (tx, tenantId) => {
    await insertAsset(tx, tenantId);
  },
  asset_credentials: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
       VALUES ($1, $2, $3, 'customer', 'openbao://secret/data/tenants/iso/customer', '{}'::jsonb, 'none')`,
      [newId(), tenantId, assetId],
    );
  },
  role_matrices: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix, active)
       VALUES ($1, $2, $3, 1, '{}'::jsonb, true)`,
      [newId(), tenantId, assetId],
    );
  },
  asset_tags: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO asset_tags (tenant_id, asset_id, key, value) VALUES ($1, $2, 'env', 'iso')`,
      [tenantId, assetId],
    );
  },
  asset_groups: async (tx, tenantId) => {
    await tx.query(`INSERT INTO asset_groups (id, tenant_id, name) VALUES ($1, $2, 'iso group')`, [
      newId(),
      tenantId,
    ]);
  },
  asset_group_members: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    const groupId = newId();
    await tx.query(
      `INSERT INTO asset_groups (id, tenant_id, name) VALUES ($1, $2, 'iso members')`,
      [groupId, tenantId],
    );
    await tx.query(
      `INSERT INTO asset_group_members (tenant_id, group_id, asset_id) VALUES ($1, $2, $3)`,
      [tenantId, groupId, assetId],
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
  standing_authorisations: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
       VALUES ($1, $2, $3, $4::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '30 days', $5)`,
      [newId(), tenantId, `sa_${randomBytes(8).toString('hex')}`, [newId()], newId()],
    );
  },
  gate_decisions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO gate_decisions (decision_id, tenant_id, run_id, gate, kind, dedupe_key, summary, requested_at, timeout_at)
       VALUES ($1, $2, $3, 2, 'tool_deferred', $4, 'iso decision', now(), now() + interval '1 hour')`,
      [newId(), tenantId, newId(), `iso-${randomBytes(8).toString('hex')}`],
    );
  },
  runs: async (tx, tenantId) => {
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [newId(), tenantId]);
  },
  // A plan and its case need a run in the same tenant (composite FKs), so one seeder writes the chain.
  test_plans: async (tx, tenantId) => {
    const runId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [newId(), tenantId, runId],
    );
  },
  test_cases: async (tx, tenantId) => {
    const runId = newId();
    const planId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [planId, tenantId, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget)
       VALUES ($1, $2, $3, 'passive', 'iso case', '[{"host":"iso.example.test"}]', '{"maxRequests":10}')`,
      [newId(), tenantId, planId],
    );
  },
};

/** An asset row (and the user that owns it, the users table being global). Returns the asset id. */
async function insertAsset(tx: pg.PoolClient, tenantId: string): Promise<string> {
  const userId = newId();
  await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
    userId,
    `iso-${userId}`,
    `iso-${userId}@example.test`,
  ]);
  const assetId = newId();
  await tx.query(
    `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status)
     VALUES ($1, $2, $3, 'web_app', 'iso asset', $4::jsonb, 'dev', $5, 'unverified')`,
    [
      assetId,
      tenantId,
      publicId('asset', assetId),
      JSON.stringify([{ kind: 'url', value: 'https://iso.example.test' }]),
      userId,
    ],
  );
  return assetId;
}

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
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
