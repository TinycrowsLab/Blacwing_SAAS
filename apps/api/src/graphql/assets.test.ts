import { readFileSync } from 'node:fs';

import { buildASTSchema, parse, validate, type ObjectTypeDefinitionNode, Kind } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, ValidationError, AppError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { AssetFilterModel } from './assets.models.js';
import { AssetsResolver } from './assets.resolver.js';
import { createQueryLimitsRule } from './limits.js';
import { createAssetLoaders, createRequestLoaders } from './loaders.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { GraphqlResolverContext } from './members.resolver.js';
import type { AssetReadStore, AssetRow, MemberReadStore } from './store.js';
import type { FastifyRequest } from 'fastify';

vi.mock('../tenant/guard.js', () => ({ tenantContextOf: vi.fn() }));

const TENANT_A = newId();
const TENANT_B = newId();
const DEV = newId();
const LAPSED = newId();
const OUTSIDER = newId();

/** A fixture row: the store row, plus whether the registry has soft-deleted it (the store never returns that flag). */
type FixtureRow = AssetRow & { readonly deleted: boolean };

/** An asset row of tenant A, created `index` seconds after the epoch, so higher indexes are newer. */
function assetRow(index: number, patch: Partial<FixtureRow> = {}): FixtureRow {
  const id = newId();
  return {
    id,
    publicId: `asset_${id.replaceAll('-', '').slice(-20)}`,
    tenantId: TENANT_A,
    type: 'web_app',
    name: `asset ${String(index)}`,
    environment: 'staging',
    verificationStatus: 'verified',
    verificationMethod: 'dns_txt',
    verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    verificationExpiresAt: null,
    ownerUserId: DEV,
    attestation: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    deleted: false,
    ...patch,
  };
}

interface Calls {
  tags: number;
  groups: number;
  credentials: number;
  owners: number;
}

/**
 * An in-memory asset store that filters by tenant the way RLS does, and counts each batched read. Rows of tenant B and
 * soft-deleted rows exist, so the isolation and deletion negatives are real.
 */
