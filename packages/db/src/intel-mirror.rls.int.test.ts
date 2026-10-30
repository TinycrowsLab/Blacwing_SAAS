// The vulnerability-intelligence mirror (INTEL-001): reference tables are read-only for the runtime role, the CVE upsert
// is idempotent and never regresses, the CHECK constraints refuse malformed rows that bypass the application, and
// `finding_intel` is tenant-isolated (RLS, composite foreign key, fail closed). Runs against the real migrations on
// Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { newId } from '@blackwing/ids';
import {
  expectFailsClosedWithoutContext,
  expectRlsBlocksCrossTenant,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { createDatabase, migrateDatabase } from './index.js';
import { countIntelMirrorRows, upsertCveRecords } from './intel-mirror.repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
let findingA: string;
let findingB: string;

const CVSS31_CRITICAL = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const REFERENCE_TABLES = [
  'cve_records',
  'kev_entries',
  'epss_scores',
  'osv_advisories',
  'cwe_catalogue',
  'owasp_mappings',
  'source_sync_state',
] as const;

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 42501 privilege, 42704 no context). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    // Drizzle wraps the driver error and keeps it as `cause`; raw pg calls throw it directly.
    const cause = error instanceof Error ? error.cause : undefined;
    const pgError = error instanceof pg.DatabaseError ? error : cause;
    return pgError instanceof pg.DatabaseError ? pgError.code : 'not-a-database-error';
  }
  return undefined;
}

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

/** A valid CVE record in the domain shape. Tests override one field at a time. */
function cve(overrides: Record<string, unknown> = {}) {
  return {
    cveId: 'CVE-2024-12345',
    published: new Date('2024-03-01T00:00:00.000Z'),
    lastModified: new Date('2024-03-02T00:00:00.000Z'),
    cvssV31: { vector: CVSS31_CRITICAL, baseScore: 9.8 },
    cvssV40: null,
    cweIds: ['CWE-89'],
    cpeMatches: [{ criteria: 'cpe:2.3:a:vendor:product:*:*:*:*:*:*:*:*' }],
    description: 'An example vulnerability.',
    sourceUpdated: new Date('2024-03-02T00:00:00.000Z'),
    ...overrides,
  };
}

/** A raw `findings` row for `tenant` (the columns the FINDING-001 test uses), so finding_intel has a parent to join. */
async function insertFinding(tenant: string): Promise<string> {
  const id = newId();
  await db.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO findings
         (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, baseline_status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'intel', 'raw_class', $5, '{"urlTemplate":"/x","method":"GET"}', 'candidate', NULL, $6, $6, $6, 'CWE-89', 'A03')`,
      [id, tenant, `fnd_${id.replaceAll('-', '')}`, fingerprint(id), newId(), newId()],
    ),
  );
  return id;
}

/** Inserts one finding_intel row for `tenant` under its own context. */
function insertFindingIntel(tenant: string, findingId: string, cveId = 'CVE-2024-12345') {
  return db.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO finding_intel (tenant_id, finding_id, cve_id, kev, epss) VALUES ($1, $2, $3, true, 0.5)`,
      [tenant, findingId, cveId],
    ),
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  findingA = await insertFinding(tenantA);
  findingB = await insertFinding(tenantB);
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('reference tables are shared read-only (§8.6)', () => {
  it('are readable by the app role without a tenant context', async () => {
    const counts = await countIntelMirrorRows(createDatabase(db.appPool));
    expect(counts).toEqual({
      cve_records: 0,
      kev_entries: 0,
      epss_scores: 0,
      osv_advisories: 0,
      cwe_catalogue: 0,
      owasp_mappings: 0,
      source_sync_state: 0,
    });
  });

  const appWrites: Record<(typeof REFERENCE_TABLES)[number], string> = {
    cve_records: `INSERT INTO cve_records (cve_id) VALUES ('CVE-2024-0001')`,
    kev_entries: `INSERT INTO kev_entries (cve_id, date_added) VALUES ('CVE-2024-0001', '2024-01-01')`,
    epss_scores: `INSERT INTO epss_scores (cve_id, epss, percentile, score_date) VALUES ('CVE-2024-0001', 0.1, 0.2, '2024-01-01')`,
    osv_advisories: `INSERT INTO osv_advisories (osv_id, ecosystem, package) VALUES ('OSV-1', 'npm', 'left-pad')`,
    cwe_catalogue: `INSERT INTO cwe_catalogue (cwe_id, name, abstraction) VALUES ('CWE-89', 'SQL Injection', 'Base')`,
    owasp_mappings: `INSERT INTO owasp_mappings (scheme, code, title) VALUES ('top10_2021', 'A03', 'Injection')`,
    source_sync_state: `INSERT INTO source_sync_state (source) VALUES ('nvd')`,
  };

  it.each(REFERENCE_TABLES)(
    'the app role cannot write %s, with or without a tenant context',
    async (table) => {
      expect(await pgCode(db.appPool.query(appWrites[table]))).toBe('42501');
      expect(await pgCode(db.appPool.query(`DELETE FROM ${table}`))).toBe('42501');
      expect(await pgCode(db.withTenant(tenantA, (tx) => tx.query(appWrites[table])))).toBe(
        '42501',
      );
    },
  );
});

