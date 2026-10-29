// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepScope, type StepScopeProps } from './step-scope';

import type { AssessmentRequestResponse, StandingAuthorisationDto } from '@blackwing/contracts';

afterEach(cleanup);

const ASSET_A = '0198f0a0-0000-7000-8000-0000000000e1';
const SA_ID = 'sa_01m64cavacexhrddgjb6xd80xv';

function sa(overrides: Partial<StandingAuthorisationDto> = {}): StandingAuthorisationDto {
  return {
    id: SA_ID,
    assetIds: [ASSET_A],
    scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
    maxIntrusiveness: 'state_changing',
    preApprovedTestClasses: [],
    defaultBudgets: { costCapUsd: 20, maxRequests: 1000, maxDurationMs: 3_600_000 },
    testWindows: [],
    validFrom: '2026-10-01T00:00:00.000Z',
    expiresAt: '2099-11-30T00:00:00.000Z',
    requesterId: '0198f0a0-0000-7000-8000-0000000000a1',
    approverId: '0198f0a0-0000-7000-8000-0000000000a2',
    signature: 'sig',
    signingKeyId: 'key-1',
    status: 'active',
    revocationReason: null,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<AssessmentRequestResponse> = {}): AssessmentRequestResponse {
  return {
    id: 'areq_01m64cavacexhrddgjb6xd80xv',
    status: 'draft',
    mode: 'grey',
    objective: 'Test the login flow',
    assetIds: [ASSET_A],
    saId: SA_ID,
    inputManifestId: null,
    scopeRules: {},
    maxIntrusiveness: 'active_safe',
    budgets: { costCapUsd: 5, maxRequests: 500, maxDurationMs: 3_600_000 },
    trigger: 'console',
    requestedBy: '0198f0a0-0000-7000-8000-0000000000a1',
    stateVersion: 3,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

function renderStep(overrides: Partial<StepScopeProps> = {}) {
  const onSubmit = vi.fn(() => Promise.resolve());
  const props: StepScopeProps = {
    draft: draft(),
    standingAuthorisations: [sa()],
    loading: false,
    pending: false,
    saved: false,
    onSubmit,
    ...overrides,
  };
  const view = render(<StepScope {...props} />);
  return { onSubmit, ...view };
}

async function blockingViolations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { resultTypes: ['violations'] });
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => violation.id);
}

describe('scope step: standing authorisation', () => {
  it('blocks with a clear message when no SA covers the selected assets', () => {
    renderStep({
      standingAuthorisations: [sa({ assetIds: ['0198f0a0-0000-7000-8000-0000000000e9'] })],
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'No standing authorisation covers these assets',
    );
    expect(screen.queryByRole('button', { name: 'Save scope' })).toBeNull();
  });

  it('shows the loading and unavailable states', () => {
    renderStep({ loading: true, standingAuthorisations: undefined });
    expect(screen.getByText('Loading the standing authorisations...')).toBeTruthy();
  });

  it('flags a previously chosen SA that is no longer valid', () => {
    renderStep({ draft: draft({ saId: 'sa_gone' }) });
    expect(screen.getByRole('alert').textContent).toContain('no longer active or no longer covers');
  });
});

describe('scope step: intrusiveness picker', () => {
  it('never renders destructive, and disables the options above the SA ceiling', async () => {
    const user = userEvent.setup();
    renderStep({ standingAuthorisations: [sa({ maxIntrusiveness: 'active_safe' })] });
    await user.click(screen.getByRole('radio', { name: /^Active \(safe\)/ }));
    expect(screen.queryByRole('radio', { name: /^Destructive/ })).toBeNull();
    expect(screen.queryByText(/Destructive/)).toBeNull();
    expect(screen.getByRole('radio', { name: /^State-changing/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /^Passive/ })).toHaveProperty('disabled', false);
  });

  it('surfaces the reversal-journal and Gate 1 notice for state_changing', async () => {
    const user = userEvent.setup();
    renderStep({ draft: draft({ maxIntrusiveness: 'passive' }) });
    expect(screen.queryByText(/State-changing tests write a reversal-journal entry/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^State-changing/ }));
    expect(
      screen.getByText(/State-changing tests write a reversal-journal entry/).textContent,
    ).toContain('Gate 1 must');
  });
});

describe('scope step: rules and target preview', () => {
  it('refuses an invalid rule inline and adds a valid one to the list', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'An include rule needs a host or a CIDR.',
    );

    await user.type(screen.getByLabelText('Host or CIDR'), 'api.example.test');
    await user.type(screen.getByLabelText('Paths (optional)'), '/v1/*');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByText(/Include api.example.test; paths \/v1\/\*/)).toBeTruthy();
    expect(screen.getByText(/1 of 1000 rules\./)).toBeTruthy();
  });

  it('flags a rule the SA does not grant, and removes it on request', async () => {
    const user = userEvent.setup();
    renderStep({
      draft: draft({ scopeRules: { rules: [{ effect: 'include', host: 'other.test' }] } }),
    });
    expect(screen.getByText(/Not covered by this standing authorisation/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(screen.queryByText(/Not covered by this standing authorisation/)).toBeNull();
  });

  it('previews a target against the rules the user is authoring, exclude winning', async () => {
    const user = userEvent.setup();
    renderStep({
      draft: draft({
        scopeRules: {
          rules: [
            { effect: 'include', host: '*.example.test' },
            { effect: 'exclude', host: 'admin.example.test' },
          ],
        },
      }),
    });
    await user.type(screen.getByLabelText('Test a target'), 'https://app.example.test/login');
    expect(screen.getByText(/In scope: matched rule 1\./)).toBeTruthy();
    const target = screen.getByLabelText('Test a target');
    await user.clear(target);
    await user.type(target, 'admin.example.test');
    expect(screen.getByText(/Out of scope: excluded by rule 2\./)).toBeTruthy();
    await user.clear(target);
    await user.type(target, 'other.test');
    expect(screen.getByText(/Out of scope: no include rule matches this target/)).toBeTruthy();
  });
});

describe('scope step: budgets and save', () => {
  it('refuses a budget above the SA default and does not save', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep({
      draft: draft({
        saId: SA_ID,
        scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
      }),
    });
    const maxRequests = screen.getByLabelText('Maximum requests for the run');
    await user.clear(maxRequests);
    await user.type(maxRequests, '5000');
    await user.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'above the standing authorisation default',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('saves the SA, the rules, the ceiling and the budgets it checked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep({
      draft: draft({
        saId: null,
        scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
      }),
    });
    expect(screen.queryByRole('button', { name: 'Save scope' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: new RegExp(SA_ID) }));
    await user.click(screen.getByRole('radio', { name: /^Passive/ }));
    await user.click(screen.getByRole('button', { name: 'Save scope' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        saId: SA_ID,
        scopeRules: [{ effect: 'include', host: 'app.example.test' }],
        maxIntrusiveness: 'passive',
        budgets: { maxRequests: 200, costCapUsd: 20, maxDurationMs: 3_600_000 },
      });
    });
  });

  it('requires at least one include rule before saving', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep({ draft: draft() });
    await user.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(screen.getByRole('alert').textContent).toContain('Add at least one include rule');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('scope step (axe-core, no critical or serious violations)', () => {
  it('has no blocking violations when an SA is chosen', async () => {
    const { container } = renderStep({
      draft: draft({
        saId: SA_ID,
        scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
      }),
    });
    const scoped = within(container);
    expect(scoped.getByRole('heading', { name: 'Set the scope and authorisation' })).toBeTruthy();
    expect(await blockingViolations(container)).toEqual([]);
  });
});
