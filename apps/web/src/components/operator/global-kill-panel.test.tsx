// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobalKillPanel } from './global-kill-panel';
import { ApiError } from '../../lib/api-error';

import type { OperatorKillApi } from '../../lib/operator-kill-api';
import type {
  KillTriggerResponse,
  OperatorBlastRadius,
  OperatorKillEventDetail,
  OperatorKillEventSummary,
} from '@blackwing/contracts';

afterEach(cleanup);

const TENANT = '01890a5d-ac96-774b-bcce-b302099a8057';
const EVENT = '01890a5d-ac96-774b-bcce-b302099a8058';
const FIRED = '2026-10-20T10:00:00.000Z';
const plus = (ms: number): string => new Date(Date.parse(FIRED) + ms).toISOString();

const RADIUS: OperatorBlastRadius = {
  runsAffected: 7,
  sandboxesAffected: 11,
  tenantsAffected: 3,
  sessionsAffected: 13,
};

function detail(patch: Partial<OperatorKillEventDetail> = {}): OperatorKillEventDetail {
  return {
    id: EVENT,
    scope: 'global',
    tenantId: null,
    actor: 'op-1',
    reason: 'platform incident',
    firedAt: FIRED,
    haltMs: null,
    status: 'initiated',
    egressBlockedAt: null,
    sandboxesTerminatedAt: null,
    keysRevokedAt: null,
    workflowsCancelledAt: null,
    completedAt: null,
    affected: {},
    ...patch,
  };
}

const problem = (status: number, code: string, detailText?: string): ApiError =>
  new ApiError({ status, code, title: code, detail: detailText, traceId: 't1' });

function fakeApi(overrides: Partial<OperatorKillApi> = {}) {
  const api = {
    blastRadius: vi.fn<OperatorKillApi['blastRadius']>(() => Promise.resolve(RADIUS)),
    fire: vi.fn<OperatorKillApi['fire']>((): Promise<KillTriggerResponse> =>
      Promise.resolve({ killEventId: EVENT, status: 'initiated', triggeredAt: FIRED }),
    ),
    events: vi.fn<OperatorKillApi['events']>(() => Promise.resolve([])),
    event: vi.fn<OperatorKillApi['event']>(() => Promise.resolve(detail())),
    ...overrides,
  };
  return api;
}

function renderPanel(api: OperatorKillApi) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <GlobalKillPanel api={api} pollIntervalMs={10} />
    </QueryClientProvider>,
  );
  return { user, ...view };
}

/** Sets a field's value in one event; `user.type` is far too slow for long phrases on a busy CI box. */
const fill = (label: string | RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const fireButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^fire kill$/i });

/** Previews, then fills the reason and the confirmation phrase. */
async function readyToFire(user: ReturnType<typeof userEvent.setup>, phrase = 'GLOBAL') {
  await user.click(await screen.findByRole('button', { name: /preview blast radius/i }));
  await waitFor(() => {
    expect(screen.queryByText(/preview the blast radius before/i)).toBeNull();
  });
  fill('Reason', 'platform incident');
  fill(/^type .* to confirm$/i, phrase);
}

