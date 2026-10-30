// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateAssetDialog } from './create-asset-dialog';
import { ApiError } from '../../lib/api-error';

import type { AssetApi } from '../../lib/asset-api';
import type { AssetView } from '@blackwing/contracts';

const OWNER = '018f2a6e-1c00-7000-8000-000000000001';
const ASSET_ID = '018f2a6e-1c00-7000-8000-000000000009';

afterEach(cleanup);

function renderDialog(api: AssetApi, onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CreateAssetDialog open onOpenChange={onOpenChange} ownerUserId={OWNER} api={api} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

function fillForm(identifiers: string) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Checkout' } });
  fireEvent.change(screen.getByLabelText('Identifiers, one per line'), {
    target: { value: identifiers },
  });
}

describe('CreateAssetDialog', () => {
  it('shows an inline error for an invalid identifier before anything is sent', async () => {
    const create = vi.fn<AssetApi['create']>();
    renderDialog({ create });
    fillForm('https://ok.test\nnot a url');
    fireEvent.blur(screen.getByLabelText('Identifiers, one per line'));
    expect(await screen.findByText('Line 2: Expected an absolute URL')).toBeTruthy();
    expect(screen.getByLabelText('Identifiers, one per line').getAttribute('aria-invalid')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Register asset' }));
    await waitFor(() => {
      expect(screen.getByText('Line 2: Expected an absolute URL')).toBeTruthy();
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the contract body with the owner, then closes', async () => {
    const created: AssetView = {
      id: ASSET_ID,
      publicId: 'asset_01hzx0000000000000000000ab',
      type: 'web_app',
      name: 'Checkout',
      identifiers: [{ kind: 'url', value: 'https://checkout.test/' }],
      environment: 'dev',
      ownerUserId: OWNER,
      verificationStatus: 'unverified',
      verificationMethod: null,
      etag: '"v1"',
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z',
      warnings: [],
    };
    const create = vi.fn<AssetApi['create']>(() => Promise.resolve(created));
    const { onOpenChange } = renderDialog({ create });
    fillForm('https://checkout.test/');
    fireEvent.click(screen.getByRole('button', { name: 'Register asset' }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(create).toHaveBeenCalledWith({
      type: 'web_app',
      name: 'Checkout',
      environment: 'dev',
      ownerUserId: OWNER,
      identifiers: [{ kind: 'url', value: 'https://checkout.test/' }],
    });
  });

  it('keeps the form open and shows fixed copy when the server refuses the asset', async () => {
    const create = vi.fn<AssetApi['create']>(() =>
      Promise.reject(
        new ApiError({
          status: 422,
          code: 'ASSET_INVALID_IDENTIFIER',
          title: 'Invalid',
          detail: 'secret-looking detail https://leak.test',
        }),
      ),
    );
    const { onOpenChange } = renderDialog({ create });
    fillForm('https://checkout.test/');
    fireEvent.click(screen.getByRole('button', { name: 'Register asset' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/leak\.test/)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('has no accessibility violations in its open state', async () => {
    renderDialog({ create: vi.fn<AssetApi['create']>() });
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
