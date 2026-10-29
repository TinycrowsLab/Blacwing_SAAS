import { describe, expect, it } from 'vitest';

import { StandingAuthorisationId } from '@blackwing/ids';

import { canonicalEnvelope } from './envelope.js';
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
  APPROVAL_NOW_MS,
  APPROVER_A,
  downSigner,
  OWNER_A,
  testSigner,
} from './fixtures.test-helpers.js';
import { createCedarSaPolicy } from './policy.js';
import { AuthorisationService, type AuthorisationPrincipal } from './service.js';
import { DEFAULT_STEPUP_POLICY, type StepUpEvidence } from './step-up.js';
import { ApiProblemError } from '../errors/problem-errors.js';

import type { ApprovalResult, SubmitResult } from './metrics.js';
import type {
  AuthorisationMemberships,
  EnvelopeSigner,
  StandingAuthorisationStore,
} from './ports.js';
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
  options: {
    readonly signer?: EnvelopeSigner;
    readonly memberships?: AuthorisationMemberships;
  } = {},
) {
  const memory = memoryStore(initial);
  const store = wrap(memory);
  const fixtures = standardFixtures();
  const submits: SubmitResult[] = [];
  const approvals: ApprovalResult[] = [];
  const signer = testSigner();
  const service = new AuthorisationService({
    store,
    assets: fixtures.assets,
    memberships: options.memberships ?? fixtures.memberships,
    policy: createCedarSaPolicy(),
    cursors: testCursors(),
    metrics: {
      submitted: (result) => {
        submits.push(result);
      },
      approval: (result) => {
        approvals.push(result);
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    signer: options.signer ?? signer.signer,
    stepUp: DEFAULT_STEPUP_POLICY,
    now: () => APPROVAL_NOW_MS,
  });
  return { service, store: memory, submits, approvals, signer };
}

/** The approver's session as the IdP reported it: a strong login 30 seconds ago. */
const FRESH: StepUpEvidence = { acr: 'strong', authTime: Math.floor(APPROVAL_NOW_MS / 1000) - 30 };
const APPROVER: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: APPROVER_A, auth: FRESH };
/** The asset owner who requests an SA of their own (separation of duties, §8.4). */
const OWNER: AuthorisationPrincipal = { tenantId: TENANT_A, actorId: OWNER_A, auth: FRESH };
/** The approver of a tenant-B session: holds no role there. */
const OTHER_TENANT_APPROVER: AuthorisationPrincipal = {
  tenantId: TENANT_B,
  actorId: APPROVER_A,
  auth: FRESH,
};

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

/** A draft submitted for approval by its requester, with the version and ETag the approver must send back. */
async function pendingSa(service: AuthorisationService, requester = ADMIN) {
  const created = await service.create(requester, draftBody());
  const submitted = await service.submit(requester, created.body.id, created.etag);
  return { id: submitted.body.id, etag: submitted.etag };
}

/** The approval's `auth_time` as `secondsAgo` before the test clock. */
const authAgo = (secondsAgo: number): StepUpEvidence => ({
  acr: 'strong',
  authTime: Math.floor(APPROVAL_NOW_MS / 1000) - secondsAgo,
});

describe('AuthorisationService.approve', () => {
  it('signs the canonical envelope, activates the SA and records the approver, the gate decision and the audit', async () => {
    const { service, store, signer } = harness();
    const pending = await pendingSa(service);
    const active = await service.approve(APPROVER, pending.id, pending.etag);

    expect(active.body).toMatchObject({
      status: 'active',
      approverId: APPROVER_A,
      version: 3,
      signingKeyId: 'bw-sa-signing:v1',
    });
    expect(active.etag).toBe('"v3"');
    expect(active.body.signature).toEqual(
      expect.stringMatching(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/),
    );
    const saUuid = StandingAuthorisationId.toUuid(active.body.id);
    expect(store.decisions).toEqual([
      { saId: saUuid, decision: 'approved', actorId: APPROVER_A, reason: null },
    ]);
    expect(store.audits.at(-1)).toEqual(
      expect.objectContaining({
        action: 'authz.sa.approved',
        actorId: APPROVER_A,
        from: 'pending_approval',
        to: 'active',
      }),
    );

    // The signature verifies over exactly the envelope the approval named: the gateway's check (AUTHZ-005).
    const stored = store.rows.get(saUuid);
    if (stored === undefined) throw new Error('the approved SA is not stored');
    const signature = active.body.signature ?? '';
    const bytes = canonicalEnvelope(stored, { approverId: APPROVER_A, version: 3 });
    expect(signer.verify(signature, bytes)).toBe(true);
    // Any other approver or version makes the signature fail: the envelope is bound to exactly what was approved.
    expect(
      signer.verify(signature, canonicalEnvelope(stored, { approverId: OWNER_A, version: 3 })),
    ).toBe(false);
    expect(
      signer.verify(signature, canonicalEnvelope(stored, { approverId: APPROVER_A, version: 4 })),
    ).toBe(false);
    expect(signer.calls).toEqual([{ saId: active.body.id, tenantId: TENANT_A }]);
  });

  it('refuses the requester approving their own SA with AUTHZ_SOD_VIOLATION (403), signs nothing and writes nothing', async () => {
    const { service, store, approvals, signer } = harness();
    const pending = await pendingSa(service, OWNER);
    expect(await codeOf(service.approve(OWNER, pending.id, pending.etag))).toBe(
      'AUTHZ_SOD_VIOLATION',
    );
    expect(signer.calls).toEqual([]);
    expect(store.decisions).toEqual([]);
    expect(store.rows.values().next().value?.status).toBe('pending_approval');
    expect(approvals).toEqual(['refused']);
  });

  it('refuses an approval without step-up: no auth evidence, a stale auth_time, another acr, or an auth_time in the future (401)', async () => {
    const { service, signer, store } = harness();
    const pending = await pendingSa(service);
    const cases: (StepUpEvidence | undefined)[] = [
      undefined,
      { acr: 'strong' },
      { authTime: Math.floor(APPROVAL_NOW_MS / 1000) - 30 },
      authAgo(301),
      { acr: '1', authTime: Math.floor(APPROVAL_NOW_MS / 1000) - 30 },
      { acr: 'strong', authTime: Math.floor(APPROVAL_NOW_MS / 1000) + 60 },
    ];
    for (const auth of cases) {
      const principal = {
        tenantId: TENANT_A,
        actorId: APPROVER_A,
        ...(auth === undefined ? {} : { auth }),
      };
      expect(await codeOf(service.approve(principal, pending.id, pending.etag))).toBe(
        'AUTHZ_STEPUP_REQUIRED',
      );
    }
    expect(signer.calls).toEqual([]);
    expect(store.rows.values().next().value?.status).toBe('pending_approval');
  });

  it('accepts a login exactly at the step-up age limit, and refuses one second beyond it', async () => {
    const { service } = harness();
    const pending = await pendingSa(service);
    await expect(
      service.approve(
        { tenantId: TENANT_A, actorId: APPROVER_A, auth: authAgo(300) },
        pending.id,
        pending.etag,
      ),
    ).resolves.toMatchObject({ body: { status: 'active' } });
  });

  it('leaves the SA pending when the signer is down (AUTHZ_SIGNER_UNAVAILABLE, 503): nothing persisted, no audit', async () => {
    const { service, store, approvals } = harness([], undefined, { signer: downSigner() });
    const pending = await pendingSa(service);
    const auditsBefore = store.audits.length;
    expect(await codeOf(service.approve(APPROVER, pending.id, pending.etag))).toBe(
      'AUTHZ_SIGNER_UNAVAILABLE',
    );
    const row = store.rows.values().next().value;
    expect(row).toMatchObject({
      status: 'pending_approval',
      version: 2,
      signature: null,
      approverId: null,
    });
    expect(store.audits.length).toBe(auditsBefore);
    expect(store.decisions).toEqual([]);
    expect(approvals).toEqual(['refused']);
  });

  it('refuses an approver who lost asset_owner between review and commit (403) and persists nothing', async () => {
    const fixtures = standardFixtures();
    let approverLookups = 0;
    // The approver holds asset_owner for the review, then loses it before the commit re-check.
    const withdrawn: AuthorisationMemberships = {
      rolesOf: (tenantId, userId) => {
        if (userId !== APPROVER_A) return fixtures.memberships.rolesOf(tenantId, userId);
        approverLookups += 1;
        return Promise.resolve(approverLookups === 1 ? ['asset_owner'] : []);
      },
    };
    const { service, store } = harness([], undefined, { memberships: withdrawn });
    const pending = await pendingSa(service);
    expect(await codeOf(service.approve(APPROVER, pending.id, pending.etag))).toBe('FORBIDDEN');
    expect(store.rows.values().next().value?.status).toBe('pending_approval');
    expect(store.decisions).toEqual([]);
  });

  it('refuses a second approval with AUTHZ_ILLEGAL_TRANSITION (409) once the SA is active, and a stale ETag with 412', async () => {
    const { service, store } = harness();
    const pending = await pendingSa(service);
    const active = await service.approve(APPROVER, pending.id, pending.etag);
    expect(await codeOf(service.approve(APPROVER, pending.id, active.etag))).toBe(
      'AUTHZ_ILLEGAL_TRANSITION',
    );
    expect(await codeOf(service.approve(APPROVER, pending.id, pending.etag))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(store.decisions).toHaveLength(1);
  });

  it('requires If-Match (428 without it) and refuses a draft (409): only a pending SA can be approved', async () => {
    const { service } = harness();
    const pending = await pendingSa(service);
    expect(await codeOf(service.approve(APPROVER, pending.id, undefined))).toBe(
      'PRECONDITION_REQUIRED',
    );
    const created = await draft(service);
    expect(await codeOf(service.approve(APPROVER, created.id, created.etag))).toBe(
      'AUTHZ_ILLEGAL_TRANSITION',
    );
  });

  it('refuses callers without sa:approve (appsec, auditor), other tenants, and malformed ids', async () => {
    const { service } = harness();
    const pending = await pendingSa(service);
    expect(await codeOf(service.approve(APPSEC, pending.id, pending.etag))).toBe('FORBIDDEN');
    expect(await codeOf(service.approve(AUDITOR, pending.id, pending.etag))).toBe('FORBIDDEN');
    expect(await codeOf(service.approve(OTHER_TENANT_APPROVER, pending.id, pending.etag))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(service.approve(APPROVER, 'sa_not-a-real-id', pending.etag))).toBe(
      'NOT_FOUND',
    );
  });

  it("refuses an approver from another tenant, who holds no role there (403, never the other tenant's SA)", async () => {
    const { service, store } = harness();
    const pending = await pendingSa(service);
    expect(await codeOf(service.approve(OTHER_TENANT_APPROVER, pending.id, pending.etag))).toBe(
      'FORBIDDEN',
    );
    expect(store.rows.values().next().value?.status).toBe('pending_approval');
  });
});

describe('AuthorisationService.reject', () => {
  it('returns the SA to draft with the reason recorded, needs no step-up, and lets the requester edit it again', async () => {
    const { service, store, approvals } = harness();
    const pending = await pendingSa(service);
    const back = await service.reject(
      { tenantId: TENANT_A, actorId: APPROVER_A },
      pending.id,
      pending.etag,
      { reason: 'the scope includes production' },
    );
    expect(back.body).toMatchObject({
      status: 'draft',
      approverId: null,
      signature: null,
      version: 3,
    });
    expect(store.decisions).toEqual([
      expect.objectContaining({
        decision: 'rejected',
        actorId: APPROVER_A,
        reason: 'the scope includes production',
      }),
    ]);
    expect(store.audits.at(-1)).toEqual(
      expect.objectContaining({
        action: 'authz.sa.rejected',
        from: 'pending_approval',
        to: 'draft',
      }),
    );
    expect(approvals).toEqual(['rejected']);
    await expect(
      service.update(ADMIN, back.body.id, back.etag, { maxIntrusiveness: 'passive' }),
    ).resolves.toMatchObject({ body: { maxIntrusiveness: 'passive' } });
  });

  it('refuses the requester rejecting their own SA with AUTHZ_SOD_VIOLATION (403)', async () => {
    const { service, store } = harness();
    const pending = await pendingSa(service, OWNER);
    expect(await codeOf(service.reject(OWNER, pending.id, pending.etag, { reason: 'self' }))).toBe(
      'AUTHZ_SOD_VIOLATION',
    );
    expect(store.decisions).toEqual([]);
  });

  it('refuses a draft (409), a stale ETag (412), and a caller without sa:approve (403)', async () => {
    const { service } = harness();
    const created = await draft(service);
    expect(
      await codeOf(service.reject(APPROVER, created.id, created.etag, { reason: 'not pending' })),
    ).toBe('AUTHZ_ILLEGAL_TRANSITION');
    const pending = await pendingSa(service);
    expect(await codeOf(service.reject(APPROVER, pending.id, '"v1"', { reason: 'stale' }))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(
      await codeOf(service.reject(APPSEC, pending.id, pending.etag, { reason: 'no role' })),
    ).toBe('FORBIDDEN');
  });
});
