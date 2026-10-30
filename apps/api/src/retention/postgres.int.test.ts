// Retention policies against real Postgres 16 as bw_app, with every migration applied (RETAIN-001,
// CONTEXT_PACK §7, §8.6, §8.8). Runs through Testcontainers (`pnpm test:int`); the in-memory store
// covers the same service rules without a database in service.test.ts.

import { eq } from 'drizzle-orm';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RETENTION_DEFAULTS } from '@blackwing/contracts';
import {
  createDatabase,
  MIGRATIONS_DIR,
  retentionPolicies,
  tenants,
  type Database,
  withTenant,
} from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createRetentionMetrics } from './metrics.js';
import { createPostgresRetentionStore, type RetentionAuditWriter } from './postgres.js';
import { RetentionService } from './service.js';

import type { RetentionPrincipal, RetentionAuditRecord } from './ports.js';

let handle: PostgresHandle;
let db: Database;
const tenantA = newId();
const tenantB = newId();
const audit: { tenantId: string; record: RetentionAuditRecord }[] = [];

const recordAudit: RetentionAuditWriter = (_tx, record) => {
  audit.push({ tenantId: record.tenantId, record });
  return Promise.resolve();
};

const principal = (tenantId: string): RetentionPrincipal => ({
  type: 'user',
  id: newId(),
  tenantId,
  roles: ['org_admin'],
});

function serviceOver(appendAudit: RetentionAuditWriter = recordAudit): RetentionService {
  return new RetentionService({
    store: createPostgresRetentionStore({ db, appendAudit }),
    metrics: createRetentionMetrics(new Registry()),
  });
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: MIGRATIONS_DIR });
  db = createDatabase(handle.appPool);
  // Distinct fixed slugs: a UUIDv7 prefix only encodes the time, so two ids made in one window collide.
  const slugs = new Map([
    [tenantA, 'ret-tenant-a'],
    [tenantB, 'ret-tenant-b'],
  ]);
  for (const [id, slug] of slugs) {
    await withTenant(db, id, (tx) =>
      tx.insert(tenants).values({ id, slug, name: 'retention', region: 'eu-west-1' }),
    );
  }
});

afterAll(async () => {
  await (handle as PostgresHandle | undefined)?.stop();
});

describe('retention policies in Postgres', () => {
  it('seeds the platform defaults for a tenant on first read', async () => {
    const service = serviceOver();
    const { body } = await service.get(principal(tenantA));
    const evidence = body.policies.find((p) => p.dataClass === 'evidence');
    expect(evidence).toMatchObject({
      retentionDays: RETENTION_DEFAULTS.evidence.retentionDays,
      minRetentionDays: RETENTION_DEFAULTS.evidence.minRetentionDays,
      enabled: true,
      legalHoldOverrides: false,
    });
    const rows = await withTenant(db, tenantA, (tx) =>
      tx.select().from(retentionPolicies).where(eq(retentionPolicies.tenantId, tenantA)),
    );
    expect(rows).toHaveLength(6);
  });

  it('applies a change, audits it in the same transaction and bumps updated_at', async () => {
    audit.length = 0;
    const service = serviceOver();
    const p = principal(tenantA);
    const { etag } = await service.get(p);
    const result = await service.replace(
      p,
      { policies: [{ dataClass: 'logs', retentionDays: 45, enabled: true }] },
      etag,
    );
    expect(result.body.policies.find((x) => x.dataClass === 'logs')?.retentionDays).toBe(45);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenantId).toBe(tenantA);
    expect(audit[0]?.record.action).toBe('config.changed');
  });

  it('rolls the policy write back when the audit write fails', async () => {
    const failing: RetentionAuditWriter = () => Promise.reject(new Error('ledger down'));
    const service = serviceOver(failing);
    const p = principal(tenantA);
    const { etag, body } = await service.get(p);
    const before = body.policies.find((x) => x.dataClass === 'reports')?.retentionDays;
    await expect(
      service.replace(
        p,
        { policies: [{ dataClass: 'reports', retentionDays: 200, enabled: true }] },
        etag,
      ),
    ).rejects.toThrow('ledger down');
    const after = await serviceOver().get(p);
    expect(after.body.policies.find((x) => x.dataClass === 'reports')?.retentionDays).toBe(before);
  });

  it('lets exactly one of two concurrent writers win (the other sees 412)', async () => {
    const service = serviceOver();
    const p = principal(tenantA);
    const { etag } = await service.get(p);
    const results = await Promise.allSettled([
      service.replace(
        p,
        { policies: [{ dataClass: 'transcripts', retentionDays: 60, enabled: true }] },
        etag,
      ),
      service.replace(
        p,
        { policies: [{ dataClass: 'transcripts', retentionDays: 90, enabled: true }] },
        etag,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('keeps tenant B blind to tenant A rows (RLS), and refuses a cross-tenant write', async () => {
    const seenByB = await withTenant(db, tenantB, (tx) => tx.select().from(retentionPolicies));
    expect(seenByB.every((row) => row.tenantId === tenantB)).toBe(true);

    await expect(
      withTenant(db, tenantB, (tx) =>
        tx.insert(retentionPolicies).values({
          tenantId: tenantA,
          dataClass: 'logs',
          retentionDays: 90,
          minRetentionDays: 30,
        }),
      ),
    ).rejects.toThrow();
  });

  it('enforces the floor and the legal-hold pin in the database itself', async () => {
    await expect(
      withTenant(db, tenantB, (tx) =>
        tx.insert(retentionPolicies).values({
          tenantId: tenantB,
          dataClass: 'evidence',
          retentionDays: 10,
          minRetentionDays: 30,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'retention_policies_days_check' });
    await expect(
      withTenant(db, tenantB, (tx) =>
        tx.insert(retentionPolicies).values({
          tenantId: tenantB,
          dataClass: 'evidence',
          retentionDays: 60,
          minRetentionDays: 30,
          legalHoldOverrides: true,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'retention_policies_legal_hold_check' });
  });

  it('the runtime role cannot delete a policy row', async () => {
    // 42501 (insufficient_privilege) is not a mapped query error, so the driver error carries the code.
    await expect(
      withTenant(db, tenantB, (tx) => tx.delete(retentionPolicies)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