describe('GlobalKillPanel: blast radius before firing', () => {
  it('cannot fire until the blast radius has been previewed, then shows its counts', async () => {
    const api = fakeApi();
    const { user } = renderPanel(api);
    fill('Reason', 'platform incident');
    fill(/to confirm$/i, 'GLOBAL');
    expect(fireButton().disabled).toBe(true);
    expect(screen.getByText(/preview the blast radius before you can fire/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /preview blast radius/i }));
    const radius = await screen.findByLabelText('Blast radius');
    expect(within(radius).getByText('7')).toBeTruthy();
    expect(within(radius).getByText('11')).toBeTruthy();
    expect(within(radius).getByText('13')).toBeTruthy();
    expect(within(radius).getByText('3')).toBeTruthy();
    expect(fireButton().disabled).toBe(false);
    expect(api.blastRadius).toHaveBeenCalledWith('global', undefined);
    expect(api.fire).not.toHaveBeenCalled();
  });

  it('allows an emergency kill with an explicit warning when the blast radius is unavailable', async () => {
    const api = fakeApi({
      blastRadius: vi.fn(() => Promise.reject(problem(503, 'DB_UNAVAILABLE'))),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    expect(screen.getByText(/blast radius unavailable/i).textContent).toMatch(/radius is unknown/i);
    expect(fireButton().disabled).toBe(false);
    await user.click(fireButton());
    await waitFor(() => {
      expect(api.fire).toHaveBeenCalledTimes(1);
    });
  });

  it('blocks a tenant kill whose tenant does not exist', async () => {
    const api = fakeApi({ blastRadius: vi.fn(() => Promise.reject(problem(404, 'NOT_FOUND'))) });
    const { user } = renderPanel(api);
    await user.click(screen.getByLabelText(/one tenant/i));
    fill('Tenant id', TENANT);
    await user.click(screen.getByRole('button', { name: /preview blast radius/i }));
    await screen.findByText(/NOT_FOUND/);
    fill('Reason', 'customer request');
    fill(/to confirm$/i, `KILL ${TENANT}`);
    expect(fireButton().disabled).toBe(true);
  });
});

describe('GlobalKillPanel: typed confirmation', () => {
  it('keeps Fire disabled for any mismatch and enables it only for the exact phrase and a reason', async () => {
    const { user } = renderPanel(fakeApi());
    await user.click(await screen.findByRole('button', { name: /preview blast radius/i }));
    await screen.findByLabelText('Blast radius');
    const phrase = screen.getByLabelText(/to confirm$/i);
    const reason = screen.getByLabelText('Reason');

    fireEvent.change(reason, { target: { value: 'platform incident' } });
    for (const wrong of ['global', 'GLOBA', 'GLOBAL!', 'KILL']) {
      fill(/to confirm$/i, wrong);
      expect(fireButton().disabled, wrong).toBe(true);
    }
    fireEvent.change(phrase, { target: { value: 'GLOBAL' } });
    expect(fireButton().disabled).toBe(false);

    fireEvent.change(reason, { target: { value: 'ab' } });
    expect(fireButton().disabled).toBe(true);
  });

  it('asks for KILL plus the tenant slug for a tenant kill and sends the tenant id', async () => {
    const api = fakeApi({
      blastRadius: vi.fn(() => Promise.resolve({ ...RADIUS, tenantSlug: 'acme' })),
    });
    const { user } = renderPanel(api);
    await user.click(screen.getByLabelText(/one tenant/i));
    const preview = screen.getByRole('button', { name: /preview blast radius/i });
    expect((preview as HTMLButtonElement).disabled).toBe(true);
    fill('Tenant id', TENANT);
    await user.click(preview);
    await screen.findByLabelText('Blast radius');
    expect(screen.getByLabelText('Type KILL acme to confirm')).toBeTruthy();
    fill('Reason', 'customer request');
    fill(/to confirm$/i, 'KILL globex');
    expect(fireButton().disabled).toBe(true);
    fill(/to confirm$/i, 'KILL acme');
    await user.click(fireButton());
    await waitFor(() => {
      expect(api.fire).toHaveBeenCalledWith(
        { scope: 'tenant', tenantId: TENANT, reason: 'customer request' },
        expect.any(String),
      );
    });
  });
});

describe('GlobalKillPanel: halt progress (simulated kill)', () => {
  it('shows each phase as the kill path confirms it, then the measured halt time and SLA breaches', async () => {
    const steps = [
      detail({ status: 'propagating', egressBlockedAt: plus(2600) }),
      detail({
        status: 'halted',
        egressBlockedAt: plus(2600),
        sandboxesTerminatedAt: plus(11_000),
        keysRevokedAt: plus(11_100),
        workflowsCancelledAt: plus(11_200),
        completedAt: plus(11_200),
        haltMs: 11_200,
      }),
    ];
    let reads = 0;
    const api = fakeApi({
      event: vi.fn(() => Promise.resolve(steps[Math.min(reads++, steps.length - 1)] ?? detail())),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());

    // Mid-kill: the gateway phase is confirmed, nothing claims the kill is done.
    await screen.findByText('Stopping now');
    expect(screen.queryByText('All testing stopped')).toBeNull();
    const gateway = document.querySelector('[data-phase="gateway"]');
    expect(gateway?.textContent).toContain('Confirmed at 2.6 s');
    expect(document.querySelector('[data-phase="sandboxes"]')?.textContent).toContain(
      'Waiting for confirmation',
    );

    // Final: halt time and both SLA breaches (gateway > 2 s, sandboxes > 10 s).
    await screen.findByText('All testing stopped');
    expect(screen.getByTestId('halt-time').textContent).toBe('11.2 s');
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.join(' ')).toMatch(/gateway block was slower than the 2\.0 s target/i);
    expect(alerts.join(' ')).toMatch(/sandbox termination was slower than the 10\.0 s target/i);
    expect(screen.getByRole('button', { name: /start another kill/i })).toBeTruthy();
  });

  it('flags nothing when both phases met their targets', async () => {
    const api = fakeApi({
      event: vi.fn(() =>
        Promise.resolve(
          detail({
            status: 'halted',
            egressBlockedAt: plus(400),
            sandboxesTerminatedAt: plus(3100),
            keysRevokedAt: plus(3200),
            workflowsCancelledAt: plus(3300),
            completedAt: plus(3300),
            haltMs: 3300,
          }),
        ),
      ),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText('All testing stopped');
    expect(screen.getByTestId('halt-time').textContent).toBe('3.3 s');
    expect(screen.queryByText(/slower than/i)).toBeNull();
  });

  it('shows a partial kill as partial, naming the component that did not stop, never "all stopped"', async () => {
    const api = fakeApi({
      event: vi.fn(() =>
        Promise.resolve(
          detail({
            status: 'partially_halted',
            egressBlockedAt: plus(300),
            sandboxesTerminatedAt: plus(9000),
            haltMs: 9000,
            affected: { sandboxResults: [{ sandboxId: 'sbx-b1', outcome: 'failed' }] },
          }),
        ),
      ),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText('Kill only partly completed');
    expect(screen.queryByText('All testing stopped')).toBeNull();
    expect(screen.getByText(/sandbox sbx-b1/)).toBeTruthy();
  });

  it('says nothing was running when the kill completed in zero time', async () => {
    const api = fakeApi({
      fire: vi.fn<OperatorKillApi['fire']>(() =>
        Promise.resolve({ killEventId: EVENT, status: 'halted', triggeredAt: FIRED }),
      ),
      event: vi.fn(() =>
        Promise.resolve(detail({ status: 'halted', haltMs: 0, completedAt: FIRED })),
      ),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/nothing in scope was running/i);
    expect(screen.getByTestId('halt-time').textContent).toBe('0.0 s');
  });

  it('does not claim success when the status cannot be read', async () => {
    const api = fakeApi({ event: vi.fn(() => Promise.reject(problem(503, 'INTERNAL'))) });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/kill status is unavailable/i);
    expect(screen.queryByText('All testing stopped')).toBeNull();
  });
});

describe('GlobalKillPanel: errors', () => {
  it('reports an unreachable kill path as not confirmed and reuses the Idempotency-Key on retry', async () => {
    const fire = vi
      .fn<OperatorKillApi['fire']>()
      .mockRejectedValueOnce(
        problem(503, 'TEMPORAL_UNAVAILABLE', 'the kill path could not be reached'),
      )
      .mockResolvedValue({ killEventId: EVENT, status: 'initiated', triggeredAt: FIRED });
    const api = fakeApi({ fire });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/the kill was not confirmed/i);
    expect(screen.queryByText('All testing stopped')).toBeNull();
    await user.click(fireButton());
    await waitFor(() => {
      expect(fire).toHaveBeenCalledTimes(2);
    });
    expect(fire.mock.calls[1]?.[1]).toBe(fire.mock.calls[0]?.[1]);
  });

  it('uses a new Idempotency-Key once the reason changes', async () => {
    const fire = vi
      .fn<OperatorKillApi['fire']>()
      .mockRejectedValue(problem(422, 'VALIDATION_FAILED', 'invalid fields: reason'));
    const { user } = renderPanel(fakeApi({ fire }));
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/the kill was not confirmed/i);
    fill('Reason', 'platform incident again');
    await user.click(fireButton());
    await waitFor(() => {
      expect(fire).toHaveBeenCalledTimes(2);
    });
    expect(fire.mock.calls[1]?.[1]).not.toBe(fire.mock.calls[0]?.[1]);
  });

  it('follows the kill already in progress instead of firing a duplicate', async () => {
    const open: OperatorKillEventSummary = {
      id: EVENT,
      scope: 'global',
      tenantId: null,
      actor: 'op-2',
      reason: 'incident',
      firedAt: FIRED,
      haltMs: null,
      status: 'propagating',
    };
    const api = fakeApi({
      fire: vi.fn(() =>
        Promise.reject(
          problem(409, 'KILL_ALREADY_IN_PROGRESS', `kill ${EVENT} is already in progress`),
        ),
      ),
      events: vi.fn(() => Promise.resolve([open])),
      event: vi.fn(() => Promise.resolve(detail({ status: 'propagating' }))),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/a kill is already in progress for this scope/i);
    await screen.findByText('Stopping now');
    expect(api.fire).toHaveBeenCalledTimes(1);
    expect(api.event).toHaveBeenCalledWith(EVENT, expect.anything());
  });

  it('surfaces KILL_PARTIAL from the API', async () => {
    const api = fakeApi({
      fire: vi.fn(() =>
        Promise.reject(problem(424, 'KILL_PARTIAL', 'kill x did not stop: sandbox sbx-1')),
      ),
    });
    const { user } = renderPanel(api);
    await readyToFire(user);
    await user.click(fireButton());
    await screen.findByText(/the kill only partly completed/i);
    expect(screen.getByText(/sandbox sbx-1/)).toBeTruthy();
  });
});

describe('GlobalKillPanel: operator only and history', () => {
  it('shows permission denied, and no controls, to a caller the API refuses', async () => {
    const api = fakeApi({ events: vi.fn(() => Promise.reject(problem(403, 'NOT_OPERATOR'))) });
    renderPanel(api);
    await screen.findByText(/you do not have access/i);
    expect(screen.queryByRole('button', { name: /fire kill/i })).toBeNull();
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });

  it('lists prior kills with their halt times', async () => {
    const api = fakeApi({
      events: vi.fn(() =>
        Promise.resolve([
          {
            id: EVENT,
            scope: 'tenant' as const,
            tenantId: TENANT,
            actor: 'op-7',
            reason: 'customer request',
            firedAt: FIRED,
            haltMs: 3300,
            status: 'halted' as const,
          },
          {
            id: '01890a5d-ac96-774b-bcce-b302099a8059',
            scope: 'global' as const,
            tenantId: null,
            actor: 'op-8',
            reason: 'drill',
            firedAt: FIRED,
            haltMs: null,
            status: 'failed' as const,
          },
        ]),
      ),
    });
    renderPanel(api);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('3.3 s')).toBeTruthy();
    expect(within(table).getByText('Not measured')).toBeTruthy();
    expect(within(table).getByText('failed')).toBeTruthy();
    expect(within(table).getByText('customer request')).toBeTruthy();
  });

  it('has no accessibility violations in its initial and previewed states', async () => {
    const { user, container } = renderPanel(fakeApi());
    await screen.findByText(/no operator kill has been fired/i);
    expect((await axe.run(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: /preview blast radius/i }));
    await screen.findByLabelText('Blast radius');
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
