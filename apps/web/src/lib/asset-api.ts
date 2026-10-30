import { type AssetView, assetViewSchema, type CreateAssetBody } from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client';

/** Asset writes through the BFF `/v1` (session cookie, no token in JS). Reads go through GraphQL (asset-queries). */
export interface AssetApi {
  /** Registers an asset. It starts `unverified` on the server (§8.10). An Idempotency-Key is sent with every create. */
  create: (body: CreateAssetBody) => Promise<AssetView>;
}

export function createAssetApi(client: ApiClient = createApiClient()): AssetApi {
  return {
    create: (body) => client.post('/assets', assetViewSchema, body),
  };
}
