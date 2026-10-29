import { describe, expect, it } from 'vitest';

import {
  ADMIN_A,
  ADMIN_B,
  APPSEC2_A,
  APPSEC_B,
  APPSEC_A,
  ASSET_A_UNVERIFIED,
  ASSET_A1,
  ASSET_A2,
  ASSET_B1,
  AUDITOR_A,
  draftBody,
  memoryStore,
  type MemoryStore,
  standardFixtures,
  TENANT_A,
  TENANT_B,
  testCursors,
} from './fixtures.test-helpers.js';
import { createCedarSaPolicy } from './policy.js';
import { AuthorisationService, type AuthorisationPrincipal } from './service.js';
import { ApiProblemError } from '../errors/problem-errors.js';

import type { SubmitResult } from './metrics.js';
import type { StandingAuthorisationStore } from './ports.js';
import type { StandingAuthorisationRecord } from '@blackwing/db';

/** The requester of the drafts: an appsec engineer, who holds sa:create. */
const ADMIN: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: APPSEC_A };
/** Another appsec engineer: not the requester. */
const APPSEC: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: APPSEC2_A };
/** An org admin holds sa:read but not sa:create (RBAC-001). */
const ORG_ADMIN: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: ADMIN_A };
const AUDITOR: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: AUDITOR_A };
const OTHER_TENANT_ADMIN: AuthorisationPrincipal = { tenantId: TENANT_B, actorId: ADMIN_B };
/** An appsec engineer of tenant B, who can act in B only. */
const OTHER_TENANT_APPSEC: AuthorisationPrincipal = { tenantId: TENANT_B, actorId: APPSEC_B };

/** The service over an in-memory store; `wrap` can swap the store for a failing one. */
function harness(
  initial: readonly StandingAuthorisationRecord[] = [],
  wrap: (store: MemoryStore) => StandingAuthorisationStore = (store) => store,
) {
  const memory = memoryStore(initial);
  const store = wrap(memory);
  const fixtures = standardFixtures();
  const submits: SubmitResult[] = [];
  const service = new AuthorisationService({
    store,
    assets: fixtures.assets,
    memberships: fixtures.memberships,
    policy: createCedarSaPolicy(),
    cursors: testCursors(),
    metrics: {
      submitted: (result) => {
        submits.push(result);
      },
    },
    logger: { info: () => undefined },
  });
  return { service, store: memory, submits };
}

/** Creates a draft and returns its public id and ETag. */
async function draft(service: AuthorisationService, body = draftBody()) {
  const view = await service.create(ADMIN, body);
  return { id: view.body.id, etag: view.etag };
}

