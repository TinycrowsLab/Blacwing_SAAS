import { useQuery } from '@tanstack/react-query';

import {
  createGraphQLClient,
  type GraphQLClient,
  type GraphQLQuery,
  type GraphQLResult,
} from './graphql-client.js';
import { qk } from './query-keys.js';

import type { ApiError } from './api-error.js';

const defaultClient = createGraphQLClient();

export interface UseGraphQLQueryOptions {
  /** Set false to hold the request until its inputs are known. */
  readonly enabled?: boolean;
  /** Test seam; defaults to the console's shared client. */
  readonly client?: GraphQLClient;
}

/**
 * Runs a read-only GraphQL document through TanStack Query. Failures are `ApiError`s, so the global handlers in
 * `makeQueryClient` (401, 403, 429, …) apply exactly as they do for REST. Mutations cannot reach this hook: it only
 * accepts a document made by `defineQuery`.
 */
export function useGraphQLQuery<TData, TVariables extends object>(
  query: GraphQLQuery<TData, TVariables>,
  variables: TVariables,
  options: UseGraphQLQueryOptions = {},
) {
  const client = options.client ?? defaultClient;
  return useQuery<GraphQLResult<TData>, ApiError>({
    queryKey: qk.graphql(query.operationName, variables),
    queryFn: ({ signal }) => client.request(query, variables, { signal }),
    enabled: options.enabled ?? true,
  });
}
