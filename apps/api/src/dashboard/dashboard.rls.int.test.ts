// The dashboard service over real Postgres (DASH-001): the grouped counts a console renders, the Suspected rule, the
// signed keyset page and the coverage manifest, each read through the RLS tenant context. Another tenant's rows are
// never counted, and a caller with no role in the tenant is refused before any SQL runs. Needs Docker (Testcontainers);
// run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, DashboardRepository, migrateDatabase } from '@blackwing/db';
import { ForbiddenError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { DashboardService } from './service.js';
import { memoryMemberships } from '../findings/fixtures.test-helpers.js';
import { createCursorCodec } from '../pagination/index.js';

const SECRET = 'r'.repeat(40);
const tenantA = newId();
const tenantB = newId();
const assetX = newId();
const assetY = newId();
const assetB = newId();
const runA = newId();
const analystA = newId();
const developerA = newId();
const analystB = newId();
const CRITICAL = { cvss4: { score: 9.3, severity: 'critical' } };
const NONE = { cvss4: { score: 0, severity: 'none' } };

let db: PostgresHandle;
let service: DashboardService;

const memberships = memoryMemberships({
  [tenantA]: { [analystA]: ['appsec_engineer'], [developerA]: ['developer'] },
  [tenantB]: { [analystB]: ['appsec_engineer'] },
});

/** Inserts one finding for `tenant` through the app role (so RLS applies to the seed as to every read). */
async function insertFinding(input: {
  tenant: string;
  asset: string;
  severity: Record<string, unknown> | null;
  status: string;
  cwe: string | null;
  owasp: string | null;
  createdAt: Date;
}): Promise<string> {
  const id = newId();
  await db.withTenant(input.tenant, (tx) =>
    tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, unmapped, cwe_id, owasp_category,
         severity, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id, created_at)
       VALUES ($1, $2, $3, $4, 'finding', 'injection', $5, $6, $7, $8, $9, '{"urlTemplate":"/x"}', $10, $11, $11, $11, $12)`,
      [
        id,
        input.tenant,
        `fnd_${id.replaceAll('-', '')}`,
        createHash('sha256').update(id).digest('hex'),
        input.cwe === null || input.owasp === null,
        input.cwe,
        input.owasp,
        input.severity === null ? null : JSON.stringify(input.severity),
        input.asset,
        input.status,
        runA,
        input.createdAt,
      ],
    ),
  );
  return id;
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  service = new DashboardService({
    store: new DashboardRepository({ db: createDatabase(db.appPool) }),
    memberships,
    cursors: createCursorCodec(SECRET),
    metrics: { observe: vi.fn() },
    logger: { warn: vi.fn() },
  });
  for (const tenant of [tenantA, tenantB]) {
    await db.withTenant(tenant, (tx) =>
      tx.query('INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, $3, $4)', [
        tenant,
        `dash-${tenant}`,
        'Dashboard',
        'eu-west-1',
      ]),
    );
  }
  // Run A of tenant A covers asset X (its manifest lists the asset, which the asset's latest coverage reads).
  await db.withTenant(tenantA, (tx) =>
    tx.query('INSERT INTO runs (id, tenant_id, manifest) VALUES ($1, $2, $3::jsonb)', [
      runA,
      tenantA,
      JSON.stringify({ assetSummaries: [{ assetId: assetX, label: 'x.example.test' }] }),
    ]),
  );
  // Tenant A: a critical confirmed finding, an uncategorised one, and a suspected finding with no score band.
  await insertFinding({
    tenant: tenantA,
    asset: assetX,
    severity: CRITICAL,
    status: 'confirmed',
    cwe: 'CWE-89',
    owasp: 'A03',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  });
  await insertFinding({
    tenant: tenantA,
    asset: assetX,
    severity: null,
    status: 'confirmed',
    cwe: null,
    owasp: null,
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
  });
  await insertFinding({
    tenant: tenantA,
    asset: assetY,
    severity: NONE,
    status: 'suspected',
    cwe: 'CWE-79',
    owasp: 'A03',
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
  });
  // Tenant B: one critical finding on its own asset.
  await insertFinding({
    tenant: tenantB,
    asset: assetB,
    severity: CRITICAL,
    status: 'confirmed',
    cwe: 'CWE-89',
    owasp: 'A03',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  });
  await db.withTenant(tenantA, (tx) =>
    tx.query(
      `INSERT INTO coverage_manifests (tenant_id, run_id, entries)
       VALUES ($1, $2, $3::jsonb)`,
      [
        tenantA,
        runA,
        JSON.stringify([
          { testCaseRef: 'tc-1', status: 'tested', reason: null },
          { testCaseRef: 'tc-2', status: 'tested', reason: null },
          { testCaseRef: 'tc-3', status: 'tested', reason: null },
          { testCaseRef: 'tc-4', status: 'not_tested', reason: 'out of scope' },
        ]),
      ],
    ),
  );
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('findingSummary over Postgres', () => {
  it('groups the caller tenant findings, naming the missing values, with the Suspected rule applied', async () => {
    const analyst = await service.summary({ tenantId: tenantA, actorId: analystA }, {});
    expect(analyst.total).toBe(3);
    expect(analyst.bySeverity).toEqual(
      expect.arrayContaining([
        { key: 'critical', count: 1 },
        { key: 'info', count: 1 },
        { key: 'unscored', count: 1 },
      ]),
    );
    expect(analyst.byOwaspCategory).toEqual([
      { key: 'A03', count: 2 },
      { key: 'uncategorised', count: 1 },
    ]);
    const developer = await service.summary({ tenantId: tenantA, actorId: developerA }, {});
    expect(developer.total).toBe(2);
    expect(developer.byStatus).toEqual([{ key: 'confirmed', count: 2 }]);
  });

  it('never counts another tenant findings, and refuses a caller with no role in the tenant', async () => {
    const b = await service.summary({ tenantId: tenantB, actorId: analystB }, {});
    expect(b.total).toBe(1);
    expect(b.byAsset).toEqual([{ assetId: assetB, count: 1 }]);
    await expect(
      service.summary({ tenantId: tenantA, actorId: analystB }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const onForeignAsset = await service.summary(
      { tenantId: tenantB, actorId: analystB },
      { assetIds: [assetX] },
    );
    expect(onForeignAsset.total).toBe(0);
  });
});

describe('findingsConnection over Postgres', () => {
  it('pages the caller tenant findings with a signed cursor, without duplicates', async () => {
    const principal = { tenantId: tenantA, actorId: analystA };
    const first = await service.connection(principal, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.connection(principal, {
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(second.hasMore).toBe(false);
  });
});

describe('coverageSummary over Postgres', () => {
  it('reads the manifest of the caller tenant run, not finalised until it is', async () => {
    const principal = { tenantId: tenantA, actorId: analystA };
    const coverage = await service.coverage(principal, { runId: runA });
    expect(coverage).toMatchObject({
      finalised: false,
      testCasesPlanned: 4,
      testCasesExecuted: 3,
      coveragePercent: 75,
    });
    const foreign = await service.coverage(
      { tenantId: tenantB, actorId: analystB },
      { runId: runA },
    );
    expect(foreign).toMatchObject({
      finalised: false,
      testCasesPlanned: null,
      coveragePercent: null,
    });
  });
});
