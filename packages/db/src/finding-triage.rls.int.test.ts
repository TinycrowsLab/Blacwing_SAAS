// Finding triage (TRIAGE-001): the Gate 3 transitions out of `confirmed`, their gate decision and audit rows, the
// state_version compare-and-set, tenant isolation and the duplicate_of constraints, against the real migrations on
// Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { publicId } from './columns.js';
import { FindingTriageRepository, type FindingTriageRequest } from './finding-triage.repository.js';
import { FindingRepository, type FindingRow } from './finding.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import { ConcurrencyError } from './repository.js';

import type { TriageAuditIntent } from '@blackwing/domain';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const actor = newId();

/** Audit hooks record what they were given, so the tests can assert the events of each transition. */
const findingAudits: (TriageAuditIntent & { tenantId: string })[] = [];
const gateAudits: { subjectId: string; decision: string }[] = [];

const SEVERITY = {
  cvss4: {
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 8.7,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
};

/** Postgres error code of a rejected promise (23514 check, 23503 foreign key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** The refusal of a rejected promise (fails the test when the promise resolves). */
async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function sha(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function findingRepo(tenant: string) {
  return new FindingRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

function triageRepo(): FindingTriageRepository {
  return new FindingTriageRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      findingAudits.push(event);
    },
    gateAudit: (event) => {
      gateAudits.push({ subjectId: event.subjectId, decision: event.decision });
    },
  });
}

