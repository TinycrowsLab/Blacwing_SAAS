// Evidence items and the binding of their chain to a finding occurrence (EVIDENCE, #724): append-only streams,
// tenant isolation, write-once grants, CHECK negatives, and the atomic bind and suspect transitions. Runs against
// the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evidenceChainLink, sha256Hex } from '@blackwing/crypto';
import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { type AppendEvidenceInput, EvidenceRepository } from './evidence.repository.js';
import { FindingRepository } from './finding.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import { ConcurrencyError } from './repository.js';

import type { EvidenceChainRef } from '@blackwing/contracts';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23514 check, 23505 unique, 42501 privilege or RLS). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function evidenceRepo(tenant: string) {
  return new EvidenceRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

function findingRepo(tenant: string) {
  return new FindingRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
}

function sha(label: string): string {
  return sha256Hex(label);
}

const BODY_BYTES = 12;

/** Input for `append`: a distinct object key under the tenant prefix and the body's digest. */
function appendInput(
  tenant: string,
  runId: string,
  overrides: Record<string, unknown> = {},
): AppendEvidenceInput {
  const body = randomBytes(BODY_BYTES).toString('hex');
  return {
    runId,
    kind: 'response',
    role: 'positive',
    objectKey: `${tenant}/${runId}/${newId()}`,
    sha256: sha(body),
    size: Buffer.byteLength(body),
    contentType: 'text/plain',
    capturedAt: new Date('2026-10-30T00:00:00Z'),
    ...overrides,
  };
}

/** A finding with one occurrence, and `count` evidence items appended to a fresh run. */
async function seedBinding(tenant: string, count: number) {
  const runId = newId();
  const finding = await findingRepo(tenant).create({
    fingerprint: sha(newId()),
    title: 'Error-based SQL injection on /search',
    class: 'webapi.injection.sql',
    refs: { cwe: ['CWE-89'], owasp: 'A03' },
    assetId: newId(),
    location: { method: 'GET', urlTemplate: '/search', parameter: 'q', file: null, line: null },
    runId,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
  });
  const occurrence = await findingRepo(tenant).addOccurrence({
    findingId: finding.id,
    runId,
    occurrenceStatus: 'candidate',
    detectedAt: new Date('2026-10-30T00:00:00Z'),
  });
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push(await evidenceRepo(tenant).append(appendInput(tenant, runId)));
  }
  return { finding, occurrence, items };
}

function refsOf(
  items: { id: string; objectKey: string; sha256: string; chain: string }[],
): EvidenceChainRef[] {
  return items.map((item) => ({
    evidenceId: item.id,
    objectKey: item.objectKey,
    sha256: item.sha256,
    chain: item.chain,
  }));
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('append', () => {
  it('starts a stream at sequence 1 with no previous link and links each later item to the one before', async () => {
    const runId = newId();
    const first = await evidenceRepo(tenantA).append(appendInput(tenantA, runId));
    const second = await evidenceRepo(tenantA).append(appendInput(tenantA, runId));
    expect(first.sequence).toBe(1);
    expect(first.prevChain).toBeNull();
    expect(second.sequence).toBe(2);
    expect(second.prevChain).toBe(first.chain);
    expect(first.chain).toBe(
      evidenceChainLink({
        prevChain: null,
        sha256: first.sha256,
        kind: first.kind,
        role: first.role,
        size: first.size,
        objectKey: first.objectKey,
      }),
    );
  });

  it('keeps each run as its own stream', async () => {
    const other = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    expect(other.sequence).toBe(1);
    expect(other.prevChain).toBeNull();
  });

  it('never forks the chain under concurrent appends to one run', async () => {
    const runId = newId();
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => evidenceRepo(tenantA).append(appendInput(tenantA, runId))),
    );
    const sequences = rows.map((row) => row.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    const byPosition = [...rows].sort((a, b) => a.sequence - b.sequence);
    for (const [index, row] of byPosition.entries()) {
      expect(row.prevChain).toBe(index === 0 ? null : byPosition[index - 1]?.chain);
    }
  });

  it('refuses a digest that is not lowercase hex SHA-256, and an unknown kind', async () => {
    const runId = newId();
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, runId, { sha256: 'XYZ' })),
    ).rejects.toThrow(ValidationError);
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, runId, { kind: 'vibes' })),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an unknown field, so an inline body cannot be stored', async () => {
    await expect(
      evidenceRepo(tenantA).append({
        ...appendInput(tenantA, newId()),
        body: 'inline',
      } as AppendEvidenceInput),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an object key outside the tenant prefix (database CHECK, §8.6)', async () => {
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, newId(), { objectKey: `${tenantB}/x/1` })),
    ).rejects.toThrow(ValidationError);
  });
});

