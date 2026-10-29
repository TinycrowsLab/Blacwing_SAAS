// Findings and finding occurrences (FINDING-001): tenant isolation, fail-closed context, CHECK and composite FK
// behaviour, unique fingerprints and optimistic concurrency, against the real migrations on Postgres 16
// (Testcontainers). Run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { FindingRepository } from './finding.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import { ConcurrencyError } from './repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check_violation, 23503 foreign_key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function repoFor(tenant: string) {
  return new FindingRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

function createInput(overrides: Record<string, unknown> = {}) {
  const runId = newId();
  return {
    fingerprint: fingerprint(newId()),
    title: 'Missing authorisation on /admin',
    class: 'broken_access_control',
    refs: { cwe: ['CWE-22'], owasp: 'A01' },
    assetId: newId(),
    location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
    runId,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    ...overrides,
  };
}

interface RawFinding {
  readonly status?: string;
  readonly baselineStatus?: string | null;
  readonly location?: string;
}

/** Inserts a finding row as the given tenant, bypassing the repository (for CHECK negatives). */
function rawInsert(tenant: string, values: RawFinding = {}): Promise<unknown> {
  const id = newId();
  return db.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO findings
         (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, baseline_status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'raw', 'raw_class', $5, $6, $7, $8, $9, $9, $9, 'CWE-89', 'A03')`,
      [
        id,
        tenant,
        `fnd_${id.replaceAll('-', '')}`,
        fingerprint(id),
        newId(),
        values.location ?? '{"urlTemplate":"/x","method":"GET"}',
        values.status ?? 'candidate',
        values.baselineStatus ?? null,
        newId(),
      ],
    ),
  );
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('create', () => {
  it('stores a candidate with a fnd_ public id, version 0 and an NFC-normalised title', async () => {
    const row = await repoFor(tenantA).create(createInput({ title: 'Café checkout: no authz' }));
    expect(row.status).toBe('candidate');
    expect(row.publicId).toMatch(/^fnd_/);
    expect(row.tenantId).toBe(tenantA);
    expect(row.stateVersion).toBe(0);
    expect(row.title).toBe('Café checkout: no authz');
    expect(row.confidence).toBeNull();
    expect(row.severity).toBeNull();
  });

  it('stores a severity that follows from its vector and refuses one that does not (FINDING-005)', async () => {
    const repo = repoFor(tenantA);
    const severity = {
      cvss4: {
        vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
        score: 8.7,
        severity: 'high',
        nomenclature: 'CVSS-B',
      },
    };
    const row = await repo.create(createInput({ severity }));
    expect(row.severity).toEqual(severity);
    const forged = createInput({
      severity: { cvss4: { ...severity.cvss4, score: 9.8, severity: 'critical' } },
    });
    await expect(repo.create(forged)).rejects.toMatchObject({
      code: 'CVSS_VECTOR_SCORE_MISMATCH',
    });
  });

  it('refuses a second finding with the same fingerprint in the same tenant (dedup backbone)', async () => {
    const repo = repoFor(tenantA);
    const input = createInput();
    await repo.create(input);
    await expect(repo.create({ ...input, title: 'a different title' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('classifies from the curated mapping and records the mapping version (FINDING-004)', async () => {
    const row = await repoFor(tenantA).create(
      createInput({ class: 'webapi.injection.sql', refs: undefined }),
    );
    expect(row).toMatchObject({
      cweId: 'CWE-89',
      owaspCategory: 'A03',
      mappingVersion: '1.0.0',
      unmapped: false,
      classification: { cweCandidates: ['CWE-89'], apiTop10: null, wstg: ['WSTG-INPV-05'] },
    });
  });

  it('prefers the specialist-declared CWE over the curated default and keeps the default as a candidate', async () => {
    const row = await repoFor(tenantA).create(
      createInput({ class: 'webapi.injection.sql', refs: { cwe: ['CWE-79'] } }),
    );
    expect(row.cweId).toBe('CWE-79');
    expect(row.classification).toMatchObject({ cweCandidates: ['CWE-79', 'CWE-89'] });
  });

  it('flags a finding with no known CWE or OWASP category as unmapped, without inventing an id', async () => {
    const row = await repoFor(tenantA).create(
      createInput({ class: 'raw.unknown_class', refs: {} }),
    );
    expect(row).toMatchObject({ cweId: null, owaspCategory: null, unmapped: true });
    expect(row.mappingVersion).toBe('1.0.0');
  });

  it('refuses an unmapped=false row that has no CWE or OWASP category (findings_mapped_check)', async () => {
    const id = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id)
           VALUES ($1, $2, $3, $4, 'raw', 'raw_class', $5, '{"urlTemplate":"/x"}', 'candidate', $6, $6, $6)`,
          [id, tenantA, `fnd_${id.replaceAll('-', '')}`, fingerprint(id), newId(), newId()],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('allows the same fingerprint in another tenant', async () => {
    const shared = fingerprint('shared-across-tenants');
    await repoFor(tenantA).create(createInput({ fingerprint: shared }));
    const other = await repoFor(tenantB).create(createInput({ fingerprint: shared }));
    expect(other.tenantId).toBe(tenantB);
  });
});

