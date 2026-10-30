// Evidence items and the binding of their chain to a finding occurrence (EVIDENCE, #724): append-only streams,
// tenant isolation, write-once grants, CHECK negatives, and the atomic bind and suspect transitions. Runs against
// the real migrations on Postgres 16 (Testcontainers). Run with `pnpm test:int`.

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evidenceChainLink, sha256Hex } from '@blackwing/crypto';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  type AppendEvidenceInput,
  EvidenceRepository,
  ReproArtifactRepository,
} from './evidence.repository.js';
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

function reproRepo(tenant: string) {
  return new ReproArtifactRepository({ db: createDatabase(db.appPool), tenant: () => tenant });
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

  it('refuses a negative or oversize size before it reaches the database', async () => {
    const runId = newId();
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, runId, { size: -1 })),
    ).rejects.toThrow(ValidationError);
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, runId, { size: 5_368_709_121 })),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a content type with Unicode or parameters (allowed-pattern check)', async () => {
    const runId = newId();
    for (const contentType of ['tëxt/plain', 'text/plain; charset=utf-8', 'text']) {
      await expect(
        evidenceRepo(tenantA).append(appendInput(tenantA, runId, { contentType })),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('refuses an object key with Unicode or a dot segment', async () => {
    const runId = newId();
    for (const suffix of ['ünïcode', '../escape']) {
      await expect(
        evidenceRepo(tenantA).append(
          appendInput(tenantA, runId, { objectKey: `${tenantA}/${suffix}` }),
        ),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('refuses a second item with the same object key as a typed conflict', async () => {
    const first = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    await expect(
      evidenceRepo(tenantA).append(appendInput(tenantA, newId(), { objectKey: first.objectKey })),
    ).rejects.toThrow(ConflictError);
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
  it('the runtime role cannot update an immutable column or delete an item (42501)', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    const update = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE evidence_items SET size = 1 WHERE id = $1`, [item.id]),
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

describe('updateHold', () => {
  it('sets legal hold and retention, and leaves the key, digest, size and chain untouched', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    const until = new Date('2030-01-01T00:00:00Z');
    const held = await evidenceRepo(tenantA).updateHold(item.id, {
      legalHold: true,
      retentionUntil: until,
    });
    expect(held.legalHold).toBe(true);
    expect(held.retentionUntil?.toISOString()).toBe(until.toISOString());
    expect(held.objectKey).toBe(item.objectKey);
    expect(held.sha256).toBe(item.sha256);
    expect(held.size).toBe(item.size);
    expect(held.chain).toBe(item.chain);
    const released = await evidenceRepo(tenantA).updateHold(item.id, { retentionUntil: null });
    expect(released.retentionUntil).toBeNull();
    expect(released.legalHold).toBe(true);
  });

  it('refuses to change the object key or the digest, and names only the field', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    for (const field of [{ objectKey: `${tenantA}/swapped` }, { sha256: sha('swap') }]) {
      await expect(
        evidenceRepo(tenantA).updateHold(item.id, { legalHold: true, ...field }),
      ).rejects.toThrow(ValidationError);
    }
    const [after] = await evidenceRepo(tenantA).getMany([item.id]);
    expect(after?.objectKey).toBe(item.objectKey);
    expect(after?.sha256).toBe(item.sha256);
    expect(after?.legalHold).toBe(false);
  });

  it('refuses an empty update', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    await expect(evidenceRepo(tenantA).updateHold(item.id, {})).rejects.toThrow(ValidationError);
  });

  it('is not found for another tenant item, and fails closed without a tenant', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    await expect(evidenceRepo(tenantB).updateHold(item.id, { legalHold: true })).rejects.toThrow(
      NotFoundError,
    );
    const [still] = await evidenceRepo(tenantA).getMany([item.id]);
    expect(still?.legalHold).toBe(false);
    const anonymous = new EvidenceRepository({
      db: createDatabase(db.appPool),
      tenant: () => undefined,
    });
    await expect(anonymous.updateHold(item.id, { legalHold: true })).rejects.toThrow(
      TenantContextMissingError,
    );
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

describe('public ids', () => {
  it('assigns the evd_ public id on append, in the canonical base32 form', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    expect(item.publicId).toMatch(/^evd_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
    expect(item.findingId).toBeNull();
    expect(item.occurrenceId).toBeNull();
  });

  it('refuses a public id without the evd_ prefix (database CHECK)', async () => {
    const runId = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO evidence_items (id, public_id, tenant_id, run_id, sequence, kind, role, object_key, sha256, size, content_type, captured_at, chain)
           VALUES ($1, 'rpa_01fwhe4ydgfk1shh6w1g60eecf', $2, $3, 1, 'response', 'positive', $4, $5, 1, 'text/plain', now(), $5)`,
          [newId(), tenantA, runId, `${tenantA}/${runId}/pid`, sha('pid')],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('refuses a finding link to another tenant (composite foreign key, §8.6)', async () => {
    const { finding: foreign } = await seedBinding(tenantB, 0);
    const runId = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO evidence_items (id, tenant_id, run_id, finding_id, sequence, kind, role, object_key, sha256, size, content_type, captured_at, chain)
           VALUES ($1, $2, $3, $4, 1, 'response', 'positive', $5, $6, 1, 'text/plain', now(), $6)`,
          [newId(), tenantA, runId, foreign.id, `${tenantA}/${runId}/fk`, sha('fk')],
        ),
      ),
    );
    expect(code).toBe('23503');
  });

  it('the runtime role cannot rewrite the object key or the digest of an item (42501)', async () => {
    const item = await evidenceRepo(tenantA).append(appendInput(tenantA, newId()));
    const key = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE evidence_items SET object_key = $2 WHERE id = $1`, [
          item.id,
          `${tenantA}/swapped`,
        ]),
      ),
    );
    const digest = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE evidence_items SET sha256 = $2 WHERE id = $1`, [item.id, sha('swap')]),
      ),
    );
    expect(key).toBe('42501');
    expect(digest).toBe('42501');
    expect((await evidenceRepo(tenantA).getMany([item.id]))[0]?.objectKey).toBe(item.objectKey);
  });
});

describe('repro artifacts', () => {
  const bundleKey = (tenant: string) => `${tenant}/repro/${newId()}.tar.zst`;

  it('records a bundle for a finding and reads it back by id and by finding', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const created = await reproRepo(tenantA).create({
      findingId: finding.id,
      bundleKey: bundleKey(tenantA),
      sha256: sha('bundle'),
      formatVersion: '1.0',
      size: 2048,
    });
    expect(created.publicId).toMatch(/^rpa_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
    expect(await reproRepo(tenantA).get(created.id)).toMatchObject({
      id: created.id,
      findingId: finding.id,
      size: 2048,
    });
    expect((await reproRepo(tenantA).listForFinding(finding.id)).map((row) => row.id)).toEqual([
      created.id,
    ]);
  });

  it('is invisible to another tenant on read and on list', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const created = await reproRepo(tenantA).create({
      findingId: finding.id,
      bundleKey: bundleKey(tenantA),
      sha256: sha('visible'),
      formatVersion: '1.0',
    });
    expect(await reproRepo(tenantB).get(created.id)).toBeUndefined();
    expect(await reproRepo(tenantB).listForFinding(finding.id)).toEqual([]);
  });

  it('refuses a finding of another tenant (not found, never a cross-tenant link)', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    await expect(
      reproRepo(tenantB).create({
        findingId: finding.id,
        bundleKey: bundleKey(tenantB),
        sha256: sha('cross'),
        formatVersion: '1.0',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a duplicate bundle key as a typed conflict', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const key = bundleKey(tenantA);
    await reproRepo(tenantA).create({
      findingId: finding.id,
      bundleKey: key,
      sha256: sha('one'),
      formatVersion: '1.0',
    });
    await expect(
      reproRepo(tenantA).create({
        findingId: finding.id,
        bundleKey: key,
        sha256: sha('two'),
        formatVersion: '1.0',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses an input that breaks the contract: bad digest, traversal key, unknown field', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const base = { findingId: finding.id, bundleKey: bundleKey(tenantA), sha256: sha('ok') };
    await expect(
      reproRepo(tenantA).create({ ...base, sha256: 'NOT-HEX', formatVersion: '1.0' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      reproRepo(tenantA).create({
        ...base,
        bundleKey: `${tenantA}/../escape`,
        formatVersion: '1.0',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      reproRepo(tenantA).create({ ...base, formatVersion: '1.0', body: 'inline' }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a key outside the tenant prefix at the database (CHECK, §8.6)', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    await expect(
      reproRepo(tenantA).create({
        findingId: finding.id,
        bundleKey: `${tenantB}/repro/x`,
        sha256: sha('prefix'),
        formatVersion: '1.0',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('is write-once for the runtime role (42501)', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const created = await reproRepo(tenantA).create({
      findingId: finding.id,
      bundleKey: bundleKey(tenantA),
      sha256: sha('frozen'),
      formatVersion: '1.0',
    });
    const update = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`UPDATE repro_artifacts SET sha256 = $2 WHERE id = $1`, [created.id, sha('x')]),
      ),
    );
    const remove = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(`DELETE FROM repro_artifacts WHERE id = $1`, [created.id]),
      ),
    );
    expect(update).toBe('42501');
    expect(remove).toBe('42501');
  });

  it('fails closed without a tenant context', async () => {
    const { finding } = await seedBinding(tenantA, 0);
    const anonymous = new ReproArtifactRepository({
      db: createDatabase(db.appPool),
      tenant: () => undefined,
    });
    await expect(
      anonymous.create({
        findingId: finding.id,
        bundleKey: bundleKey(tenantA),
        sha256: sha('anon'),
        formatVersion: '1.0',
      }),
    ).rejects.toThrow(TenantContextMissingError);
  });
});
