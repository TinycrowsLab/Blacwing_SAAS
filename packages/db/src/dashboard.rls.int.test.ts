// Dashboard read model against real Postgres (DASH-001): the grouped counts, the filters, the Suspected rule, the keyset
// page, the trend buckets, the coverage manifest and its finalisation, and tenant isolation of every read. Migrations are
// the real ones and reads run as the app role (bw_app), so RLS applies. Needs Docker (Testcontainers); `pnpm test:int`.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  DashboardRepository,
  type FindingSummaryRows,
  type HiddenStatuses,
} from './dashboard.repository.js';
import { createDatabase, migrateDatabase } from './index.js';

import type { DashboardFindingFilter } from '@blackwing/contracts';

let db: PostgresHandle;
let repo: DashboardRepository;
const tenantA = newId();
const tenantB = newId();
const assetX = newId();
const assetY = newId();
const assetB = newId();
const ownerA = newId();
const runR1 = newId();
const runR2 = newId();

const CRITICAL = { cvss4: { score: 9.3, severity: 'critical' } };
const HIGH = { cvss4: { score: 7.5, severity: 'high' } };
const NONE = { cvss4: { score: 0, severity: 'none' } };

interface Seed {
  readonly tenant: string;
  readonly asset: string;
  readonly severity?: Record<string, unknown> | null;
  readonly cwe?: string | null;
  readonly owasp?: string | null;
  readonly status?: string;
  readonly baseline?: string | null;
  readonly run?: string;
  readonly createdAt?: Date;
  readonly released?: boolean;
}

/** Inserts one finding for `tenant`, through the app role. An uncategorised finding is `unmapped`, as the CHECK needs. */
async function insertFinding(seed: Seed): Promise<string> {
  const id = newId();
  const run = seed.run ?? runR1;
  const cwe = seed.cwe === undefined ? 'CWE-89' : seed.cwe;
  const owasp = seed.owasp === undefined ? 'A03' : seed.owasp;
  const released = seed.released === true;
  await db.withTenant(seed.tenant, (tx) =>
    tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, unmapped, cwe_id, owasp_category,
         severity, asset_id, location, status, baseline_status, run_id, first_seen_run_id, last_seen_run_id,
         released_by, released_at, created_at)
       VALUES ($1, $2, $3, $4, 'finding', 'injection', $5, $6, $7, $8, $9, '{"urlTemplate":"/x"}', $10, $11, $12, $12, $12,
         $13, $14, $15)`,
      [
        id,
        seed.tenant,
        `fnd_${id.replaceAll('-', '')}`,
        createHash('sha256').update(id).digest('hex'),
        cwe === null || owasp === null,
        cwe,
        owasp,
        seed.severity === undefined || seed.severity === null
          ? null
          : JSON.stringify(seed.severity),
        seed.asset,
        seed.status ?? 'candidate',
        seed.baseline ?? null,
        run,
        released ? newId() : null,
        released ? new Date() : null,
        seed.createdAt ?? new Date(),
      ],
    ),
  );
  return id;
}

async function addOccurrence(tenant: string, findingId: string, run: string, detectedAt: Date) {
  await db.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO finding_occurrences (tenant_id, finding_id, run_id, occurrence_status, detected_at)
       VALUES ($1, $2, $3, 'confirmed', $4)`,
      [tenant, findingId, run, detectedAt],
    ),
  );
}

const NO_FILTER: DashboardFindingFilter = {};
const NOTHING_HIDDEN: HiddenStatuses = [];
const HIDE_SUSPECTED: HiddenStatuses = ['suspected'];

/** The count of one key in a summary group (0 when absent). */
function countOf(rows: FindingSummaryRows['severity'], key: string | null): number {
  return rows.find((row) => row.key === key)?.count ?? 0;
}

