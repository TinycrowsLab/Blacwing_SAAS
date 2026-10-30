// Report assembly against the real migrations on Postgres 16 (REPORT-001, Testcontainers): the released-only selection,
// the severity ordering and its paging, the accepted-risk section, the finalised coverage gate, cross-tenant denial and
// the immutability of a finalised coverage manifest. Run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, withReportSource } from '@blackwing/db';
import { ConflictError, NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { assembleReport } from './assemble.js';

import type { ReportModel } from '@blackwing/contracts';

let pgHandle: PostgresHandle;
let database: ReturnType<typeof createDatabase>;

const tenantA = newId();
const tenantB = newId();
const FIXED_NOW = new Date('2026-10-30T12:00:00.000Z');
const ASSET = newId();
const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

const provenance = {
  modelIds: ['claude-sonnet-4-5'],
  personaVersions: [{ persona: 'reporter', version: '1.2.0', promptSha256: SHA }],
  sdkVersion: '0.2.0',
  claudeCodeVersion: '2.1.0',
  sandboxImageDigest: DIGEST,
  toolVersions: [{ name: 'nuclei', version: '3.3.0' }],
  nucleiTemplateCommit: COMMIT,
  policyHash: SHA,
  envelopeHash: SHA,
  priceTableVersion: '2026-10',
};

const manifest = {
  mode: 'grey',
  objective: 'Check the admin area for broken access control.',
  window: null,
  startedAt: '2026-10-01T01:00:00.000Z',
  endedAt: '2026-10-01T03:00:00.000Z',
  assetSummaries: [{ assetId: ASSET, label: 'shop.example.test' }],
  provenance,
};

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

/** Postgres error code of a rejected promise (23514 check, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function cvss4(score: number, severity: string) {
  return {
    cvss4: {
      vector: `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N`,
      score,
      severity,
      nomenclature: 'CVSS-B',
    },
  };
}

interface FindingFixture {
  readonly id?: string;
  readonly publicId?: string;
  readonly class?: string;
  readonly title?: string;
  readonly status?: 'released' | 'candidate' | 'accepted_risk';
  readonly severity?: Record<string, unknown> | null;
  readonly description?: string | null;
  readonly impact?: string | null;
  readonly acceptedRisk?: Record<string, unknown> | null;
}

/** Inserts a finding and, when `runId` is given, its occurrence in that run (as the tenant). */
async function insertFinding(
  tenant: string,
  runId: string | null,
  fixture: FindingFixture = {},
): Promise<string> {
  const id = fixture.id ?? newId();
  const status = fixture.status ?? 'released';
  const publicId = fixture.publicId ?? `fnd_${id.replaceAll('-', '')}`;
  const released = status === 'released';
  await withTenantQuery(tenant, (client) =>
    client.query(
      `INSERT INTO findings
         (id, tenant_id, public_id, fingerprint, title, class, cwe_id, owasp_category, asset_id, location,
          status, severity, run_id, first_seen_run_id, last_seen_run_id, released_by, released_at,
          description, impact, evidence_narrative, accepted_risk, asvs_refs, severity_rationale)
       VALUES ($1, $2, $3, $4, $5, $6, 'CWE-285', 'A01', $7, $8, $9, $10, $11, $11, $11, $12, $13, $14, $15,
               'The response contained the configuration page.', $16,
               '["ASVS v5.0.0-8.2.1"]'::jsonb, 'High impact, no privileges.')`,
      [
        id,
        tenant,
        publicId,
        fingerprint(id),
        fixture.title ?? 'Missing authorisation',
        fixture.class ?? 'broken_access_control',
        ASSET,
        '{"method":"GET","urlTemplate":"/admin","parameter":null,"file":null,"line":null}',
        status,
        fixture.severity === undefined ? cvss4(8.7, 'high') : fixture.severity,
        runId ?? newId(),
        released ? newId() : null,
        released ? FIXED_NOW : null,
        fixture.description === undefined
          ? 'The admin endpoint answers without a session.'
          : fixture.description,
        fixture.impact === undefined ? 'Any visitor reads configuration.' : fixture.impact,
        fixture.acceptedRisk ?? null,
      ],
    ),
  );
  if (runId) {
    await withTenantQuery(tenant, (client) =>
      client.query(
        `INSERT INTO finding_occurrences (id, tenant_id, finding_id, run_id, occurrence_status, detected_at)
         VALUES ($1, $2, $3, $4, 'confirmed', $5)`,
        [newId(), tenant, id, runId, FIXED_NOW],
      ),
    );
  }
  return id;
}

/** Runs a statement set as the tenant (RLS applies), through the app role. */
function withTenantQuery<T>(tenant: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return pgHandle.withTenant(tenant, fn);
}

/** Inserts a run for a tenant with a manifest, a public id, and optionally a finalised coverage manifest. */
async function insertRun(
  tenant: string,
  options: {
    manifest?: unknown;
    publicId?: string | null;
    coverage?: 'none' | 'open' | 'final';
    entries?: unknown;
  } = {},
): Promise<string> {
  const id = newId();
  const publicId =
    options.publicId === undefined ? `run_${id.replaceAll('-', '')}` : options.publicId;
  const runManifest = options.manifest === undefined ? manifest : options.manifest;
  await withTenantQuery(tenant, (client) =>
    client.query('INSERT INTO runs (id, tenant_id, public_id, manifest) VALUES ($1, $2, $3, $4)', [
      id,
      tenant,
      publicId,
      runManifest === null ? null : JSON.stringify(runManifest),
    ]),
  );
  const coverage = options.coverage ?? 'final';
  if (coverage !== 'none') {
    const entries = options.entries ?? [
      { testCaseRef: 'tc_1', status: 'tested', reason: null },
      { testCaseRef: 'tc_2', status: 'not_tested', reason: 'model_declined' },
    ];
    await withTenantQuery(tenant, (client) =>
      client.query(
        'INSERT INTO coverage_manifests (id, tenant_id, run_id, entries, finalised_at) VALUES ($1, $2, $3, $4, $5)',
        [newId(), tenant, id, JSON.stringify(entries), coverage === 'final' ? FIXED_NOW : null],
      ),
    );
  }
  return id;
}

function assemble(runId: string, tenant: string, pageSize?: number): Promise<ReportModel> {
  return assembleReport(runId, {
    db: database,
    tenantId: tenant,
    now: () => FIXED_NOW,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}

beforeAll(async () => {
  pgHandle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pgHandle.appPool);
}, 180_000);

afterAll(async () => {
  await (pgHandle as PostgresHandle | undefined)?.stop();
});

describe('assembleReport against Postgres', () => {
  it('selects released findings of the run only and orders them by severity, then class, then public id', async () => {
    const runId = await insertRun(tenantA);
    const top = await insertFinding(tenantA, runId, {
      severity: cvss4(9.3, 'critical'),
      class: 'zz_last',
      title: 'Top',
    });
    const tieFirst = await insertFinding(tenantA, runId, {
      severity: cvss4(8.7, 'high'),
      class: 'alpha',
      title: 'Tie A',
    });
    const tieSecond = await insertFinding(tenantA, runId, {
      severity: cvss4(8.7, 'high'),
      class: 'beta',
      title: 'Tie B',
    });
    const unscored = await insertFinding(tenantA, runId, {
      severity: null,
      title: 'Unscored',
      description: null,
    });
    // Not selected: a candidate, a finding of another run, and a released one with no occurrence in this run.
    await insertFinding(tenantA, runId, { status: 'candidate', title: 'Candidate' });
    await insertFinding(tenantA, newId(), { title: 'Other run' });
    await insertFinding(tenantA, null, { title: 'Unseen' });

    const model = await assemble(runId, tenantA);
    expect(model.findings.map((finding) => finding.title)).toEqual([
      'Top',
      'Tie A',
      'Tie B',
      'Unscored',
    ]);
    expect(model.findings[0]?.publicId).toBe(`fnd_${top.replaceAll('-', '')}`);
    expect(model.findings[1]?.publicId).toBe(`fnd_${tieFirst.replaceAll('-', '')}`);
    expect(model.findings[2]?.publicId).toBe(`fnd_${tieSecond.replaceAll('-', '')}`);
    expect(model.findings[3]).toMatchObject({
      publicId: `fnd_${unscored.replaceAll('-', '')}`,
      severity: null,
      severityRationale: null,
      narrativePending: true,
    });
    expect(model.findings[0]).toMatchObject({
      narrativePending: false,
      asvsRefs: ['ASVS v5.0.0-8.2.1'],
      severityRationale: 'High impact, no privileges.',
      reproMissing: true,
    });
  });

  it('pages through the same order as one page (keyset over severity, class and public id)', async () => {
    const runId = await insertRun(tenantA);
    for (let index = 0; index < 5; index += 1) {
      await insertFinding(tenantA, runId, {
        severity: cvss4(5 + index, 'medium'),
        class: `class_${index}`,
        title: `Paged ${index}`,
      });
    }
    const onePage = await assemble(runId, tenantA, 500);
    const paged = await assemble(runId, tenantA, 2);
    expect(paged.findings.map((finding) => finding.title)).toEqual(
      onePage.findings.map((finding) => finding.title),
    );
    expect(paged.findings.map((finding) => finding.title)).toEqual([
      'Paged 4',
      'Paged 3',
      'Paged 2',
      'Paged 1',
      'Paged 0',
    ]);
  });

  it('is deterministic: two assemblies of one run differ only in generatedAt', async () => {
    const runId = await insertRun(tenantA);
    await insertFinding(tenantA, runId, { title: 'Stable one' });
    await insertFinding(tenantA, runId, { title: 'Stable two', severity: cvss4(3.1, 'low') });
    const first = await assemble(runId, tenantA);
    const second = await assemble(runId, tenantA);
    expect({ ...first, generatedAt: '' }).toEqual({ ...second, generatedAt: '' });
  });

  it('lists accepted-risk findings in their own section and never among the findings', async () => {
    const runId = await insertRun(tenantA);
    await insertFinding(tenantA, runId, { title: 'Active' });
    await insertFinding(tenantA, runId, {
      status: 'accepted_risk',
      title: 'Accepted',
      acceptedRisk: {
        reason: 'Compensating control in front of the route.',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    const model = await assemble(runId, tenantA);
    expect(model.findings.map((finding) => finding.title)).toEqual(['Active']);
    expect(model.acceptedRisks).toEqual([
      expect.objectContaining({
        title: 'Accepted',
        reason: 'Compensating control in front of the route.',
      }),
    ]);
  });

  it('states the empty report when no finding was released in the run', async () => {
    const runId = await insertRun(tenantA);
    await insertFinding(tenantA, runId, { status: 'candidate' });
    const model = await assemble(runId, tenantA);
    expect(model.findings).toEqual([]);
    expect(model.noReleasedFindingsNote).toBe('No findings were released for this run.');
    expect(model.coverage.totalTestCases).toBe(2);
    expect(model.coverage.notTestedReasons).toEqual({ model_declined: 1 });
  });

  it('embeds the provenance and run identity of the run manifest', async () => {
    const runId = await insertRun(tenantA);
    const model = await assemble(runId, tenantA);
    expect(model.provenance).toEqual(provenance);
    expect(model.run.publicId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(model.run.mode).toBe('grey');
  });

  it('reads a run of another tenant as not found (RLS)', async () => {
    const runId = await insertRun(tenantA);
    await expect(assemble(runId, tenantB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads an unknown run as not found', async () => {
    await expect(assemble(newId(), tenantA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a run whose coverage manifest is not finalised', async () => {
    const runId = await insertRun(tenantA, { coverage: 'open' });
    await expect(assemble(runId, tenantA)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a run that has no coverage manifest at all', async () => {
    const runId = await insertRun(tenantA, { coverage: 'none' });
    await expect(assemble(runId, tenantA)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a run with no manifest, rather than reporting unpinned versions', async () => {
    const runId = await insertRun(tenantA, { manifest: null });
    await expect(assemble(runId, tenantA)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a run with no public id yet', async () => {
    const runId = await insertRun(tenantA, { publicId: null });
    await expect(assemble(runId, tenantA)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a coverage manifest that a finalised run can no longer change (immutable once finalised)', async () => {
    const runId = await insertRun(tenantA);
    const updated = await pgCode(
      withTenantQuery(tenantA, (client) =>
        client.query("UPDATE coverage_manifests SET entries = '[]'::jsonb WHERE run_id = $1", [
          runId,
        ]),
      ),
    );
    expect(updated).toBe('23514');
    const deleted = await pgCode(
      withTenantQuery(tenantA, (client) =>
        client.query('DELETE FROM coverage_manifests WHERE run_id = $1', [runId]),
      ),
    );
    expect(deleted).toBe('42501');
    // The report still reads the unchanged manifest.
    const model = await assemble(runId, tenantA);
    expect(model.coverage.totalTestCases).toBe(2);
  });

  it('keeps the report source inside one tenant: a foreign run id yields no rows', async () => {
    const runId = await insertRun(tenantA);
    const seen = await withReportSource(database, tenantB, (source) => source.run(runId));
    expect(seen).toBeUndefined();
  });
});
