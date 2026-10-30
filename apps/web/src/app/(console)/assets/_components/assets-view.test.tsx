// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetsView } from './assets-view';
import { ApiError } from '../../../../lib/api-error';

import type { GraphQLClient } from '../../../../lib/graphql-client';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/assets',
  useSearchParams: () => new URLSearchParams(search),
}));

const OWNER = '018f2a6e-1c00-7000-8000-000000000001';

const ROW_A = {
  id: '018f2a6e-1c00-7000-8000-00000000000a',
  name: 'Checkout web',
  type: 'web_app',
  environment: 'prod',
  verification: { status: 'verified' },
  owner: { name: 'Ada Owner' },
  tags: [{ key: 'team', value: 'payments' }],
  groups: [{ name: 'Edge' }],
};
const ROW_B = {
  id: '018f2a6e-1c00-7000-8000-00000000000b',
  name: 'Build host',
  type: 'host',
  environment: 'dev',
  verification: { status: 'pending' },
  owner: null,
  tags: [],
  groups: [],
};

function page(items: readonly unknown[], hasMore = false) {
  return {
    data: { assets: { items, nextCursor: hasMore ? 'next-1' : null, hasMore } },
    warnings: [],
  };
}

function clientReturning(...responses: readonly ReturnType<typeof page>[]) {
  const request = vi.fn();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return { client: { request } as unknown as GraphQLClient, request };
}

function renderView(roles: readonly string[], client: GraphQLClient) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queries}>
      <AssetsView roles={roles} ownerUserId={OWNER} graphql={client} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  search = '';
  replace.mockReset();
});
afterEach(cleanup);

describe('AssetsView', () => {
  it('lists the assets with their verification badge and owner, and pages with Load more', async () => {
    const { client, request } = clientReturning(page([ROW_A, ROW_B], true), page([]));
    renderView(['asset_owner'], client);
    expect((await screen.findByRole('link', { name: 'Checkout web' })).getAttribute('href')).toBe(
      `/assets/${ROW_A.id}`,
    );
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('Ada Owner')).toBeTruthy();
    expect(screen.getByText('No owner')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: 'next-1' });
  });

  it('sends the URL filters to the server, and a filter change writes the URL', async () => {
    search = 'environment=prod&group=Edge';
    const { client, request } = clientReturning(page([ROW_A]));
    renderView(['developer'], client);
    await screen.findByRole('link', { name: 'Checkout web' });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      filter: { environment: 'prod', group: 'Edge' },
      limit: 50,
    });

    fireEvent.change(screen.getByLabelText('Verification'), { target: { value: 'verified' } });
    expect(replace).toHaveBeenLastCalledWith(
      '/assets?environment=prod&verificationStatus=verified&group=Edge',
      {
        scroll: false,
      },
    );
  });

  it('hides the create control for a read-only role and offers it to an asset owner', async () => {
    renderView(['developer'], clientReturning(page([ROW_A])).client);
    await screen.findByRole('link', { name: 'Checkout web' });
    expect(screen.queryByRole('button', { name: 'Register asset' })).toBeNull();
    cleanup();

    renderView(['asset_owner'], clientReturning(page([ROW_A])).client);
    await screen.findByRole('link', { name: 'Checkout web' });
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeTruthy();
  });

  it('shows an empty state with a create call to action when the tenant has no assets', async () => {
    renderView(['asset_owner'], clientReturning(page([])).client);
    expect(await screen.findByText('No assets yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Register asset' }).length).toBeGreaterThan(0);
  });

  it('says so when a filter matches nothing, and offers to clear it', async () => {
    search = 'type=api';
    renderView(['auditor'], clientReturning(page([])).client);
    expect(await screen.findByText('No asset matches these filters')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: 'Clear filters' })) {
      fireEvent.click(button);
    }
    expect(replace).toHaveBeenCalledWith('/assets', { scroll: false });
  });

  it('shows the permission-denied state for a forbidden read, and no rows', async () => {
    const request = vi.fn(() =>
      Promise.reject(new ApiError({ status: 403, code: 'FORBIDDEN', title: 'Forbidden' })),
    );
    renderView(['developer'], { request });
    expect(await screen.findByText(/permission/i)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a retry state for a failed read, and retries it', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'UNAVAILABLE', title: 'Down' }))
      .mockResolvedValueOnce(page([ROW_B]));
    renderView(['asset_owner'], { request });
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    expect(await screen.findByRole('link', { name: 'Build host' })).toBeTruthy();
  });

  it('renders tags beyond the first few behind a summary, not an unbounded cell', async () => {
    const many = { ...ROW_A, tags: ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, value: 'v' })) };
    renderView(['asset_owner'], clientReturning(page([many])).client);
    const row = (await screen.findByRole('link', { name: 'Checkout web' })).closest('tr');
    expect(within(row as HTMLElement).getByText(/\+2 more/)).toBeTruthy();
  });
});