/** The stable code of a refusal: an AppError's `code`, or an ApiProblemError's `problemCode`. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiProblemError) return error.problemCode;
    return error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  }
  return undefined;
}

describe('AuthorisationService.create', () => {
  it('creates a draft owned by the caller at version 1, with a strong ETag and an audit event', async () => {
    const { service, store } = harness();
    const view = await service.create(ADMIN, draftBody());
    expect(view.body).toMatchObject({
      id: expect.stringMatching(/^sa_[0-9a-z]+$/) as unknown,
      status: 'draft',
      version: 1,
      requesterId: APPSEC_A,
      approverId: null,
      signature: null,
      signingKeyId: null,
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    expect(view.etag).toBe('"v1"');
    expect(store.audits).toEqual([
      expect.objectContaining({
        action: 'authz.sa.created',
        tenantId: TENANT_A,
        actorId: APPSEC_A,
        saId: view.body.id,
        changedFields: expect.arrayContaining(['assetIds', 'validFrom', 'expiresAt']) as unknown,
      }),
    ]);
  });

  it('refuses an inverted validity window with AUTHZ_INVALID_WINDOW and writes nothing', async () => {
    const { service, store } = harness();
    const body = draftBody({
      validFrom: '2026-12-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(await codeOf(service.create(ADMIN, body))).toBe('AUTHZ_INVALID_WINDOW');
    expect(store.rows.size).toBe(0);
  });

  it('refuses a caller without sa:create (auditor, org admin) with 403 and writes nothing', async () => {
    const { service, store } = harness();
    expect(await codeOf(service.create(AUDITOR, draftBody()))).toBe('FORBIDDEN');
    expect(await codeOf(service.create(ORG_ADMIN, draftBody()))).toBe('FORBIDDEN');
    expect(store.rows.size).toBe(0);
  });

  it('refuses a user id that is not a UUID: it holds no membership, so 403', async () => {
    const { service } = harness();
    expect(
      await codeOf(service.create({ tenantId: TENANT_A, actorId: 'usr_x' }, draftBody())),
    ).toBe('FORBIDDEN');
  });
});

describe('AuthorisationService.get and list', () => {
  it('reads a draft to any member, but not across tenants (404) or for a malformed id (404)', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    const read = await service.get(AUDITOR, id);
    expect(read.body.id).toBe(id);
    expect(read.etag).toBe(etag);
    expect(await codeOf(service.get(OTHER_TENANT_ADMIN, id))).toBe('NOT_FOUND');
    expect(await codeOf(service.get(ADMIN, 'sa_not-an-id'))).toBe('NOT_FOUND');
  });

  it('pages in id order with an opaque cursor, and refuses a tampered cursor', async () => {
    const { service } = harness();
    const ids = [await draft(service), await draft(service), await draft(service)].map((d) => d.id);
    const first = await service.list(ADMIN, { limit: 2 });
    expect(first.items.map((item) => item.id)).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(ADMIN, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(await codeOf(service.list(ADMIN, { cursor: `${first.nextCursor ?? ''}x` }))).toBe(
      'invalid_cursor',
    );
  });

  it("never lists another tenant's drafts", async () => {
    const { service } = harness();
    await draft(service);
    expect((await service.list(OTHER_TENANT_ADMIN, {})).items).toEqual([]);
  });
});

describe('AuthorisationService.update', () => {
  it('changes a draft under If-Match, bumps the version and audits the changed field names', async () => {
    const { service, store } = harness();
    const { id, etag } = await draft(service);
    const view = await service.update(ADMIN, id, etag, { maxIntrusiveness: 'passive' });
    expect(view.body.maxIntrusiveness).toBe('passive');
    expect(view.body.version).toBe(2);
    expect(view.etag).toBe('"v2"');
    expect(store.audits.at(-1)).toMatchObject({
      action: 'authz.sa.updated',
      changedFields: ['maxIntrusiveness'],
    });
  });

  it('answers 428 without If-Match, 412 for a stale ETag, and accepts the wildcard', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    expect(
      await codeOf(service.update(ADMIN, id, undefined, { maxIntrusiveness: 'passive' })),
    ).toBe('PRECONDITION_REQUIRED');
    expect(await codeOf(service.update(ADMIN, id, '"v9"', { maxIntrusiveness: 'passive' }))).toBe(
      'PRECONDITION_FAILED',
    );
    const wildcard = await service.update(ADMIN, id, '*', { maxIntrusiveness: 'passive' });
    expect(wildcard.body.version).toBe(2);
    expect(etag).toBe('"v1"');
  });

  it('refuses a change to a submitted SA with AUTHZ_NOT_DRAFT (409)', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    const submitted = await service.submit(ADMIN, id, etag);
    expect(
      await codeOf(service.update(ADMIN, id, submitted.etag, { maxIntrusiveness: 'passive' })),
    ).toBe('AUTHZ_NOT_DRAFT');
  });

  it('re-checks the window on the merged draft: a patch that inverts it is refused and changes nothing', async () => {
    const { service, store } = harness();
    const { id, etag } = await draft(service);
    const auditsBefore = store.audits.length;
    expect(
      await codeOf(service.update(ADMIN, id, etag, { expiresAt: '2026-10-01T00:00:00.000Z' })),
    ).toBe('AUTHZ_INVALID_WINDOW');
    expect((await service.get(ADMIN, id)).body.version).toBe(1);
    expect(store.audits.length).toBe(auditsBefore);
  });

  it('answers an unchanged patch as a no-op: same version, no audit event', async () => {
    const { service, store } = harness();
    const { id, etag } = await draft(service);
    const auditsBefore = store.audits.length;
    const view = await service.update(ADMIN, id, etag, { maxIntrusiveness: 'active_safe' });
    expect(view.body.version).toBe(1);
    expect(store.audits.length).toBe(auditsBefore);
  });

  it('lets only the requester change the draft: another appsec engineer gets 403 (Cedar)', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    expect(await codeOf(service.update(APPSEC, id, etag, { maxIntrusiveness: 'passive' }))).toBe(
      'FORBIDDEN',
    );
  });

  it('fails with 412 when a concurrent writer wins between the read and the write', async () => {
    // A store whose conditional write always loses the race, as a concurrent writer would.
    const lost = harness([], (store) => ({ ...store, writeIf: () => Promise.resolve(undefined) }));
    const created = await draft(lost.service);
    expect(
      await codeOf(
        lost.service.update(ADMIN, created.id, created.etag, { maxIntrusiveness: 'passive' }),
      ),
    ).toBe('PRECONDITION_FAILED');
  });
});

describe('AuthorisationService.submit', () => {
  it('moves a draft to pending_approval under If-Match and audits the submit', async () => {
    const { service, store, submits } = harness();
    const { id, etag } = await draft(service);
    const view = await service.submit(ADMIN, id, etag);
    expect(view.body).toMatchObject({
      status: 'pending_approval',
      version: 2,
      approverId: null,
      signature: null,
    });
    expect(view.etag).toBe('"v2"');
    expect(store.audits.at(-1)).toMatchObject({
      action: 'authz.sa.submitted',
      from: 'draft',
      to: 'pending_approval',
    });
    expect(submits).toEqual(['submitted']);
  });

  it('refuses an SA that covers an unverified asset (AUTHZ_ASSET_UNVERIFIED) and stays a draft', async () => {
    const { service, submits } = harness();
    const { id, etag } = await draft(
      service,
      draftBody({ assetIds: [ASSET_A1, ASSET_A_UNVERIFIED] }),
    );
    expect(await codeOf(service.submit(ADMIN, id, etag))).toBe('AUTHZ_ASSET_UNVERIFIED');
    expect((await service.get(ADMIN, id)).body.status).toBe('draft');
    expect(submits).toEqual(['refused']);
  });

  it('treats an asset of another tenant as unverified (fail closed)', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service, draftBody({ assetIds: [ASSET_A2, ASSET_B1] }));
    expect(await codeOf(service.submit(ADMIN, id, etag))).toBe('AUTHZ_ASSET_UNVERIFIED');
  });

  it('refuses a second submit: the lifecycle answers AUTHZ_ILLEGAL_TRANSITION (409)', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    const submitted = await service.submit(ADMIN, id, etag);
    expect(await codeOf(service.submit(ADMIN, id, submitted.etag))).toBe(
      'AUTHZ_ILLEGAL_TRANSITION',
    );
  });

  it('requires If-Match, rejects a stale one, and refuses a submit by someone other than the requester', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    expect(await codeOf(service.submit(ADMIN, id, undefined))).toBe('PRECONDITION_REQUIRED');
    expect(await codeOf(service.submit(ADMIN, id, '"v5"'))).toBe('PRECONDITION_FAILED');
    expect(await codeOf(service.submit(APPSEC, id, etag))).toBe('FORBIDDEN');
  });

  it('is refused for a caller without sa:create, and for another tenant', async () => {
    const { service } = harness();
    const { id, etag } = await draft(service);
    expect(await codeOf(service.submit(AUDITOR, id, etag))).toBe('FORBIDDEN');
    expect(await codeOf(service.submit(OTHER_TENANT_APPSEC, id, etag))).toBe('NOT_FOUND');
  });
});
