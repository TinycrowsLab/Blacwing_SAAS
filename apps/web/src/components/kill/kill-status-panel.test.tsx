// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KillStatusPanel } from './kill-status-panel';
import { createApiClient } from '../../lib/api-client';
import { createTenantKillApi } from '../../lib/tenant-kill-api';

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanup);

const KILL_ID = '01890a5d-ac96-774b-bcce-b302099a8058';
const T0 = '2026-10-20T10:00:00.000Z';

const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  killEventId: KILL_ID,
  tenantId: '01890a5d-ac96-774b-bcce-b302099a8057',
  scope: 'run',
  scopeRefId: '01890a5d-ac96-774b-bcce-b302099a8056',
  source: 'console',
  actorType: 'user',
  actorRef: 'user:ada',
  reason: 'change freeze',
  status: 'halted',
  triggeredAt: T0,
  egressBlockedAt: '2026-10-20T10:00:01.000Z',
  sandboxesTerminatedAt: '2026-10-20T10:00:03.000Z',
  keysRevokedAt: '2026-10-20T10:00:03.500Z',
  workflowsCancelledAt: '2026-10-20T10:00:03.300Z',
  completedAt: '2026-10-20T10:00:03.300Z',
  haltMs: 3300,
  affected: {},
  reenabledAt: null,
  reenabledBy: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

function renderPanel(body: unknown, status = 200): void {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock, timeoutMs: 5000 });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <KillStatusPanel killEventId={KILL_ID} api={createTenantKillApi(client)} onReset={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('KillStatusPanel', () => {
  it('shows the server-measured halt time once the kill has halted', async () => {
    renderPanel(view());
    expect(await screen.findByText('All testing stopped')).toBeTruthy();
    expect(screen.getByTestId('kill-halt-ms').textContent).toBe('3.3 s');
  });

  it('shows a zero-length halt gracefully, with nothing to stop', async () => {
    renderPanel(
      view({
        haltMs: 0,
        egressBlockedAt: null,
        sandboxesTerminatedAt: null,
        keysRevokedAt: null,
        workflowsCancelledAt: null,
      }),
    );
    expect((await screen.findByTestId('kill-halt-ms')).textContent).toBe('0 ms');
    expect(screen.getAllByText('Nothing in scope to stop').length).toBeGreaterThan(0);
  });

  it('names an unconfirmed stage on a partially halted kill', async () => {
    renderPanel(
      view({ status: 'partially_halted', keysRevokedAt: null, haltMs: null, completedAt: null }),
    );
    await waitFor(() => {
      expect(screen.getByText('Not confirmed: still running')).toBeTruthy();
    });
    expect(screen.getByTestId('kill-halt-ms').textContent).toBe('Measuring');
  });
});
