import { describe, expect, it } from 'vitest';

import {
  assetListItemSchema,
  assetListResponseSchema,
  listAssetsQuerySchema,
} from './asset-api.js';

const ITEM = {
  id: '0198f0a0-0000-7000-8000-0000000000e1',
  name: 'Juice Shop (lab)',
  type: 'web_app',
  environment: 'dev',
  verificationStatus: 'verified',
};

describe('asset list contract (GET /v1/assets)', () => {
  it('accepts an empty query and a known verification filter', () => {
    expect(listAssetsQuerySchema.parse({})).toEqual({});
    expect(listAssetsQuerySchema.parse({ verificationStatus: 'verified' })).toEqual({
      verificationStatus: 'verified',
    });
  });

  it('refuses an unknown query parameter and an unknown verification state', () => {
    expect(listAssetsQuerySchema.safeParse({ tenantId: 'x' }).success).toBe(false);
    expect(listAssetsQuerySchema.safeParse({ verificationStatus: 'maybe' }).success).toBe(false);
  });

  it('accepts a list item and refuses an item that carries identifiers or attestations', () => {
    expect(assetListItemSchema.safeParse(ITEM).success).toBe(true);
    expect(assetListItemSchema.safeParse({ ...ITEM, identifiers: [] }).success).toBe(false);
    expect(assetListItemSchema.safeParse({ ...ITEM, attestation: {} }).success).toBe(false);
  });

  it('requires the asset id to be the UUID a request names in assetIds', () => {
    expect(
      assetListItemSchema.safeParse({ ...ITEM, id: 'asset_01m64cavacexhrddgjb6xd80xv' }).success,
    ).toBe(false);
    expect(assetListResponseSchema.parse({ items: [ITEM] }).items).toHaveLength(1);
  });
});