describe('tenant isolation', () => {
  it('items under tenant A are invisible to tenant B', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    expect(await evidenceRepo(tenantB).getMany([item.id])).toEqual([]);
    expect(await evidenceRepo(tenantA).getMany([item.id])).toHaveLength(1);
  });

  it('a raw insert naming another tenant is refused by RLS', async () => {
    const runId = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO evidence_items (id, tenant_id, run_id, sequence, kind, role, object_key, sha256, size, content_type, captured_at, chain)
           VALUES ($1, $2, $3, 1, 'response', 'positive', $4, $5, 1, 'text/plain', now(), $5)`,
          [newId(), tenantB, runId, `${tenantB}/${runId}/raw`, sha('raw')],
        ),
      ),
    );
    expect(code).toBe('42501');
  });
});

describe('write-once', () => {
  it('the runtime role cannot update or delete an item (42501)', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    const update = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE evidence_items SET legal_hold = true WHERE id = $1`, [item.id]),
      ),
    );
    const remove = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`DELETE FROM evidence_items WHERE id = $1`, [item.id]),
      ),
    );
    expect(update).toBe('42501');
    expect(remove).toBe('42501');
  });

  it('the first item of a stream must carry no previous link (database CHECK)', async () => {
    const runId = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO evidence_items (id, tenant_id, run_id, sequence, kind, role, object_key, sha256, size, content_type, captured_at, prev_chain, chain)
           VALUES ($1, $2, $3, 1, 'response', 'positive', $4, $5, 1, 'text/plain', now(), $6, $5)`,
          [newId(), tenantA, runId, `${tenantA}/${runId}/first`, sha('first'), sha('prev')],
        ),
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('bindChain', () => {
  it('records the ordered chain on the occurrence and confirms the finding', async () => {
    const { finding, occurrence, items } = await seedBinding(tenantA, 4);
    const refs = refsOf(items);
    const outcome = await evidenceRepo(tenantA).bindChain({
      findingId: finding.id,
      occurrenceId: occurrence.id,
      expectedStateVersion: finding.stateVersion,
      refs,
    });
    expect(outcome).toBe('bound');
    const found = await evidenceRepo(tenantA).getFindingForBinding(finding.id, occurrence.id);
    expect(found?.finding).toMatchObject({
      status: 'confirmed',
      stateVersion: finding.stateVersion + 1,
    });
    expect(found?.occurrence.evidenceRefs).toEqual(refs);
    const row = await findingRepo(tenantA).listOccurrences(finding.id);
    expect(row[0]).toMatchObject({
      occurrenceStatus: 'confirmed',
      evidenceChainHead: items.at(-1)?.chain,
    });
  });

  it('is idempotent for the same chain, and refuses a different one', async () => {
    const { finding, occurrence, items } = await seedBinding(tenantA, 4);
    const refs = refsOf(items);
    const repo = evidenceRepo(tenantA);
    await repo.bindChain({
      findingId: finding.id,
      occurrenceId: occurrence.id,
      expectedStateVersion: finding.stateVersion,
      refs,
    });
    expect(
      await repo.bindChain({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion + 1,
        refs,
      }),
    ).toBe('already_bound');
    const other = refsOf(items.slice(0, 2));
    await expect(
      repo.bindChain({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion + 1,
        refs: other,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a stale state version without writing', async () => {
    const { finding, occurrence, items } = await seedBinding(tenantA, 4);
    await expect(
      evidenceRepo(tenantA).bindChain({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion + 5,
        refs: refsOf(items),
      }),
    ).rejects.toThrow(ConcurrencyError);
    const found = await evidenceRepo(tenantA).getFindingForBinding(finding.id, occurrence.id);
    expect(found?.occurrence.evidenceRefs).toEqual([]);
    expect(found?.finding.status).toBe('candidate');
  });

  it('refuses a finding that is not awaiting validation', async () => {
    const { finding, occurrence, items } = await seedBinding(tenantA, 4);
    await evidenceRepo(tenantA).markSuspected({
      findingId: finding.id,
      occurrenceId: occurrence.id,
      expectedStateVersion: finding.stateVersion,
    });
    await expect(
      evidenceRepo(tenantA).bindChain({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion + 1,
        refs: refsOf(items),
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('is invisible across tenants: another tenant cannot bind or read the occurrence', async () => {
    const { finding, occurrence, items } = await seedBinding(tenantA, 4);
    expect(
      await evidenceRepo(tenantB).getFindingForBinding(finding.id, occurrence.id),
    ).toBeUndefined();
    await expect(
      evidenceRepo(tenantB).bindChain({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion,
        refs: refsOf(items),
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('legal hold', () => {
  it('binding held evidence leaves every item and its hold exactly as they were', async () => {
    const { finding, occurrence } = await seedBinding(tenantA, 0);
    const runId = newId();
    const held = [];
    for (let index = 0; index < 4; index += 1) {
      held.push(
        await evidenceRepo(tenantA).append(appendInput(tenantA, runId, { legalHold: true })),
      );
    }
    await evidenceRepo(tenantA).bindChain({
      findingId: finding.id,
      occurrenceId: occurrence.id,
      expectedStateVersion: finding.stateVersion,
      refs: refsOf(held),
    });
    const after = await evidenceRepo(tenantA).getMany(held.map((item) => item.id));
    expect(after.map((item) => item.legalHold)).toEqual([true, true, true, true]);
    expect(after.map((item) => item.chain)).toEqual(held.map((item) => item.chain));
  });
});

describe('markSuspected', () => {
  it('marks the finding and occurrence suspected and binds nothing', async () => {
    const { finding, occurrence } = await seedBinding(tenantA, 0);
    await evidenceRepo(tenantA).markSuspected({
      findingId: finding.id,
      occurrenceId: occurrence.id,
      expectedStateVersion: finding.stateVersion,
    });
    const found = await evidenceRepo(tenantA).getFindingForBinding(finding.id, occurrence.id);
    expect(found?.finding).toMatchObject({
      status: 'suspected',
      stateVersion: finding.stateVersion + 1,
    });
    expect(found?.occurrence.evidenceRefs).toEqual([]);
    expect((await findingRepo(tenantA).listOccurrences(finding.id))[0]?.occurrenceStatus).toBe(
      'suspected',
    );
  });

  it('refuses a stale version', async () => {
    const { finding, occurrence } = await seedBinding(tenantA, 0);
    await expect(
      evidenceRepo(tenantA).markSuspected({
        findingId: finding.id,
        occurrenceId: occurrence.id,
        expectedStateVersion: finding.stateVersion + 2,
      }),
    ).rejects.toThrow(ConcurrencyError);
  });
});