/** An asset of `type` in `tenant`, inserted under that tenant's context. Returns its id. */
async function asset(tenant: string, type: 'web_app' | 'api' = 'web_app'): Promise<string> {
  const id = newId();
  await db.withTenant(tenant, (tx) =>
    tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id)
       VALUES ($1, $2, $3, $4, 'Shop', $5::jsonb, 'staging', $6)`,
      [
        id,
        tenant,
        publicId('asset', id),
        type,
        JSON.stringify([{ kind: 'url', value: 'https://app.example.test' }]),
        // Owners are not read by triage; a random uuid satisfies the not-null column.
        newId(),
      ],
    ),
  );
  return id;
}

/**
 * A finding in `tenant` at `confirmed`. `scored` records a severity; `evidence` binds an occurrence with an evidence
 * chain head (the release precondition). Returns the row as stored after the status change.
 */
async function confirmedFinding(
  tenant: string,
  options: { assetId?: string; scored?: boolean; evidence?: boolean } = {},
): Promise<FindingRow> {
  const repo = findingRepo(tenant);
  const runId = newId();
  const created = await repo.create({
    fingerprint: sha(newId()),
    title: 'Missing authorisation on /admin',
    class: 'broken_access_control',
    refs: { cwe: ['CWE-22'], owasp: 'A01' },
    assetId: options.assetId ?? newId(),
    location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
    runId,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    ...(options.scored === false ? {} : { severity: SEVERITY }),
  });
  const confirmed = await repo.update(created.id, created.stateVersion, { status: 'confirmed' });
  if (options.evidence !== false) {
    await repo.addOccurrence({
      findingId: confirmed.id,
      runId,
      occurrenceStatus: 'detected',
      evidenceChainHead: sha(`chain-${newId()}`),
      detectedAt: new Date(),
    });
  }
  return confirmed;
}

/** One triage transition at the finding's current version. */
function triage(
  tenant: string,
  finding: Pick<FindingRow, 'id' | 'stateVersion'>,
  overrides: Partial<FindingTriageRequest> = {},
): Promise<{ row: FindingRow; from: string }> {
  return triageRepo().transition(tenant, {
    findingId: finding.id,
    expectedStateVersion: finding.stateVersion,
    to: 'rejected_false_positive',
    actorId: actor,
    reason: 'Not reproducible on replay',
    now: new Date(),
    ...overrides,
  });
}

async function storedFinding(tenant: string, id: string) {
  return findingRepo(tenant).findById(id);
}

/** The gate decision rows of one finding, as the tenant sees them. */
async function gateRowsOf(tenant: string, findingId: string) {
  const result = await db.withTenant(tenant, (tx) =>
    tx.query<{
      gate: number;
      decision: string;
      subject_type: string;
      actor_id: string;
      auto: boolean;
    }>(
      `SELECT gate, decision, subject_type, actor_id, auto FROM authz_gate_decisions WHERE subject_id = $1`,
      [findingId],
    ),
  );
  return result.rows;
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('release', () => {
  it('releases a confirmed, scored, evidenced finding and records the release, its gate row and its audit', async () => {
    const finding = await confirmedFinding(tenantA, { assetId: await asset(tenantA) });
    const { row, from } = await triage(tenantA, finding, {
      to: 'released',
      reason: 'Replayed and confirmed',
    });

    expect(from).toBe('confirmed');
    expect(row).toMatchObject({
      status: 'released',
      stateVersion: finding.stateVersion + 1,
      releasedBy: actor,
      duplicateOf: null,
      acceptedRisk: null,
    });
    expect(row.releasedAt).toBeInstanceOf(Date);
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'released' });

    expect(await gateRowsOf(tenantA, finding.id)).toEqual([
      { gate: 3, decision: 'approved', subject_type: 'finding', actor_id: actor, auto: false },
    ]);
    expect(gateAudits).toContainEqual({ subjectId: finding.id, decision: 'approved' });
    expect(findingAudits).toContainEqual(
      expect.objectContaining({
        action: 'finding.released',
        findingId: finding.id,
        tenantId: tenantA,
        from: 'confirmed',
        to: 'released',
        actorId: actor,
      }),
    );
  });

  it('refuses a release of an unscored finding and of one without bound evidence, and changes nothing', async () => {
    const unscored = await confirmedFinding(tenantA, { scored: false });
    const unevidenced = await confirmedFinding(tenantA, { evidence: false });
    for (const finding of [unscored, unevidenced]) {
      const refusal = await refusalOf(triage(tenantA, finding, { to: 'released' }));
      expect(refusal.code).toBe('TRIAGE_PRECONDITION_FAILED');
      expect(await storedFinding(tenantA, finding.id)).toMatchObject({
        status: 'confirmed',
        stateVersion: finding.stateVersion,
      });
      expect(await gateRowsOf(tenantA, finding.id)).toEqual([]);
    }
  });
});

describe('reject as false positive', () => {
  it('rejects a confirmed finding with a rejected gate row and a finding.rejected audit', async () => {
    const finding = await confirmedFinding(tenantA);
    const { row } = await triage(tenantA, finding, { reason: 'Benign response on retry' });
    expect(row).toMatchObject({ status: 'rejected_false_positive', releasedBy: null });
    expect(await gateRowsOf(tenantA, finding.id)).toEqual([
      { gate: 3, decision: 'rejected', subject_type: 'finding', actor_id: actor, auto: false },
    ]);
    expect(findingAudits).toContainEqual(
      expect.objectContaining({ action: 'finding.rejected', findingId: finding.id }),
    );
  });

  it('refuses a blank reason with TRIAGE_REASON_REQUIRED and changes nothing', async () => {
    const finding = await confirmedFinding(tenantA);
    const refusal = await refusalOf(triage(tenantA, finding, { reason: '   ' }));
    expect(refusal.code).toBe('TRIAGE_REASON_REQUIRED');
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
    expect(await gateRowsOf(tenantA, finding.id)).toEqual([]);
  });
});

describe('accepted risk', () => {
  it('stores the reason and the normalised UTC expiry, and the status records the risk', async () => {
    const finding = await confirmedFinding(tenantA);
    const { row } = await triage(tenantA, finding, {
      to: 'accepted_risk',
      reason: 'Compensating WAF rule in place',
      expiresAt: '2999-01-01T02:00:00+02:00',
    });
    expect(row.status).toBe('accepted_risk');
    expect(row.acceptedRisk).toEqual({
      reason: 'Compensating WAF rule in place',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(await gateRowsOf(tenantA, finding.id)).toEqual([
      { gate: 3, decision: 'approved', subject_type: 'finding', actor_id: actor, auto: false },
    ]);
    expect(findingAudits).toContainEqual(
      expect.objectContaining({ action: 'finding.risk_accepted', findingId: finding.id }),
    );
  });

  it('refuses an accepted risk with no expiry, a past expiry or an offsetless one', async () => {
    for (const expiresAt of [undefined, '2001-01-01T00:00:00.000Z', '2999-01-01T00:00:00']) {
      const finding = await confirmedFinding(tenantA);
      const overrides: Partial<FindingTriageRequest> =
        expiresAt === undefined ? { to: 'accepted_risk' } : { to: 'accepted_risk', expiresAt };
      const refusal = await refusalOf(triage(tenantA, finding, overrides));
      expect(refusal.code).toBe('TRIAGE_EXPIRY_INVALID');
      expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
    }
  });
});

describe('duplicate', () => {
  it('links a duplicate to a same-tenant canonical finding of the same asset class, without releasing it', async () => {
    const assetId = await asset(tenantA);
    const canonical = await confirmedFinding(tenantA, { assetId });
    const duplicate = await confirmedFinding(tenantA, { assetId });

    const { row } = await triage(tenantA, duplicate, {
      to: 'duplicate',
      canonicalFindingId: canonical.id,
      reason: 'Same root cause as the canonical finding',
    });
    expect(row).toMatchObject({ status: 'duplicate', duplicateOf: canonical.id, releasedBy: null });
    expect(findingAudits).toContainEqual(
      expect.objectContaining({ action: 'finding.marked_duplicate', findingId: duplicate.id }),
    );
  });

  it('refuses a canonical finding of another asset class', async () => {
    const canonical = await confirmedFinding(tenantA, { assetId: await asset(tenantA, 'api') });
    const duplicate = await confirmedFinding(tenantA, { assetId: await asset(tenantA, 'web_app') });
    const refusal = await refusalOf(
      triage(tenantA, duplicate, { to: 'duplicate', canonicalFindingId: canonical.id }),
    );
    expect(refusal.code).toBe('TRIAGE_CANONICAL_INVALID');
    expect(await storedFinding(tenantA, duplicate.id)).toMatchObject({
      status: 'confirmed',
      duplicateOf: null,
    });
  });

  it('refuses a canonical finding that belongs to another tenant, as if it did not exist', async () => {
    const assetB = await asset(tenantB);
    const foreign = await confirmedFinding(tenantB, { assetId: assetB });
    const assetA = await asset(tenantA);
    const duplicate = await confirmedFinding(tenantA, { assetId: assetA });
    const refusal = await refusalOf(
      triage(tenantA, duplicate, { to: 'duplicate', canonicalFindingId: foreign.id }),
    );
    expect(refusal.code).toBe('TRIAGE_CANONICAL_INVALID');
    expect(refusal.detail).not.toContain(foreign.id);
    expect(await storedFinding(tenantA, duplicate.id)).toMatchObject({
      status: 'confirmed',
      duplicateOf: null,
    });
  });

  it('refuses a finding as its own canonical finding', async () => {
    const finding = await confirmedFinding(tenantA, { assetId: await asset(tenantA) });
    const refusal = await refusalOf(
      triage(tenantA, finding, { to: 'duplicate', canonicalFindingId: finding.id }),
    );
    expect(refusal.code).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it('refuses to make a finding a duplicate when another finding already duplicates it (no chains)', async () => {
    const assetId = await asset(tenantA);
    const c = await confirmedFinding(tenantA, { assetId });
    const b = await confirmedFinding(tenantA, { assetId });
    const a = await confirmedFinding(tenantA, { assetId });
    await triage(tenantA, a, { to: 'duplicate', canonicalFindingId: b.id });
    const refused = await refusalOf(
      triage(tenantA, b, { to: 'duplicate', canonicalFindingId: c.id }),
    );
    expect(refused.code).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it('refuses a canonical finding that is itself a duplicate', async () => {
    const assetId = await asset(tenantA);
    const c = await confirmedFinding(tenantA, { assetId });
    const b = await confirmedFinding(tenantA, { assetId });
    await triage(tenantA, b, { to: 'duplicate', canonicalFindingId: c.id });
    const a = await confirmedFinding(tenantA, { assetId });
    const refused = await refusalOf(
      triage(tenantA, a, { to: 'duplicate', canonicalFindingId: b.id }),
    );
    expect(refused.code).toBe('TRIAGE_CANONICAL_INVALID');
  });
});

describe('state_version and concurrency', () => {
  it('refuses a stale expectedStateVersion with ConcurrencyError and changes nothing', async () => {
    const finding = await confirmedFinding(tenantA);
    const refusal = await refusalOf(
      triage(tenantA, { id: finding.id, stateVersion: finding.stateVersion - 1 }),
    );
    expect(refusal).toBeInstanceOf(ConcurrencyError);
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
    expect(await gateRowsOf(tenantA, finding.id)).toEqual([]);
  });

  it('lets exactly one of two concurrent releases win: the other gets ConcurrencyError, no second release', async () => {
    const finding = await confirmedFinding(tenantA, { assetId: await asset(tenantA) });
    const repo = triageRepo();
    const request = (to: 'released' | 'rejected_false_positive'): FindingTriageRequest => ({
      findingId: finding.id,
      expectedStateVersion: finding.stateVersion,
      to,
      actorId: actor,
      reason: 'Racing decision',
      now: new Date(),
    });

    const outcomes = await Promise.allSettled([
      repo.transition(tenantA, request('released')),
      repo.transition(tenantA, request('rejected_false_positive')),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser: unknown = rejected[0]?.reason;
    expect(loser).toBeInstanceOf(ConcurrencyError);

    // One decision was recorded, and the finding carries that winner's status only.
    const stored = await storedFinding(tenantA, finding.id);
    expect(stored).toMatchObject({ stateVersion: finding.stateVersion + 1 });
    expect(['released', 'rejected_false_positive']).toContain(stored?.status);
    expect(await gateRowsOf(tenantA, finding.id)).toHaveLength(1);
  });

  it('refuses a second triage of a finding that is already closed as an illegal transition', async () => {
    const finding = await confirmedFinding(tenantA, { assetId: await asset(tenantA) });
    const { row } = await triage(tenantA, finding, { to: 'released' });
    const refusal = await refusalOf(triage(tenantA, row, { to: 'rejected_false_positive' }));
    expect(refusal.code).toBe('FINDING_ILLEGAL_TRANSITION');
    expect(await gateRowsOf(tenantA, finding.id)).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it('a finding of tenant A cannot be triaged from tenant B, and the answer is not found', async () => {
    const finding = await confirmedFinding(tenantA);
    const refusal = await refusalOf(triage(tenantB, finding));
    expect(refusal).toBeInstanceOf(NotFoundError);
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
    expect(await gateRowsOf(tenantA, finding.id)).toEqual([]);
  });

  it('fails closed without a tenant context', async () => {
    const finding = await confirmedFinding(tenantA);
    const refusal = await refusalOf(triage('', finding));
    expect(refusal.code).toBe('TENANT_CONTEXT_MISSING');
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
  });

  it('refuses a malformed request at the boundary, before any query', async () => {
    const finding = await confirmedFinding(tenantA);
    const refusal = await refusalOf(
      triage(tenantA, finding, { to: 'fixed' as FindingTriageRequest['to'] }),
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(await storedFinding(tenantA, finding.id)).toMatchObject({ status: 'confirmed' });
  });
});

describe('database constraints behind the duplicate link', () => {
  it('refuses a duplicate_of on a finding that is not a duplicate, and a duplicate without one', async () => {
    const finding = await confirmedFinding(tenantA);
    const other = await confirmedFinding(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE findings SET duplicate_of = $2 WHERE id = $1`, [finding.id, other.id]),
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE findings SET status = 'duplicate' WHERE id = $1`, [finding.id]),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a finding whose duplicate_of is itself', async () => {
    const finding = await confirmedFinding(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE findings SET status = 'duplicate', duplicate_of = id WHERE id = $1`, [
            finding.id,
          ]),
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a duplicate_of that names another tenant finding (composite FK, not RLS)', async () => {
    const foreign = await confirmedFinding(tenantB);
    const finding = await confirmedFinding(tenantA);
    expect(
      await pgCode(
        db.withTenant(tenantA, (tx) =>
          tx.query(`UPDATE findings SET status = 'duplicate', duplicate_of = $2 WHERE id = $1`, [
            finding.id,
            foreign.id,
          ]),
        ),
      ),
    ).toBe('23503');
  });
});
