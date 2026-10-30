import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assetEnvironmentSchema,
  assetTypeSchema,
  verificationStatusSchema,
} from '@blackwing/contracts';

import {
  ASSET_PAGE_SIZE,
  assetFilterInput,
  type AssetFilterInput,
  type AssetListFilters,
} from './asset-filters.js';
import { createGraphQLClient, defineQuery, type GraphQLClient } from './graphql-client.js';
import { qk } from './query-keys.js';

/**
 * One asset row of the list: what the table shows, and nothing secret (no identifier, credential or attestation).
 * Parsed with the shared enums, so a value the console does not know fails the page instead of being shown.
 */
const assetRowSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: assetTypeSchema,
  environment: assetEnvironmentSchema,
  verification: z.object({ status: verificationStatusSchema }),
  owner: z.object({ name: z.string().nullable() }).nullable(),
  tags: z.array(z.object({ key: z.string(), value: z.string() })),
  groups: z.array(z.object({ name: z.string() })),
});
export type AssetRowData = z.infer<typeof assetRowSchema>;

/** One page of the asset list (keyset, newest first). */
const assetPageSchema = z.object({
  items: z.array(assetRowSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
type AssetPageData = z.infer<typeof assetPageSchema>;

/** The result shape of `ASSETS_QUERY`. */
interface AssetsData {
  readonly assets: AssetPageData;
}

/** The asset list read (ASSET-014). Read-only: mutations stay on REST. */
const ASSETS_QUERY = defineQuery<
  AssetsData,
  { readonly filter: AssetFilterInput; readonly cursor?: string; readonly limit: number }
>(`query Assets($filter: AssetFilter, $cursor: String, $limit: Int) {
  assets(filter: $filter, cursor: $cursor, limit: $limit) {
    hasMore
    nextCursor
    items {
      id
      name
      type
      environment
      verification { status }
      owner { name }
      tags { key value }
      groups { name }
    }
  }
}`);

/** The query key prefix of every asset list page; a create invalidates it. */
export const ASSET_LIST_KEY = ['graphql', ASSETS_QUERY.operationName] as const;

/**
 * Pages of the asset list for one filter state, through TanStack Query. Pages are fetched on "Load more" by the
 * cursor the previous page returned. The client is injectable so tests run without the network.
 */
export function useAssetPages(filters: AssetListFilters, client?: GraphQLClient) {
  const graphql = client ?? defaultGraphQLClient();
  const filter = assetFilterInput(filters);
  return useInfiniteQuery({
    queryKey: qk.graphql(ASSETS_QUERY.operationName, { filter, limit: ASSET_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await graphql.request(
        ASSETS_QUERY,
        {
          filter,
          limit: ASSET_PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        { signal },
      );
      return assetPageSchema.parse(result.data.assets);
    },
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor !== null ? last.nextCursor : undefined,
  });
}

let shared: GraphQLClient | undefined;
function defaultGraphQLClient(): GraphQLClient {
  shared ??= createGraphQLClient();
  return shared;
}