describe('CHECK constraints refuse malformed rows that bypass the application', () => {
  const bad: [string, string][] = [
    ['a malformed CVE id', `INSERT INTO cve_records (cve_id) VALUES ('cve-2024-1')`],
    [
      'a CVSS block with no vector',
      `INSERT INTO cve_records (cve_id, cvss_v31) VALUES ('CVE-2024-0002', '{"baseScore": 9.8}')`,
    ],
    [
      'a CVSS block whose base score is not a number',
      `INSERT INTO cve_records (cve_id, cvss_v40) VALUES ('CVE-2024-0003', '{"vector": "CVSS:4.0/AV:N", "baseScore": "9.3"}')`,
    ],
    [
      'an oversized cpe_matches',
      `INSERT INTO cve_records (cve_id, cpe_matches) VALUES ('CVE-2024-0004', jsonb_build_array(repeat('x', 70000)))`,
    ],
    [
      'an oversized description',
      `INSERT INTO cve_records (cve_id, description) VALUES ('CVE-2024-0005', repeat('d', 20000))`,
    ],
    [
      'an unknown OWASP scheme',
      `INSERT INTO owasp_mappings (scheme, code, title) VALUES ('top10_2017', 'A1', 'x')`,
    ],
    ['an unknown sync source', `INSERT INTO source_sync_state (source) VALUES ('shodan')`],
    [
      'an unknown sync status',
      `INSERT INTO source_sync_state (source, status) VALUES ('osv', 'done')`,
    ],
    [
      'a negative record count',
      `INSERT INTO source_sync_state (source, record_count) VALUES ('ghsa', -1)`,
    ],
    [
      'an EPSS probability above 1',
      `INSERT INTO epss_scores (cve_id, epss, percentile, score_date) VALUES ('CVE-2024-0006', 1.2, 0.2, '2024-01-01')`,
    ],
    [
      'a malformed GHSA id on an advisory',
      `INSERT INTO osv_advisories (osv_id, ecosystem, package, ghsa_id) VALUES ('OSV-2', 'npm', 'x', 'GHSA-ABCD-EFGH-IJKL')`,
    ],
    [
      'a malformed CWE id in the catalogue',
      `INSERT INTO cwe_catalogue (cwe_id, name, abstraction) VALUES ('CWE-x', 'x', 'Base')`,
    ],
  ];

  it.each(bad)('refuses %s', async (_label, sql) => {
    expect(await pgCode(db.ownerPool.query(sql))).toBe('23514');
  });
});

