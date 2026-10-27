// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HaltTimeBadge } from './halt-time-badge';
import { KillButton, type KillButtonProps } from './kill-button';
import { createApiClient } from '../../../../../lib/api-client';
import { setClientEventSink, type ClientEvent } from '../../../../../lib/client-events';

import type { KillableRun, KillEventView } from './kill-model';

// Dialog + user-event interaction is slow on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);

const RUN_UUID = '01890a5d-ac96-774b-bcce-b302099a8058';
const PUBLIC_ID = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const TRIGGERED_AT = '2026-10-20T10:00:00.000Z';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const run = (over: Partial<KillableRun> = {}): KillableRun => ({
  id: RUN_UUID,
  publicId: PUBLIC_ID,
  state: 'executing',
  killEvent: null,
  ...over,
});

const accepted = (): Response =>
  new Response(
    JSON.stringify({
      killEventId: '01890a5d-ac96-774b-bcce-b302099a8057',
      status: 'initiated',
      triggeredAt: TRIGGERED_AT,
    }),
    { status: 202, headers: { 'content-type': 'application/json' } },
  );

const problem = (status: number, code: string): Response =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Problem',
      status,
      code,
      traceId: 'trace-1',
      detail: 'internal host db-7 secret=hunter2',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

function setup(responses: (() => Promise<Response>)[], props: Partial<KillButtonProps> = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const next of responses) fetchMock.mockImplementationOnce(() => next());
  const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const ui = (override: Partial<KillButtonProps> = {}): React.ReactElement => (
    <QueryClientProvider client={queryClient}>
      <KillButton
        run={run()}
        roles={['appsec_engineer']}
        client={client}
        {...props}
        {...override}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    fetchMock,
    rerender: (o?: Partial<KillButtonProps>) => {
      view.rerender(ui(o));
    },
    user: userEvent.setup(),
  };
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

async function openAndFill(
  user: ReturnType<typeof userEvent.setup>,
  { typed = PUBLIC_ID, reason = 'unexpected 5xx spike' } = {},
) {
  await user.click(screen.getByRole('button', { name: /kill run/i }));
  const dialog = await screen.findByRole('alertdialog');
  await fill(user, within(dialog).getByLabelText(/reason/i), reason);
  await fill(user, within(dialog).getByLabelText(/to confirm/i), typed);
  return dialog;
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error('no request');
  const [url, init] = call;
  return {
    url: typeof url === 'string' ? url : '',
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(typeof init?.body === 'string' ? init.body : '') as unknown,
  };
}

describe('KillButton role gating', () => {
  it.each([['developer'], ['auditor'], ['unknown_role']])('renders nothing for %s', (role) => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <KillButton run={run()} roles={[role]} ownsAsset />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no enabled kill button to an asset owner of someone else’s asset', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KillButton run={run()} roles={['asset_owner']} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('enables the button for an AppSec Engineer and for an Asset Owner of the asset', () => {
    setup([]);
    expect(screen.getByRole('button', { name: /kill run/i }).hasAttribute('disabled')).toBe(false);
    cleanup();
    setup([], { roles: ['asset_owner'], ownsAsset: true });
    expect(screen.getByRole('button', { name: /kill run/i }).hasAttribute('disabled')).toBe(false);
  });
});

