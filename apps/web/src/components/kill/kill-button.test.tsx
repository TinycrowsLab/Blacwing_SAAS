// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import * as React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { KillButton, type KillButtonProps } from './kill-button';
import { createApiClient } from '../../lib/api-client';
import { createTenantKillApi } from '../../lib/tenant-kill-api';

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanup);

const RUN_ID = '01890a5d-ac96-774b-bcce-b302099a8058';
const KILL_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const ACCEPTED = {
  killEventId: KILL_ID,
  status: 'initiated',
  triggeredAt: '2026-10-20T10:00:00.000Z',
};

/** The JSON body a request was sent with. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(
  responses: Response[] = [],
  props: Partial<KillButtonProps> = {},
): { fetch: Mock<typeof fetch>; onAccepted: Mock } {
  const fetchMock = vi.fn<typeof fetch>();
  for (const next of responses) fetchMock.mockResolvedValueOnce(next);
  const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock });
  const onAccepted = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <KillButton
        scope="run"
        scopeRefId={RUN_ID}
        roles={['org_admin']}
        onAccepted={onAccepted}
        api={createTenantKillApi(client)}
        {...props}
      />
    </QueryClientProvider>
  );
  render(ui);
  return { fetch: fetchMock, onAccepted };
}

async function openDialog(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Stop testing' }));
}

describe('kill.ui.rbac: the kill button is shown by role', () => {
  it.each([
    ['developer', ['developer'], false],
    ['appsec engineer', ['appsec_engineer'], true],
    ['org admin', ['org_admin'], true],
  ])('run kill for %s', (_label, roles, visible) => {
    setup([], { roles });
    expect(screen.queryByRole('button', { name: 'Stop testing' }) !== null).toBe(visible);
  });

  it('hides the asset control from an asset owner who does not own the asset', () => {
    setup([], { scope: 'asset', scopeRefId: RUN_ID, roles: ['asset_owner'], ownsAsset: false });
    expect(screen.queryByRole('button', { name: 'Stop testing' })).toBeNull();
  });

  it('shows the asset control to an asset owner of that asset', () => {
    setup([], { scope: 'asset', scopeRefId: RUN_ID, roles: ['asset_owner'], ownsAsset: true });
    expect(screen.getByRole('button', { name: 'Stop testing' })).toBeTruthy();
  });

  it('shows the tenant control only to an org admin', () => {
    setup([], { scope: 'tenant', scopeRefId: undefined, roles: ['appsec_engineer'] });
    expect(screen.queryByRole('button', { name: 'Stop testing' })).toBeNull();
  });
});

describe('KillButton confirmation and request', () => {
  it('keeps "Stop testing now" disabled until the reason is valid', async () => {
    setup();
    await openDialog();
    const confirm = screen.getByRole('button', { name: 'Stop testing now' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Reason/), 'ab');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Reason/), 'c');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the scoped request with an Idempotency-Key and reports the accepted kill', async () => {
    const { fetch, onAccepted } = setup([jsonResponse(202, ACCEPTED)]);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Reason/), '  change freeze  ');
    await userEvent.click(screen.getByRole('button', { name: 'Stop testing now' }));
    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalledWith(KILL_ID);
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/v1/kill');
    expect(JSON.parse(bodyOf(init))).toEqual({
      scope: 'run',
      scopeRefId: RUN_ID,
      reason: 'change freeze',
    });
    expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/.{8,}/);
  });

  it('sends no scopeRefId for a tenant kill', async () => {
    const { fetch } = setup([jsonResponse(202, ACCEPTED)], {
      scope: 'tenant',
      scopeRefId: undefined,
      roles: ['org_admin'],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Stop testing' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'quarter end freeze');
    await userEvent.click(screen.getByRole('button', { name: 'Stop testing now' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const body: unknown = JSON.parse(bodyOf(fetch.mock.calls[0]?.[1]));
    expect(body).toEqual({ scope: 'tenant', reason: 'quarter end freeze' });
  });

  it('replaces the control with an inline message on a 403, with no retry button', async () => {
    setup([
      jsonResponse(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        code: 'KILL_FORBIDDEN',
      }),
    ]);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Reason/), 'change freeze');
    await userEvent.click(screen.getByRole('button', { name: 'Stop testing now' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You are not permitted to stop this run.',
    );
    expect(screen.queryByRole('button', { name: 'Stop testing' })).toBeNull();
  });
});

describe('KillButton accessibility', () => {
  it('the open confirm dialog has no axe violations and labels its fields', async () => {
    setup();
    await openDialog();
    expect(screen.getByLabelText(/Reason/)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