function memoryAssets(rows: readonly FixtureRow[]) {
  const calls: Calls = { tags: 0, groups: 0, credentials: 0, owners: 0 };
  const live = (tenantId: string) =>
    rows.filter((asset) => asset.tenantId === tenantId && !asset.deleted);
  const memberships: Record<string, Record<string, string[]>> = {
    [TENANT_A]: { [DEV]: ['developer'] },
    [TENANT_B]: {},
  };
  const batch = <T>(tenantId: string, ids: readonly string[], value: T[]) =>
    new Map(ids.filter((id) => live(tenantId).some((a) => a.id === id)).map((id) => [id, value]));
  const store: AssetReadStore = {
    rolesOf: (tenantId, userId) => Promise.resolve(memberships[tenantId]?.[userId] ?? []),
    listAssets: (tenantId, query) => {
      const ordered = live(tenantId)
        .filter((asset) =>
          query.filter.verificationStatus === undefined
            ? true
            : asset.verificationStatus === query.filter.verificationStatus,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      const after = query.after;
      const rest =
        after === undefined
          ? ordered
          : ordered.filter(
              (asset) =>
                asset.createdAt.getTime() < after.createdAt.getTime() ||
                (asset.createdAt.getTime() === after.createdAt.getTime() && asset.id < after.id),
            );
      return Promise.resolve(rest.slice(0, query.limit));
    },
    findAsset: (tenantId, ref) =>
      Promise.resolve(live(tenantId).find((a) => a.id === ref || a.publicId === ref)),
    tagsOf: (tenantId, ids) => {
      calls.tags += 1;
      return Promise.resolve(
        batch(tenantId, ids, [
          { key: 'env', value: 'staging' },
          { key: 'team', value: 'payments' },
        ]),
      );
    },
    groupsOf: (tenantId, ids) => {
      calls.groups += 1;
      return Promise.resolve(batch(tenantId, ids, [{ id: 'grp-1', name: 'Payments' }]));
    },
    credentialRolesOf: (tenantId, ids) => {
      calls.credentials += 1;
      return Promise.resolve(
        batch(tenantId, ids, [
          { roleName: 'admin', mfaType: 'totp', secretRef: 'openbao://kv/admin' },
        ]),
      );
    },
  };
  const members: MemberReadStore = {
    listMembers: () => Promise.resolve([]),
    findUsers: (tenantId, ids) => {
      calls.owners += 1;
      const users = new Map<string, { id: string; name: string | null; email: string }>();
      if (tenantId === TENANT_A && ids.includes(DEV)) {
        users.set(DEV, { id: DEV, name: 'Dev', email: 'dev@acme.test' });
      }
      return Promise.resolve(users);
    },
  };
  return { store, members, calls };
}

/** The standard fixture: tenant A has seven live assets (one lapsed owner, one unverified), tenant B one more. */
function fixture() {
  const rows = [
    ...[1, 2, 3, 4, 5].map((index) => assetRow(index)),
    assetRow(6, {
      ownerUserId: LAPSED,
      attestation: { environmentType: 'staging', apiKey: 'hunter2' },
    }),
    assetRow(7, { verificationStatus: 'unverified', verifiedAt: null, verificationMethod: null }),
    assetRow(8, { tenantId: TENANT_B }),
    assetRow(9, { deleted: true }),
  ];
  return { rows, ...memoryAssets(rows) };
}

/** A resolver context for one caller: the request is the tenant-guard's key, the loaders are the request's. */
function contextFor(
  members: MemberReadStore,
  store: AssetReadStore | null,
  userId: string | undefined,
): GraphqlResolverContext {
  if (userId !== undefined) {
    vi.mocked(tenantContextOf).mockReturnValue({
      tenantId: TENANT_A,
      actor: { type: 'user', id: userId },
    });
  } else {
    vi.mocked(tenantContextOf).mockReturnValue(undefined);
  }
  return {
    req: {} as FastifyRequest,
    loaders: {
      ...createRequestLoaders(members),
      ...createAssetLoaders(store),
    } as GraphqlResolverContext['loaders'],
  };
}

function resolver(store: AssetReadStore | null = null) {
  return new AssetsResolver(store);
}

beforeEach(() => {
  vi.mocked(tenantContextOf).mockReset();
});

describe('assets query', () => {
  it('pages the tenant assets newest first, and a cursor resumes exactly where the page stopped', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page1 = await api.assets(ctx, undefined, undefined, 3);
    expect(page1.items.map((item) => item.name)).toEqual(['asset 7', 'asset 6', 'asset 5']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await api.assets(ctx, undefined, page1.nextCursor ?? undefined, 3);
    expect(page2.items.map((item) => item.name)).toEqual(['asset 4', 'asset 3', 'asset 2']);
    const page3 = await api.assets(ctx, undefined, page2.nextCursor ?? undefined, 3);
    expect(page3.items.map((item) => item.name)).toEqual(['asset 1']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('filters by verification status and refuses an unknown filter value', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const unverified = await api.assets(
      ctx,
      Object.assign(new AssetFilterModel(), { verificationStatus: 'unverified' }),
    );
    expect(unverified.items.map((item) => item.name)).toEqual(['asset 7']);
    await expect(
      api.assets(ctx, Object.assign(new AssetFilterModel(), { type: 'mainframe' })),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a malformed cursor and a limit outside 1 to 200', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    await expect(api.assets(ctx, undefined, 'not-a-cursor')).rejects.toThrow('cursor is not valid');
    await expect(api.assets(ctx, undefined, undefined, 0)).rejects.toThrow(ValidationError);
    await expect(api.assets(ctx, undefined, undefined, 201)).rejects.toThrow(ValidationError);
  });

  it('refuses a caller with no membership in the tenant (no asset:read permission)', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, OUTSIDER);
    await expect(api.assets(ctx)).rejects.toThrow(ForbiddenError);
    await expect(api.asset(contextFor(members, store, OUTSIDER), newId())).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('refuses a caller with no resolved tenant (fail closed)', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, undefined);
    await expect(api.assets(ctx)).rejects.toThrow('tenant context was not resolved');
  });

  it('answers GRAPH_QUERY_UNAVAILABLE when no asset store is configured', async () => {
    const { members } = fixture();
    const api = resolver(null);
    const ctx = contextFor(members, null, DEV);
    await expect(api.assets(ctx)).rejects.toThrow(AppError);
  });
});

describe('asset and assetVerification', () => {
  it('resolves one asset by uuid or asset_ public id', async () => {
    const { rows, store, members } = fixture();
    const api = resolver(store);
    const target = rows[0];
    if (target === undefined) throw new Error('fixture');
    const byId = await api.asset(contextFor(members, store, DEV), target.id);
    expect(byId?.name).toBe(target.name);
    const byPublic = await api.asset(contextFor(members, store, DEV), target.publicId);
    expect(byPublic?.name).toBe(target.name);
  });

  it('answers null for a foreign, deleted or missing id, and for a malformed reference without reading', async () => {
    const { rows, store, members } = fixture();
    const api = resolver(store);
    const foreign = rows.find((asset) => asset.tenantId === TENANT_B);
    const deleted = rows.find((asset) => asset.deleted);
    const findSpy = vi.spyOn(store, 'findAsset');
    const ctx = () => contextFor(members, store, DEV);
    expect(await api.asset(ctx(), foreign?.id ?? newId())).toBeNull();
    expect(await api.asset(ctx(), deleted?.id ?? newId())).toBeNull();
    expect(await api.asset(ctx(), newId())).toBeNull();
    const callsBefore = findSpy.mock.calls.length;
    expect(await api.asset(ctx(), '../../etc')).toBeNull();
    expect(findSpy.mock.calls.length).toBe(callsBefore);
  });

  it('reads the verification of one asset', async () => {
    const { rows, store, members } = fixture();
    const api = resolver(store);
    const unverified = rows.find((asset) => asset.name === 'asset 7');
    const verification = await api.assetVerification(
      contextFor(members, store, DEV),
      unverified?.id ?? '',
    );
    expect(verification).toEqual({
      status: 'unverified',
      method: null,
      verifiedAt: null,
      expiresAt: null,
    });
  });
});

describe('nested fields', () => {
  it('answers the owner as null when the owner membership has lapsed', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page = await api.assets(ctx, undefined, undefined, 50);
    const lapsed = page.items.find((item) => item.name === 'asset 6');
    const active = page.items.find((item) => item.name === 'asset 1');
    if (lapsed === undefined || active === undefined) throw new Error('fixture');
    expect(await api.owner(lapsed, ctx)).toBeNull();
    expect(await api.owner(active, ctx)).toEqual({ id: DEV, name: 'Dev', email: 'dev@acme.test' });
  });

  it('batches tags, groups, credential roles and owners once per response, not once per asset (no N+1)', async () => {
    const { store, members, calls } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page = await api.assets(ctx, undefined, undefined, 50);
    expect(page.items).toHaveLength(7);
    await Promise.all(
      page.items.flatMap((item) => [
        api.tags(item, ctx),
        api.groups(item, ctx),
        api.credentialRoles(item, ctx),
        api.owner(item, ctx),
      ]),
    );
    expect(calls.tags).toBe(1);
    expect(calls.groups).toBe(1);
    expect(calls.credentials).toBe(1);
    expect(calls.owners).toBe(1);
  });

  it('returns the labels and the groups of an asset', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page = await api.assets(ctx, undefined, undefined, 1);
    const [item] = page.items;
    if (item === undefined) throw new Error('fixture');
    expect(await api.tags(item, ctx)).toEqual([
      { key: 'env', value: 'staging' },
      { key: 'team', value: 'payments' },
    ]);
    expect(await api.groups(item, ctx)).toEqual([{ id: 'grp-1', name: 'Payments' }]);
  });

  it('exposes credential roles without any secret value', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page = await api.assets(ctx, undefined, undefined, 1);
    const [item] = page.items;
    if (item === undefined) throw new Error('fixture');
    const roles = await api.credentialRoles(item, ctx);
    expect(roles).toEqual([
      { roleName: 'admin', mfaType: 'totp', secretRef: 'openbao://kv/admin' },
    ]);
    for (const role of roles)
      expect(Object.keys(role).sort()).toEqual(['mfaType', 'roleName', 'secretRef']);
  });

  it('summarises the attestation: the environment type and the key names, never the values', async () => {
    const { store, members } = fixture();
    const api = resolver(store);
    const ctx = contextFor(members, store, DEV);
    const page = await api.assets(ctx, undefined, undefined, 50);
    const attested = page.items.find((item) => item.name === 'asset 6');
    expect(attested?.attestation).toEqual({
      environmentType: 'staging',
      attestedKeys: ['environmentType', 'apiKey'],
    });
    expect(JSON.stringify(page)).not.toContain('hunter2');
  });
});

