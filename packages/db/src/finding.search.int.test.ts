// Finding search for the query API (FINDING query): every filter, the Suspected exclusion, the newest-first keyset
// and tenant isolation, against the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { FindingRepository, type FindingRow } from './finding.repository.js';
import { createDatabase, migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const assetOne = newId();
const assetTwo = newId();

const CRITICAL = {
  cvss4: {
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
    score: 9.3,
    severity: 'critical',
    nomenclature: 'CVSS-B',
  },
};
const HIGH = {
  cvss4: {
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 8.7,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
};

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function repoFor(tenant: string) {
  return new FindingRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

interface SeedOverrides {
  readonly status?: string;
  readonly severity?: typeof CRITICAL | typeof HIGH;
  readonly assetId?: string;
  readonly refs?: { cwe?: string[]; owasp?: string };
  readonly baselineStatus?: string;
}

function seed(overrides: SeedOverrides = {}) {
  const runId = newId();
  return {
    fingerprint: fingerprint(newId()),
    title: 'Missing authorisation on /admin',
    class: 'broken_access_control',
    refs: overrides.refs ?? { cwe: ['CWE-22'], owasp: 'A01' },
    assetId: overrides.assetId ?? assetOne,
    location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
    status: overrides.status ?? 'confirmed',
    baselineStatus: overrides.baselineStatus ?? null,
    severity: overrides.severity ?? null,
    runId,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
  };
}

let confirmedA: FindingRow;
let suspectedA: FindingRow;
let criticalSqlA: FindingRow;
let sqliA: FindingRow;

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  const repo = repoFor(tenantA);
  // Created in this order, so the newest-first list is: sqli, critical, suspected, confirmed.
  confirmedA = await repo.create(seed({ status: 'confirmed', baselineStatus: 'new' }));
  suspectedA = await repo.create(seed({ status: 'suspected' }));
  criticalSqlA = await repo.create(
    seed({ status: 'confirmed', severity: CRITICAL, assetId: assetTwo, baselineStatus: 'open' }),
  );
  sqliA = await repo.create(
    seed({ status: 'confirmed', refs: { cwe: ['CWE-89'], owasp: 'A03' }, severity: HIGH }),
  );
  await repoFor(tenantB).create(seed({ status: 'confirmed' }));
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('search filters', () => {
  it('returns every finding of the tenant, newest first', async () => {
    const rows = await repoFor(tenantA).search({ limit: 201 });
    expect(rows.map((row) => row.id)).toEqual([
      sqliA.id,
      criticalSqlA.id,
      suspectedA.id,
      confirmedA.id,
    ]);
  });

  it('filters by status and by the excluded statuses (the Suspected rule)', async () => {
    const repo = repoFor(tenantA);
    expect((await repo.search({ limit: 50, status: 'suspected' })).map((r) => r.id)).toEqual([
      suspectedA.id,
    ]);
    const visibleToDeveloper = await repo.search({ limit: 50, excludeStatuses: ['suspected'] });
    expect(visibleToDeveloper.map((r) => r.id)).not.toContain(suspectedA.id);
    expect(visibleToDeveloper).toHaveLength(3);
  });

  it('filters by the CVSS v4 band, the CWE, the OWASP category, the baseline and the asset', async () => {
    const repo = repoFor(tenantA);
    expect((await repo.search({ limit: 50, severity: 'critical' })).map((r) => r.id)).toEqual([
      criticalSqlA.id,
    ]);
    expect((await repo.search({ limit: 50, severity: 'high' })).map((r) => r.id)).toEqual([
      sqliA.id,
    ]);
    expect((await repo.search({ limit: 50, cweId: 'CWE-89' })).map((r) => r.id)).toEqual([
      sqliA.id,
    ]);
    expect((await repo.search({ limit: 50, owaspCategory: 'A01' })).map((r) => r.id)).toEqual([
      criticalSqlA.id,
      suspectedA.id,
      confirmedA.id,
    ]);
    expect((await repo.search({ limit: 50, baselineStatus: 'open' })).map((r) => r.id)).toEqual([
      criticalSqlA.id,
    ]);
    expect((await repo.search({ limit: 50, assetId: assetTwo })).map((r) => r.id)).toEqual([
      criticalSqlA.id,
    ]);
  });

  it('combines filters with AND', async () => {
    const rows = await repoFor(tenantA).search({
      limit: 50,
      owaspCategory: 'A01',
      cweId: 'CWE-89',
    });
    expect(rows).toEqual([]);
  });
});

describe('search keyset', () => {
  it('pages newest first with no duplicate and no gap, and the unpaged list equals the concatenated pages', async () => {
    const repo = repoFor(tenantA);
    const unpaged = await repo.search({ limit: 201 });
    const first = await repo.search({ limit: 3 });
    expect(first).toHaveLength(3);
    const last = first[first.length - 1];
    if (last === undefined) throw new Error('expected a first page');
    const rest = await repo.search({
      limit: 3,
      after: { createdAt: last.createdAt, id: last.id },
    });
    expect([...first, ...rest].map((r) => r.id)).toEqual(unpaged.map((r) => r.id));
  });
});

describe('search tenant isolation', () => {
  it("tenant B cannot see tenant A's findings through any filter", async () => {
    const repo = repoFor(tenantB);
    const rows = await repo.search({ limit: 201 });
    expect(rows.map((r) => r.id)).not.toContain(confirmedA.id);
    expect(rows.every((r) => r.tenantId === tenantB)).toBe(true);
    expect(await repo.search({ limit: 50, assetId: assetOne, status: 'confirmed' })).toHaveLength(
      1,
    );
    expect(await repo.search({ limit: 50, assetId: assetTwo })).toEqual([]);
  });

  it('fails closed without a tenant context', async () => {
    const none = new FindingRepository({ db: createDatabase(db.appPool), tenant: () => undefined });
    await expect(none.search({ limit: 10 })).rejects.toThrow(TenantContextMissingError);
  });
});
