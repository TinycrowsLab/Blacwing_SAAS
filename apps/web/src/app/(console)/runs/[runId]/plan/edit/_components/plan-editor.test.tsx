// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PlanEditor, type PlanEditorProps } from './plan-editor';
import { ApiError } from '../../../../../../../lib/api-error';

import type { TestPlanApi } from '../../../../../../../lib/test-plan-api';
import type {
  PlanDiff,
  PlanValidationResult,
  TestCaseView,
  TestPlanPage,
  TestPlanView,
} from '@blackwing/contracts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const isDisabled = (element: Element): boolean => (element as HTMLButtonElement).disabled;

const RUN = '0198f0a0-0000-7000-8000-0000000000e1';
const PLAN = '0198f0a0-0000-7000-8000-0000000000d1';
const CASE_A = '0198f0a0-0000-7000-8000-0000000000c1';
const CASE_B = '0198f0a0-0000-7000-8000-0000000000c2';
const EDITOR_ROLES = ['appsec_engineer'];
const APPROVER_ROLES = ['asset_owner'];

const caseOf = (caseId: string, title: string, over: Partial<TestCaseView> = {}): TestCaseView => ({
  caseId,
  planId: PLAN,
  etag: `"etag-${caseId.slice(-2)}"`,
  class: 'passive',
  title,
  status: 'proposed',
  statusReason: null,
  refs: { owasp: [], wstg: [], asvs: [] },
  cweCandidates: [],
  targets: ['https://app.example.test/login'],
  roles: ['anonymous'],
  budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1024 },
  oracle: { type: 'status_code', params: { expected: 429 } },
  negativeControl: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

const planOf = (over: Partial<TestPlanView> = {}): TestPlanView => ({
  planId: PLAN,
  runId: RUN,
  version: 2,
  status: 'draft',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  etag: '"plan-etag-v2"',
  cases: [
    caseOf(CASE_A, 'Login rate limit is enforced'),
    caseOf(CASE_B, 'Password reset token is single use'),
  ],
  ...over,
});

const OK: PlanValidationResult = {
  planId: PLAN,
  runId: RUN,
  version: 2,
  saId: '0198f0a0-0000-7000-8000-0000000000a1',
  ok: true,
  gate1Required: true,
  violations: [],
  budgetTotals: {
    totalRequests: 20,
    totalBytes: 2048,
    perClassCounts: { passive: 2, active_safe: 0, state_changing: 0, destructive: 0 },
  },
  validatedAt: '2026-10-01T10:05:00.000Z',
};

const versionsPage = (numbers: number[]): TestPlanPage => ({
  items: numbers.map((version) => ({
    planId: PLAN,
    runId: RUN,
    version,
    status: version === numbers[numbers.length - 1] ? 'draft' : 'approved',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  })),
  nextCursor: null,
});

type FakeApi = TestPlanApi & {
  listVersions: Mock<TestPlanApi['listVersions']>;
  getVersion: Mock<TestPlanApi['getVersion']>;
  validate: Mock<TestPlanApi['validate']>;
  updateCase: Mock<TestPlanApi['updateCase']>;
  addCase: Mock<TestPlanApi['addCase']>;
  removeCase: Mock<TestPlanApi['removeCase']>;
  diff: Mock<TestPlanApi['diff']>;
  createVersion: Mock<TestPlanApi['createVersion']>;
  submitForGate1: Mock<TestPlanApi['submitForGate1']>;
};

interface FakeOptions {
  readonly numbers?: number[];
  readonly view?: TestPlanView;
  readonly validation?: Promise<PlanValidationResult> | PlanValidationResult;
  readonly diff?: PlanDiff;
  readonly updateCase?: TestPlanApi['updateCase'];
  readonly submit?: TestPlanApi['submitForGate1'];
}

function fakeApi(options: FakeOptions = {}): FakeApi {
  const numbers = options.numbers ?? [1, 2];
  const view = options.view ?? planOf({ version: numbers[numbers.length - 1] ?? 1 });
  const validation = options.validation ?? OK;
  return {
    listVersions: vi.fn<TestPlanApi['listVersions']>(() => Promise.resolve(versionsPage(numbers))),
    getVersion: vi.fn<TestPlanApi['getVersion']>(() => Promise.resolve(view)),
    validate: vi.fn<TestPlanApi['validate']>(() => Promise.resolve(validation)),
    diff: vi.fn<TestPlanApi['diff']>(() =>
      Promise.resolve(
        options.diff ?? { fromVersion: 1, toVersion: 2, added: [], removed: [], modified: [] },
      ),
    ),
    createVersion: vi.fn<TestPlanApi['createVersion']>(() =>
      Promise.resolve(planOf({ version: 3, status: 'draft' })),
    ),
    addCase: vi.fn<TestPlanApi['addCase']>(() =>
      Promise.resolve(caseOf('0198f0a0-0000-7000-8000-0000000000c9', 'New')),
    ),
    updateCase: vi.fn<TestPlanApi['updateCase']>(
      options.updateCase ?? (() => Promise.resolve(caseOf(CASE_A, 'Renamed'))),
    ),
    removeCase: vi.fn<TestPlanApi['removeCase']>(() => Promise.resolve()),
    submitForGate1: vi.fn<TestPlanApi['submitForGate1']>(
      options.submit ??
        ((runId) =>
          Promise.resolve({
            runId,
            planVersion: numbers[numbers.length - 1] ?? 1,
            runState: 'awaiting_gate1',
            submittedAt: '2026-10-30T09:00:00.000Z',
          })),
    ),
  };
}

function renderEditor(api: FakeApi, props: Partial<PlanEditorProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlanEditor runId={RUN} roles={EDITOR_ROLES} api={api} {...props} />
    </QueryClientProvider>,
  );
}

