// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepAssets } from './step-assets';

import type { AssetListItem } from '@blackwing/contracts';

afterEach(cleanup);

const VERIFIED_ID = '0198f0a0-0000-7000-8000-0000000000e1';
const UNVERIFIED_ID = '0198f0a0-0000-7000-8000-0000000000e2';

const ASSETS: AssetListItem[] = [
  {
    id: VERIFIED_ID,
    name: 'Juice Shop',
    type: 'web_app',
    environment: 'dev',
    verificationStatus: 'verified',
  },
  {
    id: UNVERIFIED_ID,
    name: 'Legacy API',
    type: 'api',
    environment: 'staging',
    verificationStatus: 'unverified',
  },
];

function renderStep(
  assets: AssetListItem[] | undefined,
  onSubmit = vi.fn(() => Promise.resolve()),
) {
  render(
    <StepAssets
      assets={assets}
      loading={false}
      defaultAssetIds={[]}
      pending={false}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
}

describe('StepAssets (scoping step 2)', () => {
  it('lets the user select a verified asset and submits only the selected ids', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep(ASSETS);
    await user.click(screen.getByRole('checkbox', { name: 'Select Juice Shop' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([VERIFIED_ID]);
    });
  });

  it('disables an unverified asset and links it to the asset page to verify it', () => {
    renderStep(ASSETS);
    const unverified = screen.getByRole('checkbox', { name: 'Select Legacy API' });
    expect(unverified.matches(':disabled')).toBe(true);
    const link = screen.getByRole('link', { name: 'Open asset' });
    expect(link.getAttribute('href')).toBe(`/assets/${UNVERIFIED_ID}`);
  });

  it('refuses to submit an empty selection and never calls the save', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep(ASSETS);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Select at least one verified asset.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('filters the list by name without changing the selection', async () => {
    const user = userEvent.setup();
    renderStep(ASSETS);
    await user.type(screen.getByRole('searchbox'), 'legacy');
    expect(screen.queryByRole('checkbox', { name: 'Select Juice Shop' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Legacy API' })).toBeTruthy();
  });

  it('shows the empty state when the tenant has no assets', () => {
    renderStep([]);
    expect(screen.getByText(/No assets in this tenant yet/)).toBeTruthy();
  });

  it('shows the list as unavailable when the asset read failed', () => {
    renderStep(undefined);
    expect(screen.getByText('The asset list is not available right now.')).toBeTruthy();
  });
});