describe('KillButton states', () => {
  it.each(['completed', 'released', 'killed', 'cancelled', 'failed', 'expired'] as const)(
    'is disabled for a %s run',
    (state) => {
      setup([], { run: run({ state }) });
      const button = screen.getByRole('button', { name: /run already ended/i });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(screen.queryByRole('button', { name: /^kill run$/i })).toBeNull();
    },
  );

  it('flips to killing when someone else starts a kill (stream kill.initiated)', () => {
    const { rerender } = setup([]);
    expect(screen.getByRole('button', { name: /kill run/i })).toBeTruthy();
    const killEvent: KillEventView = {
      status: 'initiated',
      initiatedAt: TRIGGERED_AT,
      gatewayBlockedMs: null,
      sandboxesTerminatedMs: null,
      completedAt: null,
      actor: 'Priya Nair',
    };
    rerender({ run: run({ killEvent }) });
    const button = screen.getByRole('button', { name: /killing/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('reflects a run that was killed without a local click', () => {
    setup([], {
      run: run({
        state: 'killed',
        killEvent: {
          status: 'halted',
          initiatedAt: TRIGGERED_AT,
          gatewayBlockedMs: 300,
          sandboxesTerminatedMs: 2000,
          completedAt: '2026-10-20T10:00:02.000Z',
          actor: 'Platform operator',
        },
      }),
    });
    expect(screen.getByRole('button', { name: /run already ended/i })).toBeTruthy();
  });
});

describe('KillButton confirmation and request', () => {
  it('describes the scope and the irreversibility in an alert dialog', async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole('button', { name: /kill run/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('stops all agents in this run');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain(PUBLIC_ID);
  });

  it('keeps Stop run disabled until the exact run id and a reason are typed, and sends nothing', async () => {
    const { user, fetchMock } = setup([]);
    const dialog = await openAndFill(user, { typed: 'run_wrong' });
    const stop = within(dialog).getByRole('button', { name: /stop run/i });
    expect(stop.hasAttribute('disabled')).toBe(true);
    await user.type(within(dialog).getByLabelText(/to confirm/i), '{Enter}');
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText(/to confirm/i));
    await fill(user, within(dialog).getByLabelText(/to confirm/i), PUBLIC_ID);
    expect(stop.hasAttribute('disabled')).toBe(false);
    await user.clear(within(dialog).getByLabelText(/reason/i));
    expect(stop.hasAttribute('disabled')).toBe(true);
  });

  it('posts the kill with an Idempotency-Key, shows killing, then the badge on completion', async () => {
    const events: ClientEvent[] = [];
    const restore = setClientEventSink((e) => events.push(e));
    const onAccepted = vi.fn();
    const { user, fetchMock, rerender } = setup([() => Promise.resolve(accepted())], {
      onAccepted,
    });
    const dialog = await openAndFill(user);
    await user.click(within(dialog).getByRole('button', { name: /stop run/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /killing/i })).toBeTruthy();
    });
    restore();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = lastRequest(fetchMock);
    expect(req.url).toBe('/v1/kill');
    expect(req.method).toBe('POST');
    expect(req.headers['Idempotency-Key']).toMatch(UUID_V7);
    expect(req.body).toEqual({
      scope: 'run',
      scopeRefId: RUN_UUID,
      reason: 'unexpected 5xx spike',
    });
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ status: 'initiated' }));
    expect(events).toEqual([
      {
        event: 'kill_requested',
        route: '/assessments/:id',
        runId: PUBLIC_ID,
        idempotencyKey: req.headers['Idempotency-Key'],
      },
    ]);

    // Still "killing" with a stale run and no halt time: the UI must not claim a stop yet.
    expect(screen.queryByText(/halted in/i)).toBeNull();

    const killEvent: KillEventView = {
      status: 'halted',
      initiatedAt: TRIGGERED_AT,
      gatewayBlockedMs: 400,
      sandboxesTerminatedMs: 3100,
      completedAt: '2026-10-20T10:00:03.300Z',
      actor: 'Priya Nair',
    };
    rerender({ run: run({ state: 'killed', killEvent }) });
    expect(screen.getByRole('button', { name: /run already ended/i })).toBeTruthy();
    cleanup();
    render(<HaltTimeBadge killEvent={killEvent} />);
    expect(screen.getByText('Halted in 3.3 s')).toBeTruthy();
    expect(screen.getByText('by Priya Nair')).toBeTruthy();
  });

  it('sends one request on a double click and on rapid Enter presses', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { user, fetchMock } = setup([() => pending]);
    const dialog = await openAndFill(user);
    const stop = within(dialog).getByRole('button', { name: /stop run/i });
    await user.dblClick(stop);
    await user.type(within(dialog).getByLabelText(/to confirm/i), '{Enter}{Enter}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(accepted());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /killing/i })).toBeTruthy();
    });
  });

  it('shows a clear error on a 5xx, stays open, and retries with the same Idempotency-Key', async () => {
    const { user, fetchMock } = setup([
      () => Promise.resolve(problem(503, 'INTERNAL')),
      () => Promise.resolve(accepted()),
    ]);
    const dialog = await openAndFill(user);
    await user.click(within(dialog).getByRole('button', { name: /stop run/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('not confirmed stopped');
    expect(alert.textContent).toContain('trace-1');
    expect(alert.textContent).not.toContain('hunter2');
    const stop = within(dialog).getByRole('button', { name: /stop run/i });
    expect(stop.hasAttribute('disabled')).toBe(false);

    await user.click(stop);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /killing/i })).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRequest(fetchMock, 1).headers['Idempotency-Key']).toBe(
      lastRequest(fetchMock, 0).headers['Idempotency-Key'],
    );
  });

  it('uses a new Idempotency-Key when the reason changed after a failure', async () => {
    const { user, fetchMock } = setup([
      () => Promise.reject(new TypeError('offline')),
      () => Promise.resolve(accepted()),
    ]);
    const dialog = await openAndFill(user);
    await user.click(within(dialog).getByRole('button', { name: /stop run/i }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('could not reach the server');

    await fill(user, within(dialog).getByLabelText(/reason/i), ' again');
    await user.click(within(dialog).getByRole('button', { name: /stop run/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /killing/i })).toBeTruthy();
    });
    expect(lastRequest(fetchMock, 1).headers['Idempotency-Key']).not.toBe(
      lastRequest(fetchMock, 0).headers['Idempotency-Key'],
    );
    expect(lastRequest(fetchMock, 1).body).toMatchObject({ reason: 'unexpected 5xx spike again' });
  });

  it('hides the button and says forbidden when the server answers 403', async () => {
    const { user } = setup([() => Promise.resolve(problem(403, 'KILL_FORBIDDEN'))]);
    const dialog = await openAndFill(user);
    await user.click(within(dialog).getByRole('button', { name: /stop run/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no longer have permission');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('can be cancelled without a request', async () => {
    const { user, fetchMock } = setup([]);
    const dialog = await openAndFill(user);
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /kill run/i })).toBeTruthy();
  });
});