describe('PlanEditor', () => {
  it('lists the cases of the newest version with their class and status', async () => {
    renderEditor(fakeApi());
    expect(await screen.findByRole('table')).not.toBeNull();
    expect(screen.getByText('Login rate limit is enforced')).not.toBeNull();
    expect(screen.getByText('Password reset token is single use')).not.toBeNull();
    expect(screen.getAllByText('passive').length).toBeGreaterThan(0);
  });

  it('keeps Unicode titles intact', async () => {
    const api = fakeApi({ view: planOf({ cases: [caseOf(CASE_A, 'Vérifier l’URL — 認証 ✓')] }) });
    renderEditor(api);
    expect(await screen.findByText('Vérifier l’URL — 認証 ✓')).not.toBeNull();
  });

  it('shows an empty state with an add-case call to action on an empty plan', async () => {
    renderEditor(fakeApi({ view: planOf({ cases: [] }) }));
    expect(await screen.findByText('No test cases in this version.')).not.toBeNull();
    expect(isDisabled(screen.getByRole('button', { name: 'Add case' }))).toBe(false);
  });

  it('hides edit controls from a role without testplan:edit and shows a read-only note', async () => {
    renderEditor(fakeApi(), { roles: APPROVER_ROLES });
    expect(await screen.findByRole('table')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add case' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit /i })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('You can view this plan');
  });

  it('makes an approved version read-only and offers a new draft instead', async () => {
    renderEditor(fakeApi({ view: planOf({ status: 'approved' }) }));
    expect(await screen.findByRole('table')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add case' })).toBeNull();
    expect(isDisabled(screen.getByRole('button', { name: 'Start a new draft' }))).toBe(false);
    expect(screen.getByText(/This version is approved, so its cases are read-only/)).not.toBeNull();
  });

  it('saves an edit with the case ETag as If-Match and refreshes the table', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderEditor(api);
    await user.click(
      await screen.findByRole('button', { name: 'Edit Login rate limit is enforced' }),
    );
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save case' }));
    await waitFor(() => {
      expect(api.updateCase).toHaveBeenCalledTimes(1);
    });
    const [caseId, body, etag] = api.updateCase.mock.calls[0] ?? [];
    expect(caseId).toBe(CASE_A);
    expect(etag).toBe('"etag-c1"');
    expect(body).toMatchObject({ title: 'Renamed', class: 'passive' });
    await waitFor(() => {
      expect(api.getVersion.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('asks for a reload on a stale write instead of overwriting the case', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      updateCase: () =>
        Promise.reject(
          new ApiError({ status: 412, code: 'ETAG_MISMATCH', title: 'Precondition failed' }),
        ),
    });
    renderEditor(api);
    await user.click(
      await screen.findByRole('button', { name: 'Edit Login rate limit is enforced' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save case' }));
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(alert.textContent).toContain('This plan changed while you were editing');
    expect(within(alert).getByRole('button', { name: 'Reload plan' })).not.toBeNull();
  });

  it('removes a case with its own ETag', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderEditor(api);
    await user.click(
      await screen.findByRole('button', { name: 'Remove Password reset token is single use' }),
    );
    await waitFor(() => {
      expect(api.removeCase).toHaveBeenCalledWith(CASE_B, '"etag-c2"');
    });
  });

  it('lists every violation with its code and blocks submit while the plan is invalid', async () => {
    const api = fakeApi({
      validation: {
        ...OK,
        ok: false,
        violations: [
          {
            code: 'PLAN_TARGET_OUT_OF_SCOPE',
            caseId: CASE_A,
            policyId: null,
            message: 'Target is out of scope',
          },
        ],
      },
    });
    renderEditor(api);
    expect(await screen.findByText('PLAN_TARGET_OUT_OF_SCOPE')).not.toBeNull();
    expect(screen.getByText('Target is out of scope')).not.toBeNull();
    expect(isDisabled(screen.getByRole('button', { name: 'Submit for Gate 1' }))).toBe(true);
  });

  it('shows the validating state while a refetch runs and never a stale "valid"', async () => {
    const user = userEvent.setup();
    let release: (value: PlanValidationResult) => void = () => undefined;
    const pending = new Promise<PlanValidationResult>((resolve) => {
      release = resolve;
    });
    const api = fakeApi({ validation: OK });
    api.validate
      .mockImplementationOnce(() => Promise.resolve(OK))
      .mockImplementation(() => pending);
    renderEditor(api);
    await screen.findByText(/The plan is valid against the standing authorisation/);
    await user.click(
      await screen.findByRole('button', { name: 'Edit Login rate limit is enforced' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save case' }));
    await waitFor(() => {
      expect(api.updateCase).toHaveBeenCalled();
    });
    expect(await screen.findByText('Validating the plan…')).not.toBeNull();
    expect(screen.queryByText(/The plan is valid against the standing authorisation/)).toBeNull();
    release(OK);
  });

  it('reports a failed validation as unknown, not valid', async () => {
    const api = fakeApi();
    api.validate.mockImplementation(() =>
      Promise.reject(new ApiError({ status: 503, code: 'HTTP_ERROR', title: 'Down' })),
    );
    renderEditor(api);
    expect(
      await screen.findByText(/Its status is unknown, so treat it as not valid/),
    ).not.toBeNull();
  });

  it('flags an over-budget plan from the PLAN_BUDGET_EXCEEDED violation', async () => {
    const api = fakeApi({
      validation: {
        ...OK,
        ok: false,
        violations: [
          {
            code: 'PLAN_BUDGET_EXCEEDED',
            caseId: null,
            policyId: null,
            message: 'Over the run budget',
          },
        ],
      },
    });
    renderEditor(api);
    expect(await screen.findByText(/This plan is over budget/)).not.toBeNull();
    expect(screen.getByText('20')).not.toBeNull();
  });

  it('shows the changes from the previous version, one row per change', async () => {
    const api = fakeApi({
      diff: {
        fromVersion: 1,
        toVersion: 2,
        added: [{ caseId: CASE_B, title: 'Password reset token is single use' }],
        removed: [],
        modified: [
          {
            caseId: CASE_A,
            title: 'Login rate limit is enforced',
            changes: [
              { field: 'title', before: 'Old title', after: 'Login rate limit is enforced' },
            ],
          },
        ],
      },
    });
    renderEditor(api);
    const changes = await screen.findByRole('list', { name: 'Changes from version 1 to 2' });
    expect(within(changes).getByText(/Added: Password reset token is single use/)).not.toBeNull();
    expect(within(changes).getByText(/Modified: Login rate limit is enforced/)).not.toBeNull();
    expect(within(changes).getByText(/title: "Old title"/)).not.toBeNull();
  });

  it('says there is nothing to compare with on the first version', async () => {
    renderEditor(fakeApi({ numbers: [1], view: planOf({ version: 1 }) }));
    expect(await screen.findByText('There is no earlier version to compare with.')).not.toBeNull();
  });

  it('submits a valid draft for Gate 1 and shows the run awaiting Gate 1', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderEditor(api);
    const submit = await screen.findByRole('button', { name: 'Submit for Gate 1' });
    await waitFor(() => {
      expect(isDisabled(submit)).toBe(false);
    });
    await user.click(submit);
    await waitFor(() => {
      expect(api.submitForGate1).toHaveBeenCalledWith(RUN);
    });
    expect(await screen.findByText(/Plan version 2 is awaiting Gate 1/)).toBeTruthy();
  });

  it('keeps Submit for Gate 1 disabled while validation reports violations', async () => {
    const api = fakeApi({
      validation: {
        ...OK,
        ok: false,
        violations: [
          { code: 'PLAN_ORACLE_MISSING', caseId: CASE_A, policyId: null, message: 'No oracle' },
        ],
      },
    });
    renderEditor(api);
    await screen.findByText('PLAN_ORACLE_MISSING');
    expect(isDisabled(screen.getByRole('button', { name: 'Submit for Gate 1' }))).toBe(true);
    expect(screen.getByText('Fix the violations above before you submit.')).toBeTruthy();
  });

  it('keeps Submit for Gate 1 disabled for a role without edit access, with the reason', async () => {
    renderEditor(fakeApi(), { roles: APPROVER_ROLES });
    await screen.findByRole('table');
    expect(isDisabled(screen.getByRole('button', { name: 'Submit for Gate 1' }))).toBe(true);
    expect(
      screen.getByText('Only a role with test plan edit access can submit this plan.'),
    ).toBeTruthy();
  });

  it('keeps Submit for Gate 1 disabled on an approved version', async () => {
    renderEditor(fakeApi({ view: planOf({ status: 'approved' }) }));
    await screen.findByRole('table');
    expect(isDisabled(screen.getByRole('button', { name: 'Submit for Gate 1' }))).toBe(true);
    expect(screen.getByText(/Only a draft version can be submitted/)).toBeTruthy();
  });

  it('shows the server refusal when the plan is no longer valid at submit time', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      submit: () =>
        Promise.reject(
          new ApiError({
            status: 422,
            code: 'GATE1_PLAN_INVALID',
            title: 'Plan is invalid',
            detail: 'The plan has 1 violation and was not sent to Gate 1.',
          }),
        ),
    });
    renderEditor(api);
    const submit = await screen.findByRole('button', { name: 'Submit for Gate 1' });
    await waitFor(() => {
      expect(isDisabled(submit)).toBe(false);
    });
    await user.click(submit);
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(alert.textContent).toContain('was not sent to Gate 1');
    expect(screen.queryByText(/is awaiting Gate 1/)).toBeNull();
  });

  it('reports a run with no plan without offering any edit', async () => {
    renderEditor(fakeApi({ numbers: [] }));
    expect(await screen.findByText('This run has no test plan yet.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add case' })).toBeNull();
  });
});