describe('tenant isolation', () => {
  it('a finding under tenant A is invisible to tenant B (RLS and the tenant filter)', async () => {
    const row = await repoFor(tenantA).create(createInput());
    expect(await repoFor(tenantB).findById(row.id)).toBeUndefined();
    const visibleToB = await repoFor(tenantB).list({ limit: 200 });
    expect(visibleToB.items.map((item) => item.id)).not.toContain(row.id);
    await expect(repoFor(tenantB).update(row.id, 0, { status: 'validating' })).rejects.toThrow(
      NotFoundError,
    );
    expect(await repoFor(tenantA).findById(row.id)).toMatchObject({ status: 'candidate' });
  });

  it('a raw insert with another tenant id is refused by RLS (fails closed, no cross-tenant write)', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id)
           VALUES ($1, $2, $3, $4, 'x', 'x', $5, '{"urlTemplate":"/x"}', 'candidate', $5, $5, $5)`,
          [newId(), tenantB, `fnd_${newId().replaceAll('-', '')}`, fingerprint(newId()), newId()],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a composite FK stops an occurrence naming another tenant finding', async () => {
    const row = await repoFor(tenantA).create(createInput());
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO finding_occurrences (id, tenant_id, finding_id, run_id, occurrence_status, detected_at)
           VALUES ($1, $2, $3, $4, 'detected', now())`,
          [newId(), tenantB, row.id, newId()],
        ),
      ),
    );
    // The FK check ignores RLS: no finding of tenant B has this id, so the composite key is violated.
    expect(code).toBe('23503');
  });

  it('the runtime role cannot delete findings (lifecycle, not removal)', async () => {
    const row = await repoFor(tenantA).create(createInput());
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query(`DELETE FROM findings WHERE id = $1`, [row.id])),
    );
    expect(code).toBe('42501');
  });
});

describe('database CHECK constraints (the backstop behind the repository)', () => {
  it('refuses an unknown status and an unknown baseline status', async () => {
    expect(await pgCode(rawInsert(tenantA, { status: 'pwned' }))).toBe('23514');
    expect(await pgCode(rawInsert(tenantA, { baselineStatus: 'stale' }))).toBe('23514');
  });

  it('refuses a location with no URL template and no file', async () => {
    expect(await pgCode(rawInsert(tenantA, { location: '{"method":"GET"}' }))).toBe('23514');
  });

  it('refuses released without a release record, and accepted_risk without its reason', async () => {
    expect(await pgCode(rawInsert(tenantA, { status: 'released' }))).toBe('23514');
    expect(await pgCode(rawInsert(tenantA, { status: 'accepted_risk' }))).toBe('23514');
  });

  it('accepts a well-formed row (the negatives above are not false positives)', async () => {
    expect(await pgCode(rawInsert(tenantA, { status: 'confirmed', baselineStatus: 'new' }))).toBe(
      undefined,
    );
  });

  it('refuses a status change to released through update when no release is recorded', async () => {
    const row = await repoFor(tenantA).create(createInput());
    await expect(repoFor(tenantA).update(row.id, 0, { status: 'released' })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('update and optimistic concurrency', () => {
  it('bumps state_version on a matching update and refuses a stale one with a 412', async () => {
    const repo = repoFor(tenantA);
    const row = await repo.create(createInput());
    const updated = await repo.update(row.id, 0, { status: 'validating' });
    expect(updated).toMatchObject({ status: 'validating', stateVersion: 1 });
    await expect(repo.update(row.id, 0, { status: 'confirmed' })).rejects.toThrow(ConcurrencyError);
  });

  it('a missing finding is NotFoundError, not a version error', async () => {
    await expect(repoFor(tenantA).update(newId(), 0, { status: 'validating' })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('list pagination', () => {
  it('pages in (created_at, id) order and ends with a null cursor', async () => {
    const repo = repoFor(tenantB);
    const created = [];
    for (let i = 0; i < 3; i += 1) created.push((await repo.create(createInput())).id);
    const first = await repo.list({ limit: 2, status: 'candidate' });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await repo.list({
      limit: 2,
      status: 'candidate',
      cursor: first.nextCursor ?? '',
    });
    const seen = [...first.items, ...second.items].map((item) => item.id);
    for (const id of created) expect(seen).toContain(id);
    expect(second.nextCursor).toBeNull();
  });
});

describe('occurrences', () => {
  it('records one occurrence per (finding, run) and refuses a repeat', async () => {
    const repo = repoFor(tenantA);
    const row = await repo.create(createInput());
    const runId = newId();
    await repo.addOccurrence({
      findingId: row.id,
      runId,
      occurrenceStatus: 'detected',
      detectedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await expect(
      repo.addOccurrence({
        findingId: row.id,
        runId,
        occurrenceStatus: 'detected',
        detectedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ).rejects.toThrow(ConflictError);
    const occurrences = await repo.listOccurrences(row.id);
    expect(occurrences).toHaveLength(1);
    expect(await repoFor(tenantB).listOccurrences(row.id)).toEqual([]);
  });
});
