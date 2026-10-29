// Assessment requests and input manifests (SCOPE-001): tenant isolation, fail-closed context, CHECK and FK
// behaviour, the status machine and its audit writes, against the real migrations on Postgres 16
// (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import {
  type AssessmentRequestAuditEvent,
  AssessmentRequestRepository,
  type AssessmentRequestRepositoryOptions,
} from './assessment-request.repository.js';
import { createDatabase, migrateDatabase } from './index.js';
import { ConcurrencyError, ForeignKeyError } from './repository.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const requester = newId();

/** Postgres error code of a rejected promise (23514 check_violation, 23503 foreign_key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

function makeRepo(
  overrides: Partial<AssessmentRequestRepositoryOptions> = {},
  tenant: string = tenantA,
) {
  const events: AssessmentRequestAuditEvent[] = [];
  const metricCalls: string[] = [];
  const repo = new AssessmentRequestRepository({
    db: createDatabase(db.appPool),
    audit: (event) => {
      events.push(event);
    },
    metrics: {
      requestsTotal: ({ status, mode }) => metricCalls.push(`${status}:${mode}`),
    },
    tenant: () => tenant,
    ...overrides,
  });
  return { repo, events, metricCalls };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  mode: 'black',
  objective: 'Assess the login flow',
  assetIds: [newId()],
  maxIntrusiveness: 'passive',
  budgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 600_000 },
  trigger: 'api',
  requestedBy: requester,
  ...overrides,
});

/** Inserts a request row as the given tenant, bypassing the repository (for CHECK and FK negatives). */
async function rawInsert(tenantId: string, values: Record<string, unknown>): Promise<void> {
  const id = newId();
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO assessment_requests
         (id, tenant_id, public_id, mode, objective, asset_ids, max_intrusiveness, budgets, trigger, requested_by, status, sa_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        tenantId,
        `areq_${id.replaceAll('-', '')}`,
        values.mode ?? 'black',
        'raw objective',
        values.assetIds ?? [newId()],
        values.maxIntrusiveness ?? 'passive',
        '{}',
        values.trigger ?? 'api',
        requester,
        values.status ?? 'draft',
        values.saId ?? null,
      ],
    );
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('create', () => {
  it('stores a draft with a public id, the requester and version 0, and audits it in the same transaction', async () => {
    const { repo, events, metricCalls } = makeRepo();
    const row = await repo.create(createInput());
    expect(row.status).toBe('draft');
    expect(row.publicId).toMatch(/^areq_/);
    expect(row.tenantId).toBe(tenantA);
    expect(row.requestedBy).toBe(requester);
    expect(row.stateVersion).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'scope.request.created',
        requestId: row.id,
        tenantId: tenantA,
        to: 'draft',
        actorId: requester,
      }),
    ]);
    expect(metricCalls).toContain('draft:black');
  });

  it('stores objectives as UTF-8 unchanged', async () => {
    const { repo } = makeRepo();
    const objective = 'Prüfung der Anmeldung 認証 🔐';
    const row = await repo.create(createInput({ objective }));
    expect(row.objective).toBe(objective);
  });

  it('rolls the request back when the audit write fails (no change without its ledger entry)', async () => {
    const { repo } = makeRepo({
      audit: () => {
        throw new Error('ledger unavailable');
      },
    });
    await expect(repo.create(createInput({ objective: 'audit-fails-create' }))).rejects.toThrow(
      'ledger unavailable',
    );
    const found = await db.withTenant(tenantA, (tx) =>
      tx.query("SELECT 1 FROM assessment_requests WHERE objective = 'audit-fails-create'"),
    );
    expect(found.rowCount).toBe(0);
  });

  it('refuses an input manifest that belongs to another tenant (composite FK)', async () => {
    const manifestB = newId();
    await db.withTenant(tenantB, (tx) =>
      tx.query('INSERT INTO input_manifests (id, tenant_id) VALUES ($1, $2)', [manifestB, tenantB]),
    );
    const { repo } = makeRepo();
    await expect(repo.create(createInput({ inputManifestId: manifestB }))).rejects.toThrow(
      ForeignKeyError,
    );
  });
});

