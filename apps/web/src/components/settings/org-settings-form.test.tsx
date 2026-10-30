// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgSettingsForm } from './org-settings-form';
import { ApiError } from '../../lib/api-error';

import type { OrgSettingsApi } from '../../lib/org-settings-api';
import type { OrgProfile } from '@blackwing/contracts';

const PROFILE: OrgProfile = {
  name: 'Acme Security',
  slug: 'acme',
  region: 'eu-west-1',
  plan: 'team',
  status: 'active',
  defaultTimezone: 'Europe/Berlin',
  supportContactEmail: 'soc@acme.test',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

afterEach(cleanup);

function fakeApi(overrides: Partial<OrgSettingsApi> = {}): OrgSettingsApi {
  return {
    get: vi.fn(() => Promise.resolve(PROFILE)),
    update: vi.fn((body: Partial<OrgProfile>) => Promise.resolve({ ...PROFILE, ...body })),
    ...overrides,
  };
}

function renderForm(api: OrgSettingsApi, canEdit = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OrgSettingsForm api={api} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

const nameInput = () => screen.findByLabelText<HTMLInputElement>('Organisation name');
const timezoneInput = () => screen.findByLabelText<HTMLInputElement>('Default time zone');
const emailInput = () => screen.findByLabelText<HTMLInputElement>('Support contact e-mail');

describe('OrgSettingsForm', () => {
  it('shows the current profile, with the slug, region, plan and status read-only', async () => {
    renderForm(fakeApi());
    expect((await nameInput()).value).toBe('Acme Security');
    expect((await timezoneInput()).value).toBe('Europe/Berlin');
    expect((await emailInput()).value).toBe('soc@acme.test');
    for (const label of ['Slug', 'Data region', 'Plan', 'Status']) {
      expect(screen.getByLabelText<HTMLInputElement>(label).readOnly).toBe(true);
    }
    expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('acme');
  });

  it('shows an inline error for an empty name and sends nothing', async () => {
    const api = fakeApi();
    renderForm(api);
    fireEvent.change(await nameInput(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('must not be empty')).toBeTruthy();
    expect((await nameInput()).getAttribute('aria-invalid')).toBe('true');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('rejects a time zone that is not an IANA name, before anything is sent', async () => {
    const api = fakeApi();
    renderForm(api);
    fireEvent.change(await timezoneInput(), { target: { value: 'Mars/Olympus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/must be an IANA time zone name/)).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('rejects an over-long name with an inline error', async () => {
    const api = fakeApi();
    renderForm(api);
    fireEvent.change(await nameInput(), { target: { value: 'x'.repeat(121) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('must be at most 120 characters')).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('saves only the changed field, with Unicode preserved', async () => {
    const api = fakeApi();
    renderForm(api);
    fireEvent.change(await nameInput(), { target: { value: 'شركة الأمن 🛡️' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith({ name: 'شركة الأمن 🛡️' });
    });
  });

  it('clears the support contact when it is emptied, and sends null', async () => {
    const api = fakeApi();
    renderForm(api);
    fireEvent.change(await emailInput(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith({ supportContactEmail: null });
    });
  });

  it('sends nothing when no field changed', async () => {
    const api = fakeApi();
    renderForm(api);
    await nameInput();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.update).not.toHaveBeenCalled();
  });

  it('tells the user to reload on a stale ETag and does not overwrite anything', async () => {
    const api = fakeApi({
      update: vi.fn(() =>
        Promise.reject(
          new ApiError({ status: 412, code: 'etag_mismatch', title: 'ETag mismatch' }),
        ),
      ),
    });
    renderForm(api);
    fireEvent.change(await nameInput(), { target: { value: 'Late edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload profile' })).toBeTruthy();
  });

  it('shows no form to a caller who may read but not change the profile', async () => {
    renderForm(fakeApi(), false);
    const fieldset = (await nameInput()).closest('fieldset');
    expect(fieldset?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByText('Only a tenant administrator can change this.')).toBeTruthy();
  });

  it('shows the permission-denied state, not the form, when the read is refused', async () => {
    renderForm(
      fakeApi({
        get: vi.fn(() =>
          Promise.reject(new ApiError({ status: 403, code: 'permission_denied', title: 'Denied' })),
        ),
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Organisation profile' })).toBeNull();
    });
  });

  it('offers a retry when the API is down, and shows no partial form', async () => {
    renderForm(
      fakeApi({
        get: vi.fn(() =>
          Promise.reject(new ApiError({ status: 503, code: 'service_unavailable', title: 'Down' })),
        ),
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Organisation profile' })).toBeNull();
    });
  });

  it('has no accessibility violations in the editable form', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <OrgSettingsForm api={fakeApi()} />
      </QueryClientProvider>,
    );
    await nameInput();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
