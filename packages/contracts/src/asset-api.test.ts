import { describe, expect, it } from 'vitest';

import {
  ASSET_IDENTIFIER_LIMIT,
  ASSET_TYPE_IDENTIFIER_KIND,
  assetListItemSchema,
  assetListResponseSchema,
  listAssetsQuerySchema,
  assetViewSchema,
  createAssetBodySchema,
  updateAssetBodySchema,
} from './index.js';

const OWNER = '0198f0a0-0000-7000-8000-00000000000a';
const body = {
  type: 'web_app',
  name: 'Customer portal',
  identifiers: [{ kind: 'url', value: 'https://portal.example.com' }],
  environment: 'staging',
  ownerUserId: OWNER,
};

describe('createAssetBodySchema', () => {
  it('accepts a well-formed body', () => {
    expect(createAssetBodySchema.safeParse(body).success).toBe(true);
  });

  it('refuses an empty identifier list, an oversized one, and an unknown field', () => {
    expect(createAssetBodySchema.safeParse({ ...body, identifiers: [] }).success).toBe(false);
    const many = Array.from({ length: ASSET_IDENTIFIER_LIMIT + 1 }, () => body.identifiers[0]);
    expect(createAssetBodySchema.safeParse({ ...body, identifiers: many }).success).toBe(false);
    expect(createAssetBodySchema.safeParse({ ...body, tenantId: OWNER }).success).toBe(false);
  });

  it('refuses a verification state or an id: they are never client-writable', () => {
    expect(
      createAssetBodySchema.safeParse({ ...body, verificationStatus: 'verified' }).success,
    ).toBe(false);
    expect(createAssetBodySchema.safeParse({ ...body, id: OWNER }).success).toBe(false);
  });

  it('refuses a non-uuid owner and an unknown type or environment', () => {
    expect(createAssetBodySchema.safeParse({ ...body, ownerUserId: 'alice' }).success).toBe(false);
    expect(createAssetBodySchema.safeParse({ ...body, type: 'mainframe' }).success).toBe(false);
    expect(createAssetBodySchema.safeParse({ ...body, environment: 'production' }).success).toBe(
      false,
    );
  });
});

describe('updateAssetBodySchema', () => {
  it('requires at least one field and refuses the type', () => {
    expect(updateAssetBodySchema.safeParse({}).success).toBe(false);
    expect(updateAssetBodySchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(updateAssetBodySchema.safeParse({ type: 'host' }).success).toBe(false);
  });
});

describe('listAssetsQuerySchema (GET /v1/assets)', () => {
  it('bounds the page size to 1..200 and refuses unknown filters', () => {
    expect(listAssetsQuerySchema.safeParse({ limit: '200' }).success).toBe(true);
    expect(listAssetsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(listAssetsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listAssetsQuerySchema.safeParse({ owner: OWNER }).success).toBe(false);
    expect(listAssetsQuerySchema.safeParse({ type: 'host', environment: 'prod' }).success).toBe(
      true,
    );
  });
});

describe('assetViewSchema', () => {
  const view = {
    id: OWNER,
    publicId: 'asset_0r3h7k4xw0c8g1n5p2q6v9m3yt',
    type: 'host',
    name: 'Bastion',
    identifiers: [{ kind: 'host', value: 'bastion.example.com' }],
    environment: 'prod',
    ownerUserId: OWNER,
    verificationStatus: 'unverified',
    verificationMethod: null,
    etag: '"v3"',
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    warnings: [],
  };

  it('accepts a view and pins the etag and public id shapes', () => {
    expect(assetViewSchema.safeParse(view).success).toBe(true);
    expect(assetViewSchema.safeParse({ ...view, etag: 'v3' }).success).toBe(false);
    expect(assetViewSchema.safeParse({ ...view, publicId: 'ast_1' }).success).toBe(false);
    expect(
      assetViewSchema.safeParse({ ...view, id: 'asset_0r3h7k4xw0c8g1n5p2q6v9m3yt' }).success,
    ).toBe(false);
  });

  it('maps every asset type to exactly one identifier kind', () => {
    expect(ASSET_TYPE_IDENTIFIER_KIND).toEqual({
      host: 'host',
      web_app: 'url',
      api: 'url',
      network_range: 'cidr',
      source_repo: 'repo',
    });
  });
});

describe('asset list items (wizard projection)', () => {
  const ITEM = {
    id: OWNER,
    name: 'Juice Shop (lab)',
    type: 'web_app',
    environment: 'dev',
    verificationStatus: 'verified',
  };

  it('refuses an item that carries identifiers, attestations or a public id', () => {
    expect(assetListItemSchema.safeParse(ITEM).success).toBe(true);
    expect(assetListItemSchema.safeParse({ ...ITEM, identifiers: [] }).success).toBe(false);
    expect(assetListItemSchema.safeParse({ ...ITEM, attestation: {} }).success).toBe(false);
    expect(assetListItemSchema.safeParse({ ...ITEM, publicId: 'asset_x' }).success).toBe(false);
  });

  it('accepts a page with a cursor and the first-version items-only answer', () => {
    expect(assetListResponseSchema.parse({ items: [ITEM] }).items).toHaveLength(1);
    expect(
      assetListResponseSchema.parse({ items: [ITEM], nextCursor: 'abc', hasMore: true }).hasMore,
    ).toBe(true);
    expect(assetListResponseSchema.safeParse({ items: [], owner: 'x' }).success).toBe(false);
  });
});