describe('tenant isolation', () => {
  it('a request is invisible to another tenant (findById is undefined, not an error)', async () => {
    const created = await makeRepo().repo.create(createInput());
    const other = makeRepo({}, tenantB).repo;
    await expect(other.findById(created.id)).resolves.toBeUndefined();
    await expect(makeRepo({}, tenantA).repo.findById(created.id)).resolves.toMatchObject({
      id: created.id,
    });
  });

  it('another tenant cannot edit or transition a request (NotFound, the row is unchanged)', async () => {
    const created = await makeRepo().repo.create(createInput());
    const other = makeRepo({}, tenantB).repo;
    await expect(
      other.updateDraft(created.id, 0, { objective: 'hijack' }, requester),
    ).rejects.toThrow(NotFoundError);
    await expect(other.transition(created.id, 0, 'withdrawn', requester)).rejects.toThrow(
      NotFoundError,
    );
    const stillThere = await makeRepo().repo.findById(created.id);
    expect(stillThere?.objective).toBe('Assess the login flow');
    expect(stillThere?.status).toBe('draft');
  });

  it('a row written by one tenant cannot be inserted under another tenant context', async () => {
    const id = newId();
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO assessment_requests (id, tenant_id, public_id, mode, objective, asset_ids, max_intrusiveness, budgets, trigger, requested_by)
           VALUES ($1, $2, $3, 'black', 'spoof', '{}', 'passive', '{}', 'api', $4)`,
          [id, tenantA, `areq_${id.replaceAll('-', '')}`, requester],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a composite FK stops a manifest from linking another tenant request', async () => {
    const requestA = await makeRepo().repo.create(createInput());
    const manifestB = newId();
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          'INSERT INTO input_manifests (id, tenant_id, assessment_request_id) VALUES ($1, $2, $3)',
          [manifestB, tenantB, requestA.id],
        ),
      ),
    );
    expect(code).toBe('23503');
  });
});

describe('check constraints', () => {
  it('rejects max_intrusiveness destructive at the database (§8.3)', async () => {
    const code = await pgCode(rawInsert(tenantA, { maxIntrusiveness: 'destructive' }));
    expect(code).toBe('23514');
  });

  it('rejects an invalid mode, trigger or status', async () => {
    expect(await pgCode(rawInsert(tenantA, { mode: 'purple' }))).toBe('23514');
    expect(await pgCode(rawInsert(tenantA, { trigger: 'webhook' }))).toBe('23514');
    expect(await pgCode(rawInsert(tenantA, { status: 'running' }))).toBe('23514');
  });

  it('rejects a submitted request with no standing authorisation or no asset', async () => {
    expect(await pgCode(rawInsert(tenantA, { status: 'submitted', saId: null }))).toBe('23514');
    expect(
      await pgCode(rawInsert(tenantA, { status: 'submitted', saId: newId(), assetIds: [] })),
    ).toBe('23514');
  });

  it('accepts an empty asset list while still a draft', async () => {
    expect(await pgCode(rawInsert(tenantA, { assetIds: [] }))).toBeUndefined();
  });
});

describe('updateDraft', () => {
  it('applies the patch and bumps state_version on the matching version', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput({ objective: 'before edit' }));
    const updated = await repo.updateDraft(created.id, 0, { objective: 'after edit' }, requester);
    expect(updated.objective).toBe('after edit');
    expect(updated.stateVersion).toBe(1);
    expect(updated.requestedBy).toBe(requester);
  });

  it('refuses a stale version (optimistic concurrency, 412)', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput());
    await repo.updateDraft(created.id, 0, { objective: 'first writer' }, requester);
    await expect(
      repo.updateDraft(created.id, 0, { objective: 'lost writer' }, requester),
    ).rejects.toThrow(ConcurrencyError);
  });

  it('refuses an edit once the request left draft (409)', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput());
    await repo.transition(created.id, 0, 'withdrawn', requester);
    await expect(
      repo.updateDraft(created.id, 1, { objective: 'too late' }, requester),
    ).rejects.toThrow(ConflictError);
  });
});

describe('transition', () => {
  it('moves draft to withdrawn, bumps the version and audits from, to and the actor', async () => {
    const { repo, events } = makeRepo();
    const created = await repo.create(createInput());
    const actor = newId();
    const moved = await repo.transition(created.id, 0, 'withdrawn', actor);
    expect(moved.status).toBe('withdrawn');
    expect(moved.stateVersion).toBe(1);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        action: 'scope.request.withdrawn',
        requestId: created.id,
        from: 'draft',
        to: 'withdrawn',
        actorId: actor,
      }),
    );
  });

  it('refuses an illegal move (draft to promoted) with 409 and leaves the row alone', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput());
    await expect(repo.transition(created.id, 0, 'promoted', requester)).rejects.toThrow(
      ConflictError,
    );
    expect((await repo.findById(created.id))?.status).toBe('draft');
  });

  it('refuses leaving a terminal state', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput());
    await repo.transition(created.id, 0, 'withdrawn', requester);
    await expect(repo.transition(created.id, 1, 'draft', requester)).rejects.toThrow(ConflictError);
  });

  it('refuses a stale version with 412', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput());
    await expect(repo.transition(created.id, 7, 'withdrawn', requester)).rejects.toThrow(
      ConcurrencyError,
    );
  });

  it('refuses to submit without a standing authorisation (sa_id) and at least one asset', async () => {
    const { repo } = makeRepo();
    const noSa = await repo.create(createInput());
    await expect(repo.transition(noSa.id, 0, 'submitted', requester)).rejects.toThrow(
      ValidationError,
    );
    const noAssets = await repo.create(createInput({ assetIds: [] }));
    await expect(repo.transition(noAssets.id, 0, 'submitted', requester)).rejects.toThrow(
      ValidationError,
    );
  });

  it('submits a request that has an authorisation and an asset', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(createInput({ saId: newId() }));
    const submitted = await repo.transition(created.id, 0, 'submitted', requester);
    expect(submitted.status).toBe('submitted');
  });

  it('rolls the status back when the audit write fails', async () => {
    const good = makeRepo();
    const created = await good.repo.create(createInput({ saId: newId() }));
    const failing = makeRepo({
      audit: () => {
        throw new Error('ledger unavailable');
      },
    });
    await expect(failing.repo.transition(created.id, 0, 'submitted', requester)).rejects.toThrow(
      'ledger unavailable',
    );
    expect((await good.repo.findById(created.id))?.status).toBe('draft');
    expect((await good.repo.findById(created.id))?.stateVersion).toBe(0);
  });
});

describe('deletion', () => {
  it('the runtime role cannot delete a request (evidence is kept)', async () => {
    const created = await makeRepo().repo.create(createInput());
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM assessment_requests WHERE id = $1', [created.id]),
      ),
    );
    expect(code).toBe('42501');
  });

  it('deleting a request unlinks its manifest (SET NULL on the request column only), never cascades', async () => {
    const created = await makeRepo().repo.create(createInput());
    const manifestId = newId();
    await db.withTenant(tenantA, (tx) =>
      tx.query(
        'INSERT INTO input_manifests (id, tenant_id, assessment_request_id, supplied_targets) VALUES ($1, $2, $3, $4)',
        [manifestId, tenantA, created.id, '[{"kind":"url","value":"https://example.test"}]'],
      ),
    );
    // The owner role runs the cleanup path (the app role has no DELETE). FORCE RLS still applies to the
    // owner, so the cleanup runs inside tenant A's context.
    const owner = await db.ownerPool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await owner.query('DELETE FROM assessment_requests WHERE id = $1', [created.id]);
      await owner.query('COMMIT');
    } finally {
      owner.release();
    }
    const manifest = await db.withTenant(tenantA, async (tx) => {
      const result = await tx.query<{
        tenant_id: string;
        assessment_request_id: string | null;
        supplied_targets: unknown;
      }>(
        'SELECT tenant_id, assessment_request_id, supplied_targets FROM input_manifests WHERE id = $1',
        [manifestId],
      );
      return result.rows[0];
    });
    expect(manifest).toBeDefined();
    expect(manifest?.tenant_id).toBe(tenantA);
    expect(manifest?.assessment_request_id).toBeNull();
    expect(manifest?.supplied_targets).toEqual([{ kind: 'url', value: 'https://example.test' }]);
  });
});
