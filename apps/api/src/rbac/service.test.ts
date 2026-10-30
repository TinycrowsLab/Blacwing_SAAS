import { describe, expect, it } from 'vitest';

import { ConcurrencyError } from '@blackwing/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@blackwing/errors';

import { type RoleResolver, type ServiceAccountCaller, ServiceAccountService } from './service.js';
import { type Backing, emptyBacking, InMemoryStore } from './store.test-helpers.js';

import type { AuditActor, Role } from '@blackwing/contracts';

const TENANT_A = '0190a000-0000-7000-8000-00000000000a';
const TENANT_B = '0190a000-0000-7000-8000-00000000000b';
const OWNER = '0190a000-0000-7000-8000-0000000000aa';
const USER = '0190a000-0000-7000-8000-0000000000bb';
const ACTOR: AuditActor = { type: 'user', id: USER };

const backingOf = (): Backing => emptyBacking(new Map([[TENANT_A, new Set([OWNER, USER])]]));

function setup(roles: readonly Role[], shared = backingOf()) {
  const resolver: RoleResolver = () => Promise.resolve(roles);
  const service = new ServiceAccountService({
    store: new InMemoryStore(TENANT_A, shared),
    roles: resolver,
  });
  const caller: ServiceAccountCaller = { tenantId: TENANT_A, actor: ACTOR };
  return { service, caller, shared };
}

const createValue = { name: 'ci-scanner', roles: ['ci_pipeline'] as Role[], ownerUserId: OWNER };

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('ServiceAccountService: create', () => {
  it('creates an account for a caller with token:create and returns the view at version 0', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    const account = await service.create(caller, createValue);
    expect(account).toMatchObject({
      name: 'ci-scanner',
      roles: ['ci_pipeline'],
      status: 'active',
      stateVersion: 0,
      ownerUserId: OWNER,
    });
  });

  it('denies a caller without token:create (auditor holds no token permission) and writes nothing', async () => {
    const { service, caller, shared } = setup(['auditor']);
    expect(await errorOf(service.create(caller, createValue))).toBeInstanceOf(ForbiddenError);
    expect(shared.rows.size).toBe(0);
  });

  it('fails closed when the caller resolves to no roles', async () => {
    const { service, caller } = setup([]);
    expect(await errorOf(service.create(caller, createValue))).toBeInstanceOf(ForbiddenError);
  });

  it('refuses an approval or admin role even when it reaches the service (defence in depth)', async () => {
    const { service, caller } = setup(['org_admin']);
    const error = await errorOf(service.create(caller, { ...createValue, roles: ['asset_owner'] }));
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('maps a duplicate name in the tenant to a 409', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    await service.create(caller, createValue);
    expect(await errorOf(service.create(caller, createValue))).toBeInstanceOf(ConflictError);
  });

  it('maps an owner who is not a member of this tenant to a 422, never a cross-tenant link', async () => {
    const shared = backingOf();
    shared.members.set(TENANT_A, new Set([USER]));
    const { service, caller } = setup(['appsec_engineer'], shared);
    const error = await errorOf(service.create(caller, createValue));
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('ServiceAccountService: read, update, disable', () => {
  it('lists and reads accounts with token:read (developer has none, so it is denied)', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    const created = await service.create(caller, createValue);
    const page = await service.list(caller, { limit: 50 });
    expect(page.items.map((item) => item.id)).toEqual([created.id]);
    expect((await service.get(caller, created.id)).id).toBe(created.id);

    const denied = setup(['developer']);
    expect(await errorOf(denied.service.list(denied.caller, { limit: 50 }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('returns NotFound for an id of another tenant (cross-tenant access looks like a missing row)', async () => {
    const shared = backingOf();
    shared.members.set(TENANT_B, new Set([USER]));
    const a = setup(['appsec_engineer'], shared);
    const created = await a.service.create(a.caller, createValue);

    const b = new ServiceAccountService({
      store: new InMemoryStore(TENANT_B, shared),
      roles: () => Promise.resolve(['appsec_engineer']),
    });
    const callerB: ServiceAccountCaller = { tenantId: TENANT_B, actor: ACTOR };
    expect(await errorOf(b.get(callerB, created.id))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(b.disable(callerB, created.id, 0))).toBeInstanceOf(NotFoundError);
  });

  it('updates roles with the matching version and bumps the version', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    const created = await service.create(caller, createValue);
    const updated = await service.update(caller, created.id, 0, { roles: ['auditor'] });
    expect(updated).toMatchObject({ roles: ['auditor'], stateVersion: 1 });
  });

  it('rejects a stale version with ConcurrencyError (412) and leaves the row unchanged', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    const created = await service.create(caller, createValue);
    await service.update(caller, created.id, 0, { roles: ['auditor'] });
    const stale = await errorOf(service.update(caller, created.id, 0, { roles: ['developer'] }));
    expect(stale).toBeInstanceOf(ConcurrencyError);
    expect((await service.get(caller, created.id)).roles).toEqual(['auditor']);
  });

  it('refuses an approval role on update', async () => {
    const { service, caller } = setup(['appsec_engineer']);
    const created = await service.create(caller, createValue);
    const error = await errorOf(
      service.update(caller, created.id, 0, { roles: ['appsec_engineer'] }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('disables with token:revoke; a second disable is a no-op that keeps the version', async () => {
    const { service, caller } = setup(['org_admin']);
    const created = await service.create(caller, createValue);
    const first = await service.disable(caller, created.id, 0);
    expect(first).toMatchObject({ status: 'disabled', stateVersion: 1 });
    const second = await service.disable(caller, created.id, 1);
    expect(second).toMatchObject({ status: 'disabled', stateVersion: 1 });
  });

  it('denies disable for a role without token:revoke (developer)', async () => {
    const writer = setup(['appsec_engineer']);
    const created = await writer.service.create(writer.caller, createValue);
    const developer = setup(['developer'], writer.shared);
    expect(
      await errorOf(developer.service.disable(developer.caller, created.id, 0)),
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe('ServiceAccountService: service_accounts_active gauge', () => {
  it('moves on create, on a real disable and on re-enable, and never on a no-op disable', async () => {
    const deltas: number[] = [];
    const service = new ServiceAccountService({
      store: new InMemoryStore(TENANT_A, backingOf()),
      roles: () => Promise.resolve(['org_admin']),
      metrics: { activeChanged: (delta) => deltas.push(delta) },
    });
    const caller: ServiceAccountCaller = { tenantId: TENANT_A, actor: ACTOR };
    const created = await service.create(caller, createValue);
    await service.disable(caller, created.id, 0);
    await service.disable(caller, created.id, 1);
    await service.update(caller, created.id, 1, { status: 'active' });
    expect(deltas).toEqual([1, -1, 1]);
  });
});