describe('upsertCveRecords (INTEL-001: one row per CVE, idempotent, never regresses)', () => {
  it('stores a CVE without a CVSS vector as NULL blocks, never a fabricated score', async () => {
    await upsertCveRecords(createDatabase(db.ownerPool), [
      cve({ cveId: 'CVE-2025-00001', cvssV31: null, cvssV40: null }),
    ]);
    const { rows } = await db.ownerPool.query<{ v31: unknown; v40: unknown }>(
      `SELECT cvss_v31 AS v31, cvss_v40 AS v40 FROM cve_records WHERE cve_id = 'CVE-2025-00001'`,
    );
    expect(rows).toEqual([{ v31: null, v40: null }]);
  });

  it('is idempotent: running the same batch twice leaves one row', async () => {
    const database = createDatabase(db.ownerPool);
    const record = cve({ cveId: 'CVE-2025-00002' });
    await upsertCveRecords(database, [record]);
    await upsertCveRecords(database, [record]);
    const { rows } = await db.ownerPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cve_records WHERE cve_id = 'CVE-2025-00002'`,
    );
    expect(rows).toEqual([{ n: '1' }]);
  });

  it('overwrites with a newer source_updated and refuses an older one', async () => {
    const database = createDatabase(db.ownerPool);
    const description = async () =>
      (
        await db.ownerPool.query<{ description: string }>(
          `SELECT description FROM cve_records WHERE cve_id = 'CVE-2025-00003'`,
        )
      ).rows[0]?.description;
    await upsertCveRecords(database, [
      cve({
        cveId: 'CVE-2025-00003',
        description: 'v2',
        sourceUpdated: new Date('2025-01-02T00:00:00Z'),
      }),
    ]);
    await upsertCveRecords(database, [
      cve({
        cveId: 'CVE-2025-00003',
        description: 'v1 (older)',
        sourceUpdated: new Date('2025-01-01T00:00:00Z'),
      }),
    ]);
    expect(await description()).toBe('v2');
    await upsertCveRecords(database, [
      cve({
        cveId: 'CVE-2025-00003',
        description: 'v3',
        sourceUpdated: new Date('2025-01-03T00:00:00Z'),
      }),
    ]);
    expect(await description()).toBe('v3');
  });

  it('keeps the newest of two sources reporting the same CVE in one batch', async () => {
    const database = createDatabase(db.ownerPool);
    const submitted = await upsertCveRecords(database, [
      cve({
        cveId: 'CVE-2025-00004',
        description: 'nvd',
        sourceUpdated: new Date('2025-02-01T00:00:00Z'),
      }),
      cve({
        cveId: 'CVE-2025-00004',
        description: 'osv-late',
        sourceUpdated: new Date('2025-02-03T00:00:00Z'),
      }),
      cve({
        cveId: 'CVE-2025-00004',
        description: 'osv-early',
        sourceUpdated: new Date('2025-02-02T00:00:00Z'),
      }),
    ]);
    expect(submitted).toBe(1);
    const { rows } = await db.ownerPool.query<{ description: string }>(
      `SELECT description FROM cve_records WHERE cve_id = 'CVE-2025-00004'`,
    );
    expect(rows).toEqual([{ description: 'osv-late' }]);
  });

  it('refuses a forged score at the boundary, before any row is written', async () => {
    const database = createDatabase(db.ownerPool);
    await expect(
      upsertCveRecords(database, [
        cve({ cveId: 'CVE-2025-00005', cvssV31: { vector: CVSS31_CRITICAL, baseScore: 2 } }),
      ]),
    ).rejects.toBeInstanceOf(ZodError);
    const { rows } = await db.ownerPool.query(
      `SELECT 1 FROM cve_records WHERE cve_id = 'CVE-2025-00005'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses an oversized cpe_matches at the boundary', async () => {
    await expect(
      upsertCveRecords(createDatabase(db.ownerPool), [
        cve({ cveId: 'CVE-2025-00006', cpeMatches: [{ criteria: 'x'.repeat(70_000) }] }),
      ]),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('is refused for the runtime role, which has no write grant on the mirror', async () => {
    const code = await pgCode(
      upsertCveRecords(createDatabase(db.appPool), [cve({ cveId: 'CVE-2025-00007' })]),
    );
    expect(code).toBe('42501');
  });
});

describe('finding_intel is tenant-isolated (§8.6)', () => {
  it('a tenant reads its own join rows', async () => {
    await insertFindingIntel(tenantA, findingA);
    const { rows } = await db.withTenant(tenantA, (tx) =>
      tx.query<{ cve_id: string; kev: boolean }>(
        `SELECT cve_id, kev FROM finding_intel WHERE finding_id = $1`,
        [findingA],
      ),
    );
    expect(rows).toEqual([{ cve_id: 'CVE-2024-12345', kev: true }]);
  });

  it('tenant B cannot read tenant A join rows', async () => {
    const seen = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT finding_id FROM finding_intel WHERE finding_id = $1', [findingA]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it('tenant B cannot insert a join row under tenant A', async () => {
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO finding_intel (tenant_id, finding_id, cve_id) VALUES ($1, $2, 'CVE-2024-12345')`,
          [tenantA, findingB],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a join row cannot reference another tenant finding (composite foreign key)', async () => {
    const code = await pgCode(insertFindingIntel(tenantB, findingA, 'CVE-2024-99999'));
    expect(code).toBe('23503');
  });

  it('a join row keeps its EPSS score within [0, 1]', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO finding_intel (tenant_id, finding_id, cve_id, epss) VALUES ($1, $2, 'CVE-2024-88888', 1.5)`,
          [tenantA, findingA],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('RLS blocks cross-tenant reads and writes on finding_intel', async () => {
    await expect(
      expectRlsBlocksCrossTenant(db.appPool, 'finding_intel', {
        tenantA,
        tenantB,
        insertRow: async (tx, tenantId) => {
          await tx.query(
            `INSERT INTO finding_intel (tenant_id, finding_id, cve_id) VALUES ($1, $2, 'CVE-2024-77777')`,
            [tenantId, tenantId === tenantA ? findingA : findingB],
          );
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed without a tenant context', async () => {
    await expect(
      expectFailsClosedWithoutContext(db.appPool, 'finding_intel'),
    ).resolves.toBeUndefined();
  });

  it('applies to the owner role too (FORCE ROW LEVEL SECURITY): no context, no rows', async () => {
    expect(await pgCode(db.ownerPool.query('SELECT 1 FROM finding_intel'))).toBe('42704');
  });
});

describe('the reference-table indexes exist', () => {
  it('creates the GIN indexes for CPE matches and CWE ids and the package lookup', async () => {
    const { rows } = await db.ownerPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('cve_records', 'osv_advisories', 'epss_scores') ORDER BY indexname`,
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'cve_records_cpe_matches_gin_idx',
        'cve_records_cwe_ids_gin_idx',
        'osv_advisories_ecosystem_package_idx',
        'epss_scores_score_date_idx',
      ]),
    );
  });
});
