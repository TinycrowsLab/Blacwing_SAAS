// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { Gate1Review, type Gate1ReviewProps } from './gate1-review';
import { ApiError } from '../../../../../../lib/api-error';
import { setClientEventSink, type ClientEvent } from '../../../../../../lib/client-events';

import type { Gate1Api } from '../../../../../../lib/gate1-api';
import type { Gate1DecisionResponse, Gate1PlanView } from '@blackwing/contracts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';
const APPROVER_ROLES = ['asset_owner'];

const plan = (over: Partial<Gate1PlanView> = {}): Gate1PlanView => ({
  runId: RUN,
  runState: 'awaiting_gate1',
  planVersion: 3,
  requesterId: REQUESTER,
  requestedAt: '2026-10-29T08:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  testCases: [
    {
      id: 'tc-1',
      title: 'Security headers reviewed',
      class: 'passive',
      targets: ['https://lab.example.test/'],
      budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 100 },
    },
  ],
  budgetTotals: { maxRequests: 10, maxBytes: 100 },
  changes: null,
  viewer: { canDecide: true, isRequester: false },
  ...over,
});

const decided = (decision: Gate1DecisionResponse['decision']): Gate1DecisionResponse => ({
  runId: RUN,
  decision,
  planVersion: 3,
  runState: decision === 'approve' ? 'approved' : decision === 'reject' ? 'cancelled' : 'planning',
  decidedAt: '2026-10-29T10:00:00.000Z',
});

type FakeApi = Gate1Api & {
  plan: Mock<Gate1Api['plan']>;
  decide: Mock<Gate1Api['decide']>;
};

function fakeApi(options: { view?: Gate1PlanView; decide?: Gate1Api['decide'] } = {}): FakeApi {
  const view = options.view ?? plan();
  const planFn = vi.fn<Gate1Api['plan']>(() => Promise.resolve(view));
  const decideFn = vi.fn<Gate1Api['decide']>(
    options.decide ?? ((_runId, body) => Promise.resolve(decided(body.decision))),
  );
  return { plan: planFn, decide: decideFn };
}

function renderReview(props: Partial<Gate1ReviewProps> & { api: Gate1Api }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={client}>
      <Gate1Review
        runId={RUN}
        currentUserId={APPROVER}
        roles={APPROVER_ROLES}
        newKey={() => 'key-fixed-0001'}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { user, ...utils };
}

/** The rendered text of an element (jest-dom matchers are not installed in this workspace). */
const textOf = (element: HTMLElement): string => element.textContent;

const apiError = (code: string, status: number, detail?: string) =>
  new ApiError({ status, code, title: 'Problem', detail, traceId: 'trace-abc' });