let findingCritical: string;
let findingInfo: string;
let findingUnscored: string;

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  repo = new DashboardRepository({ db: createDatabase(db.appPool) });
  // Tenant A: four findings on two assets. The suspected one is an info-band finding on asset Y.
  findingCritical = await insertFinding({
    tenant: tenantA,
    asset: assetX,
    severity: CRITICAL,
    status: 'confirmed',
    baseline: 'new',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  });
  await insertFinding({
    tenant: tenantA,
    asset: assetX,
    severity: HIGH,
    cwe: null,
    owasp: null,
    status: 'released',
    released: true,
    baseline: null,
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
  });
  findingInfo = await insertFinding({
    tenant: tenantA,
    asset: assetY,
    severity: NONE,
    cwe: 'CWE-79',
    owasp: 'A03',
    status: 'suspected',
    baseline: 'open',
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
  });
  findingUnscored = await insertFinding({
    tenant: tenantA,
    asset: assetY,
    severity: null,
    status: 'candidate',
    baseline: 'fixed',
    createdAt: new Date('2026-10-04T10:00:00.000Z'),
  });
  // Tenant B: one critical finding on its own asset.
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
  await db.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [ownerA, `sub-${ownerA}`, `${ownerA}@dash.test`, 'Owner'],
  );
  await db.withTenant(tenantA, (tx) =>
    tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id)
       VALUES ($1, $2, $3, 'web_app', 'Checkout', '[{"kind":"url","value":"https://checkout.acme.test"}]', 'prod', $4)`,
      [assetX, tenantA, `asset_${assetX.replaceAll('-', '')}`, ownerA],
    ),
  );
  await insertFinding({ tenant: tenantB, asset: assetB, severity: CRITICAL, status: 'confirmed' });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('summary', () => {
  it('counts every dimension from one snapshot, with explicit buckets for missing values', async () => {
    const summary = await repo.summary(tenantA, NO_FILTER, NOTHING_HIDDEN);
    expect(summary.total).toBe(4);
    expect(countOf(summary.severity, 'critical')).toBe(1);
    expect(countOf(summary.severity, 'high')).toBe(1);
    expect(countOf(summary.severity, 'none')).toBe(1);
    expect(countOf(summary.severity, null)).toBe(1);
    expect(countOf(summary.owaspCategory, null)).toBe(1);
    expect(countOf(summary.owaspCategory, 'A03')).toBe(3);
    expect(countOf(summary.cweId, null)).toBe(1);
    expect(countOf(summary.assetId, assetX)).toBe(2);
    expect(countOf(summary.assetId, assetY)).toBe(2);
    expect(countOf(summary.status, 'released')).toBe(1);
    expect(countOf(summary.baselineStatus, null)).toBe(1);
  });

  it('hides suspected findings from the groups when the viewer may not see them', async () => {
    const summary = await repo.summary(tenantA, NO_FILTER, HIDE_SUSPECTED);
    expect(summary.total).toBe(3);
    expect(countOf(summary.severity, 'none')).toBe(0);
    expect(countOf(summary.status, 'suspected')).toBe(0);
  });

  it('returns no rows and a zero total for a tenant with no findings, never null groups', async () => {
    const summary = await repo.summary(newId(), NO_FILTER, NOTHING_HIDDEN);
    expect(summary).toEqual({
      total: 0,
      severity: [],
      owaspCategory: [],
      cweId: [],
      assetId: [],
      status: [],
      baselineStatus: [],
    });
  });

  it('applies the filters with AND across fields and OR within a field', async () => {
    const info = await repo.summary(tenantA, { severities: ['info'] }, NOTHING_HIDDEN);
    expect(info.total).toBe(1);
    const criticalOrHigh = await repo.summary(
      tenantA,
      { severities: ['critical', 'high'] },
      NOTHING_HIDDEN,
    );
    expect(criticalOrHigh.total).toBe(2);
    const uncategorisedOnAssetX = await repo.summary(
      tenantA,
      { assetIds: [assetX], owaspCategories: ['A03'] },
      NOTHING_HIDDEN,
    );
    expect(uncategorisedOnAssetX.total).toBe(1);
    const notRetested = await repo.summary(
      tenantA,
      { baselineStatuses: ['not_retested'] },
      NOTHING_HIDDEN,
    );
    expect(notRetested.total).toBe(1);
    const released = await repo.summary(tenantA, { releasedOnly: true }, NOTHING_HIDDEN);
    expect(released.total).toBe(1);
  });

  it('filters by run through the occurrences a finding was seen in', async () => {
    const seen = await insertFinding({
      tenant: tenantA,
      asset: assetX,
      severity: HIGH,
      run: runR2,
      status: 'confirmed',
    });
    await addOccurrence(tenantA, seen, runR2, new Date('2026-10-05T10:00:00.000Z'));
    const inRun2 = await repo.summary(tenantA, { runIds: [runR2] }, NOTHING_HIDDEN);
    expect(inRun2.total).toBe(1);
    expect(countOf(inRun2.severity, 'high')).toBe(1);
  });

  it('refuses a read with no tenant context (fail closed, no rows)', async () => {
    await expect(repo.summary('', NO_FILTER, NOTHING_HIDDEN)).rejects.toThrow(
      TenantContextMissingError,
    );
  });

  it('never counts another tenant findings, even when the filter names its asset', async () => {
    const b = await repo.summary(tenantB, NO_FILTER, NOTHING_HIDDEN);
    expect(b.total).toBe(1);
    expect(countOf(b.severity, 'critical')).toBe(1);
    const aOnBAsset = await repo.summary(tenantA, { assetIds: [assetB] }, NOTHING_HIDDEN);
    expect(aOnBAsset.total).toBe(0);
    const bOnAAsset = await repo.summary(tenantB, { assetIds: [assetX] }, NOTHING_HIDDEN);
    expect(bOnAAsset.total).toBe(0);
    const aCritical = await repo.summary(tenantA, { severities: ['critical'] }, NOTHING_HIDDEN);
    expect(aCritical.total).toBe(1);
  });
});

describe('connection', () => {
  it('pages by a stable keyset with no duplicates and the same order as the unpaged list', async () => {
    const all = await repo.connection(tenantA, NO_FILTER, NOTHING_HIDDEN, 100);
    expect(all.length).toBeGreaterThanOrEqual(4);
    const first = await repo.connection(tenantA, NO_FILTER, NOTHING_HIDDEN, 3);
    const last = first.at(-1);
    expect(last).toBeDefined();
    const after = last === undefined ? undefined : { createdAt: last.createdAt, id: last.id };
    const second = await repo.connection(tenantA, NO_FILTER, NOTHING_HIDDEN, 100, after);
    const paged = [...first, ...second].map((row) => row.id);
    expect(paged).toEqual(all.map((row) => row.id));
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('keeps the hidden statuses out of the page', async () => {
    const page = await repo.connection(tenantA, NO_FILTER, HIDE_SUSPECTED, 100);
    expect(page.map((row) => row.id)).not.toContain(findingInfo);
  });

  it('returns nothing across tenants', async () => {
    const page = await repo.connection(tenantB, NO_FILTER, NOTHING_HIDDEN, 100);
    const ids = page.map((row) => row.id);
    expect(ids).not.toContain(findingCritical);
    expect(ids).not.toContain(findingUnscored);
  });
});

describe('trend', () => {
  it('counts distinct findings per UTC day and baseline state, for one asset only', async () => {
    const finding = await insertFinding({
      tenant: tenantA,
      asset: assetX,
      severity: CRITICAL,
      baseline: 'returned',
      status: 'confirmed',
    });
    await addOccurrence(tenantA, finding, runR1, new Date('2026-10-06T08:00:00.000Z'));
    await addOccurrence(tenantA, finding, runR2, new Date('2026-10-06T20:00:00.000Z'));
    const days = await repo.trend(tenantA, assetX, 'day', NOTHING_HIDDEN);
    const returned = days.find((row) => row.baselineStatus === 'returned');
    expect(returned?.count).toBe(1);
    expect(returned?.bucketStart.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(days.every((row) => row.bucketStart.getUTCHours() === 0)).toBe(true);
  });

  it('buckets by ISO week (Monday start) when asked', async () => {
    const weeks = await repo.trend(tenantA, assetX, 'week', NOTHING_HIDDEN);
    expect(weeks.length).toBeGreaterThan(0);
    for (const row of weeks) expect(row.bucketStart.getUTCDay()).toBe(1);
  });

  it('is empty for an asset with no occurrences and for another tenant asset', async () => {
    expect(await repo.trend(tenantA, newId(), 'day', NOTHING_HIDDEN)).toEqual([]);
    expect(await repo.trend(tenantB, assetX, 'day', NOTHING_HIDDEN)).toEqual([]);
  });
});

describe('coverage manifests', () => {
  const assetCov = newId();
  const TESTED = { testCaseRef: 'tc-1', status: 'tested', reason: null };
  const NOT_TESTED = { testCaseRef: 'tc-2', status: 'not_tested', reason: 'out of window' };

  /** Inserts a run of `tenant` whose manifest names `assets`, created at `createdAt`; returns its id. */
  async function insertRun(
    tenant: string,
    assets: readonly string[],
    createdAt: Date,
  ): Promise<string> {
    const id = newId();
    const manifest = { assetSummaries: assets.map((assetId) => ({ assetId, label: 'web' })) };
    await db.withTenant(tenant, (tx) =>
      tx.query('INSERT INTO runs (id, tenant_id, manifest, created_at) VALUES ($1, $2, $3, $4)', [
        id,
        tenant,
        JSON.stringify(manifest),
        createdAt,
      ]),
    );
    return id;
  }

  async function insertManifest(
    tenant: string,
    run: string,
    entries: readonly unknown[],
  ): Promise<void> {
    await db.withTenant(tenant, (tx) =>
      tx.query('INSERT INTO coverage_manifests (tenant_id, run_id, entries) VALUES ($1, $2, $3)', [
        tenant,
        run,
        JSON.stringify(entries),
      ]),
    );
  }

  it('reads the manifest of a run and returns undefined for a run with none', async () => {
    const run = await insertRun(tenantA, [assetCov], new Date('2026-01-01T00:00:00Z'));
    await insertManifest(tenantA, run, [TESTED, NOT_TESTED]);
    const row = await repo.coverageOfRun(tenantA, run);
    expect(row).toMatchObject({ runId: run, finalisedAt: null });
    expect(row?.entries).toHaveLength(2);
    expect(await repo.coverageOfRun(tenantA, newId())).toBeUndefined();
  });

  it('reads the newest run of an asset with its manifest, or with none while the run records', async () => {
    const asset = newId();
    const older = await insertRun(tenantA, [asset], new Date('2026-02-01T00:00:00Z'));
    await insertManifest(tenantA, older, [TESTED]);
    const newer = await insertRun(tenantA, [asset], new Date('2026-03-01T00:00:00Z'));
    expect(await repo.latestCoverageOfAsset(tenantA, asset)).toEqual({
      runId: newer,
      coverage: null,
    });
    await insertManifest(tenantA, newer, [TESTED, NOT_TESTED]);
    expect((await repo.latestCoverageOfAsset(tenantA, asset))?.coverage?.entries).toHaveLength(2);
    expect(await repo.latestCoverageOfAsset(tenantA, newId())).toBeUndefined();
  });

  it('never returns another tenant manifest or run, even for a known id', async () => {
    const run = await insertRun(tenantA, [assetCov], new Date('2026-04-01T00:00:00Z'));
    await insertManifest(tenantA, run, [TESTED]);
    expect(await repo.coverageOfRun(tenantB, run)).toBeUndefined();
    expect(await repo.latestCoverageOfAsset(tenantB, assetCov)).toBeUndefined();
  });

  it('is immutable once finalised, and the app role cannot delete it', async () => {
    const run = await insertRun(tenantA, [assetCov], new Date('2026-05-01T00:00:00Z'));
    await insertManifest(tenantA, run, [TESTED]);
    await db.withTenant(tenantA, (tx) =>
      tx.query('UPDATE coverage_manifests SET finalised_at = now() WHERE run_id = $1', [run]),
    );
    await expect(
      db.withTenant(tenantA, (tx) =>
        tx.query('UPDATE coverage_manifests SET entries = $2 WHERE run_id = $1', [run, '[]']),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM coverage_manifests WHERE run_id = $1', [run]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('assetNames', () => {
  it('names the caller tenant assets, and leaves unknown and foreign ids absent', async () => {
    const names = await repo.assetNames(tenantA, [assetX, newId()]);
    expect(names).toEqual(new Map([[assetX, 'Checkout']]));
    expect(await repo.assetNames(tenantB, [assetX])).toEqual(new Map());
  });
});
