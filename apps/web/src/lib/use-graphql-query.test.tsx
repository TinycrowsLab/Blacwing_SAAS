// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error.js';
import { defineQuery, type GraphQLClient } from './graphql-client.js';
import { useGraphQLQuery } from './use-graphql-query.js';

const countQuery = defineQuery<{ count: number }, { scope: string }>(
  'query RunCount($scope: String!) { count(scope: $scope) }',
);

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useGraphQLQuery', () => {
  it('returns typed data from the transport', async () => {
    const transport = {
      request: vi.fn(() => Promise.resolve({ data: { count: 3 }, warnings: [] })),
    } as GraphQLClient;
    const { result } = renderHook(
      () => useGraphQLQuery(countQuery, { scope: 'acme' }, { client: transport }),
      {
        wrapper: wrapper(freshClient()),
      },
    );
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.data.count).toBe(3);
    expect(transport.request).toHaveBeenCalledWith(
      countQuery,
      { scope: 'acme' },
      expect.any(Object),
    );
  });

  it('keys the cache by operation name and variables', async () => {
    const client = freshClient();
    const transport = {
      request: vi.fn(() => Promise.resolve({ data: { count: 1 }, warnings: [] })),
    } as GraphQLClient;
    const { result: a } = renderHook(
      () => useGraphQLQuery(countQuery, { scope: 'a' }, { client: transport }),
      {
        wrapper: wrapper(client),
      },
    );
    const { result: b } = renderHook(
      () => useGraphQLQuery(countQuery, { scope: 'b' }, { client: transport }),
      {
        wrapper: wrapper(client),
      },
    );
    await waitFor(() => {
      expect(a.current.isSuccess && b.current.isSuccess).toBe(true);
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('exposes a failure as an ApiError with its code and operation', async () => {
    const failure = new ApiError({
      status: 400,
      code: 'COMPLEXITY_LIMIT',
      title: 'Query too complex',
      operation: 'RunCount',
    });
    const transport = { request: vi.fn(() => Promise.reject(failure)) } as GraphQLClient;
    const { result } = renderHook(
      () => useGraphQLQuery(countQuery, { scope: 'acme' }, { client: transport }),
      {
        wrapper: wrapper(freshClient()),
      },
    );
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBe(failure);
  });

  it('does not run while disabled', () => {
    const transport = { request: vi.fn() } as GraphQLClient;
    renderHook(
      () => useGraphQLQuery(countQuery, { scope: 'acme' }, { client: transport, enabled: false }),
      {
        wrapper: wrapper(freshClient()),
      },
    );
    expect(transport.request).not.toHaveBeenCalled();
  });
});