describe('schema contract', () => {
  const sdl = readFileSync(new URL('../../schema.gql', import.meta.url), 'utf8');
  const schema = buildASTSchema(parse(sdl));

  it('CredentialRole exposes role name, MFA type and secret reference, and no secret value', () => {
    const type = schema.getType('CredentialRole');
    expect(type).toBeDefined();
    const fields = Object.keys(
      (type as { getFields(): Record<string, unknown> }).getFields(),
    ).sort();
    expect(fields).toEqual(['mfaType', 'roleName', 'secretRef']);
  });

  it('Asset exposes no identifiers or raw attestation', () => {
    const asset = parse(sdl).definitions.find(
      (definition): definition is ObjectTypeDefinitionNode =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'Asset',
    );
    const names = asset?.fields?.map((field) => field.name.value) ?? [];
    expect(names).not.toContain('identifiers');
    expect(names).not.toContain('attestation_raw');
    expect(names).toContain('credentialRoles');
  });

  it('rejects an over-deep asset query with the query-limit code, before any resolver runs', () => {
    const document = parse('{ assets { items { owner { id name email } } } }');
    const errors = validate(schema, document, [
      createQueryLimitsRule({ maxDepth: 3, maxComplexity: 1000, maxAliases: 50 }, {}),
    ]);
    expect(errors.map((error) => error.extensions.code)).toEqual(['query_too_complex']);
  });

  it('accepts a query within the default limits', () => {
    const document = parse(
      '{ assets(limit: 20) { hasMore nextCursor items { name owner { id } } } }',
    );
    const errors = validate(schema, document, [
      createQueryLimitsRule({ maxDepth: 8, maxComplexity: 1000, maxAliases: 50 }, {}),
    ]);
    expect(errors).toEqual([]);
  });
});