describe('Gate1Review: the approver', () => {
  it('shows the separation-of-duties banner and the plan read-only', async () => {
    const api = fakeApi({
      view: plan({ changes: { fromVersion: 2, added: [], removed: [], changed: ['tc-1'] } }),
    });
    renderReview({ api });
    expect(await screen.findByRole('heading', { name: 'Plan approval' })).toBeTruthy();
    expect(textOf(screen.getByTestId('sod-banner'))).toBe(
      `Requester: ${REQUESTER}, Approver: ${APPROVER}`,
    );
    expect(screen.getByRole('table', { name: /test cases/i })).toBeTruthy();
    expect(screen.getByText('Security headers reviewed')).toBeTruthy();
    expect(textOf(screen.getByTestId('plan-changes'))).toMatch(/changed 1/);
  });

  it('approves and reports the new run state, with the server key sent once', async () => {
    const api = fakeApi();
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(textOf(await screen.findByRole('status'))).toMatch(/plan approved/i);
    expect(api.decide).toHaveBeenCalledWith(
      RUN,
      { decision: 'approve', planVersion: 3 },
      'key-fixed-0001',
    );
  });

  it('requires a reason to request changes or reject, and sends it when given', async () => {
    const api = fakeApi();
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /request changes/i }));
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(screen.getByText('Add a reason for this decision.')).toBeTruthy();
    expect(api.decide).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/reason/i), 'Drop the admin panel.');
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    await waitFor(() => {
      expect(api.decide).toHaveBeenCalledWith(
        RUN,
        { decision: 'request_changes', planVersion: 3, reason: 'Drop the admin panel.' },
        'key-fixed-0001',
      );
    });
  });

  it('is idempotent on a double submit: one request, one key', async () => {
    let release: (value: Gate1DecisionResponse) => void = () => undefined;
    const api = fakeApi({
      decide: () =>
        new Promise<Gate1DecisionResponse>((resolve) => {
          release = resolve;
        }),
    });
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
    const submit = screen.getByRole('button', { name: 'Submit decision' });
    await user.click(submit);
    await user.click(screen.getByRole('button', { name: 'Submitting…' }));
    expect(api.decide).toHaveBeenCalledTimes(1);
    release(decided('approve'));
    expect(textOf(await screen.findByRole('status'))).toMatch(/plan approved/i);
  });

  it('renders a server SoD refusal clearly, without a retry', async () => {
    const api = fakeApi({
      decide: () => Promise.reject(apiError('SOD_VIOLATION', 403)),
    });
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    const alert = await screen.findByRole('alert');
    expect(textOf(alert)).toMatch(/separation of duties/i);
    expect(textOf(alert)).toMatch('trace-abc');
    expect(within(alert).queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reloads the plan on a stale version (409) and tells the approver to review again', async () => {
    const api = fakeApi({
      decide: () => Promise.reject(apiError('GATE1_PLAN_STALE', 409)),
    });
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(textOf(await screen.findByRole('alert'))).toMatch(/changed after you opened it/i);
    await waitFor(() => {
      expect(api.plan.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('after a lost response, the retry sends the same key so the decision is recorded once', async () => {
    const api = fakeApi({
      decide: vi
        .fn()
        .mockRejectedValueOnce(apiError('NETWORK', 0))
        .mockResolvedValueOnce(decided('approve')),
    });
    const { user } = renderReview({ api });
    await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
    await user.click(screen.getByRole('button', { name: 'Submit decision' }));
    await user.click(await screen.findByRole('button', { name: 'Retry the decision' }));
    expect(textOf(await screen.findByRole('status'))).toMatch(/plan approved/i);
    const keys = api.decide.mock.calls.map((call) => call[2]);
    expect(keys).toEqual(['key-fixed-0001', 'key-fixed-0001']);
  });

  it('emits the submitted event with the run id and key, and nothing else', async () => {
    const events: ClientEvent[] = [];
    const restore = setClientEventSink((event) => {
      events.push(event);
    });
    try {
      const { user } = renderReview({ api: fakeApi() });
      await user.click(await screen.findByRole('radio', { name: /approve plan/i }));
      await user.click(screen.getByRole('button', { name: 'Submit decision' }));
      await screen.findByRole('status');
      expect(events).toEqual([
        expect.objectContaining({
          event: 'gate1.decision.submitted',
          route: '/runs/:id/plan',
          runId: RUN,
        }),
      ]);
    } finally {
      restore();
    }
  });
});

describe('Gate1Review: the requester and other roles', () => {
  it('disables the form for the requester, with the reason, and leaves nothing to submit', async () => {
    const api = fakeApi({ view: plan({ viewer: { canDecide: false, isRequester: true } }) });
    renderReview({ api, currentUserId: REQUESTER });
    expect(await screen.findByText(/you requested this plan/i)).toBeTruthy();
    const fieldset = screen.getByRole('group', { name: 'Decision' });
    expect((fieldset as HTMLFieldSetElement).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Submit decision' }).disabled,
    ).toBe(true);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('shows a read-only view, and no form, to a role that cannot approve', async () => {
    const api = fakeApi({ view: plan({ viewer: { canDecide: false, isRequester: false } }) });
    renderReview({ api, roles: ['developer'] });
    expect(await screen.findByText(/read-only: your role cannot approve/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows no form once the run has left Gate 1', async () => {
    const api = fakeApi({
      view: plan({ runState: 'approved', viewer: { canDecide: false, isRequester: false } }),
    });
    renderReview({ api });
    expect(await screen.findByText(/not waiting for approval\. the run is approved/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows no form when the approval window has closed', async () => {
    const api = fakeApi({
      view: plan({
        expiresAt: '2020-01-01T00:00:00.000Z',
        viewer: { canDecide: false, isRequester: false },
      }),
    });
    renderReview({ api });
    expect(await screen.findByText(/approval window for this plan has closed/i)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('says the run is not available when the API answers 404', async () => {
    const api = fakeApi();
    api.plan.mockRejectedValueOnce(apiError('NOT_FOUND', 404));
    renderReview({ api });
    expect(textOf(await screen.findByRole('alert'))).toMatch(/not available to you/i);
  });
});

describe('Gate1Review: accessibility', () => {
  it('has no axe violations for the approver form', async () => {
    const api = fakeApi();
    const { container } = renderReview({ api });
    await screen.findByRole('radio', { name: /approve plan/i });
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});
