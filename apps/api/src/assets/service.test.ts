import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@blackwing/errors';

import { AssetListService } from './service.js';

import type { VerificationStatus } from '@blackwing/contracts';
import type { AssetListRow } from '@blackwing/db';

const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
const USER = '0198f0a0-0000-7000-8000-0000000000a1';

const ROW: AssetListRow = {
  id: '0198f0a0-0000-7000-8000-0000000000e1',
  name: 'Juice Shop (lab)',
  type: 'web_app',
  environment: 'dev',
  verificationStatus: 'verified',
};

const principal = { tenantId: TENANT, actorId: USER };

/** A list store fake whose read answers `rows`, plus the spy that records the tenant and filter it was called with. */
function fakeStore(rows: AssetListRow[] = [ROW]) {
  const list = vi.fn<
    (
      tenantId: string,
      filter: { verificationStatus?: VerificationStatus | undefined },
    ) => Promise<AssetListRow[]>
  >(() => Promise.resolve(rows));
  return { store: { list }, list };
}

/** A memberships fake that answers the given roles, plus the spy for its calls. */
function fakeMemberships(roles: readonly string[]) {
  const rolesOf = vi.fn<(tenantId: string, userId: string) => Promise<readonly string[]>>(() =>
    Promise.resolve(roles),
  );
  return { memberships: { rolesOf }, rolesOf };
}

describe('AssetListService (ASSET-017 scoping input)', () => {
  it('lists the tenant assets for a caller with asset:read, scoped to the tenant', async () => {
    const { store, list } = fakeStore();
    const { memberships } = fakeMemberships(['appsec_engineer']);
    const service = new AssetListService({ store, memberships });
    const answer = await service.list(principal, {});
    expect(list).toHaveBeenCalledWith(TENANT, { verificationStatus: undefined });
    expect(answer).toEqual({ items: [ROW] });
  });

  it('passes the verification filter through to the store', async () => {
    const { store, list } = fakeStore([]);
    const { memberships } = fakeMemberships(['appsec_engineer']);
    const service = new AssetListService({ store, memberships });
    await service.list(principal, { verificationStatus: 'verified' });
    expect(list).toHaveBeenCalledWith(TENANT, { verificationStatus: 'verified' });
  });

  it('refuses a member whose roles grant no asset:read (an unknown role grants nothing) without reading the store', async () => {
    const { store, list } = fakeStore();
    const { memberships } = fakeMemberships(['unassigned_role']);
    const service = new AssetListService({ store, memberships });
    await expect(service.list(principal, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses a non-member (no roles) and an actor id that is not a UUID, without reading the store', async () => {
    const { store, list } = fakeStore();
    const none = fakeMemberships([]);
    const service = new AssetListService({ store, memberships: none.memberships });
    await expect(service.list(principal, {})).rejects.toBeInstanceOf(ForbiddenError);

    const admin = fakeMemberships(['org_admin']);
    const bad = new AssetListService({ store, memberships: admin.memberships });
    await expect(bad.list({ tenantId: TENANT, actorId: 'not-a-uuid' }, {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(admin.rolesOf).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('never returns a field outside the wire contract (no identifiers or attestations leak)', async () => {
    const leaky = Object.assign({}, ROW, {
      identifiers: [{ kind: 'url' }],
      attestation: { secret: 'x' },
    });
    const { store } = fakeStore([leaky]);
    const { memberships } = fakeMemberships(['appsec_engineer']);
    const service = new AssetListService({ store, memberships });
    await expect(service.list(principal, {})).rejects.toThrow();
  });
});
