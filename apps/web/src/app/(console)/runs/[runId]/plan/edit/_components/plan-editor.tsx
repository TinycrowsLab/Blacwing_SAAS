'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@blackwing/ui';

import { CaseDialog } from './case-dialog';
import {
  type CaseFormOutput,
  budgetView,
  canEditPlan,
  createBody,
  diffRows,
  EDITABLE_VERSION_STATUS,
  isEditableVersion,
  isRemoved,
  isStaleWrite,
  patchBody,
  STALE_MESSAGE,
  submitBlockReason,
  type SubmitCheck,
  writeErrorMessage,
} from './plan-editor-model';
import { isApiError } from '../../../../../../../lib/api-error';
import { gate1Keys } from '../../../../../../../lib/gate1-api';
import {
  createTestPlanApi,
  testPlanKeys,
  type TestPlanApi,
} from '../../../../../../../lib/test-plan-api';

import type {
  Gate1SubmitResponse,
  PlanValidationResult,
  TestCaseView,
  TestPlanView,
} from '@blackwing/contracts';

const HTTP_NOT_FOUND = 404;
/** Whole percentage points, for the class bars. */
const PERCENT = 100;

const defaultApi: TestPlanApi = createTestPlanApi();

export interface PlanEditorProps {
  readonly runId: string;
  /** The signed-in user's roles. Cosmetic: a role without `testplan:edit` gets a read-only view. */
  readonly roles: readonly string[];
  /** Test seam. */
  readonly api?: TestPlanApi;
}

type DialogState =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly testCase: TestCaseView };

type Write =
  | {
      readonly kind: 'add';
      readonly planId: string;
      readonly planEtag: string;
      readonly values: CaseFormOutput;
    }
  | { readonly kind: 'edit'; readonly testCase: TestCaseView; readonly values: CaseFormOutput }
  | { readonly kind: 'remove'; readonly testCase: TestCaseView };

/**
 * Test-plan editor (#402): the cases of one plan version in a table, inline case dialogs, a validation banner
 * from the server's PLAN-006 result, budget totals, a diff against another version, and the Gate 1 submit.
 * Every write sends its `If-Match`; a stale one asks for a reload instead of overwriting (PLAN-005).
 */
export function PlanEditor({ runId, roles, api = defaultApi }: PlanEditorProps): React.ReactNode {
  const queryClient = useQueryClient();
  const canEdit = canEditPlan(roles);

  const versions = useQuery({
    queryKey: testPlanKeys.versions(runId),
    queryFn: ({ signal }) => api.listVersions(runId, signal),
    meta: { suppressGlobalError: true },
  });
  const numbers = versions.data?.items.map((item) => item.version) ?? [];
  const latest = numbers.length === 0 ? null : Math.max(...numbers);
  const [picked, setPicked] = React.useState<number | null>(null);
  const selected = picked ?? latest;

  const version = useQuery({
    queryKey: testPlanKeys.version(runId, selected ?? 0),
    queryFn: ({ signal }) => api.getVersion(runId, selected ?? 0, signal),
    enabled: selected !== null,
    meta: { suppressGlobalError: true },
  });
  const plan: TestPlanView | undefined = version.data;

  const [against, setAgainst] = React.useState<number | null>(null);
  const compareWith = against ?? (selected !== null && selected > 1 ? selected - 1 : null);
  const diff = useQuery({
    queryKey: testPlanKeys.diff(runId, selected ?? 0, compareWith ?? 0),
    queryFn: ({ signal }) => api.diff(runId, selected ?? 0, compareWith ?? 0, signal),
    enabled: selected !== null && compareWith !== null && compareWith !== selected,
    meta: { suppressGlobalError: true },
  });

  const validation = useQuery({
    queryKey: testPlanKeys.validation(plan?.planId ?? ''),
    queryFn: ({ signal }) => api.validate(plan?.planId ?? '', signal),
    enabled: plan !== undefined,
    meta: { suppressGlobalError: true },
  });

  const [dialog, setDialog] = React.useState<DialogState | null>(null);
  const [writeError, setWriteError] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [submitted, setSubmitted] = React.useState<Gate1SubmitResponse | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const refresh = (planId: string) => {
    void queryClient.invalidateQueries({ queryKey: testPlanKeys.versions(runId) });
    void queryClient.invalidateQueries({ queryKey: ['testPlans', 'version', runId] });
    void queryClient.invalidateQueries({ queryKey: ['testPlans', 'diff', runId] });
    void queryClient.invalidateQueries({ queryKey: testPlanKeys.validation(planId) });
  };

  const write = useMutation({
    mutationFn: (change: Write) => {
      switch (change.kind) {
        case 'add':
          return api.addCase(change.planId, createBody(change.values), change.planEtag);
        case 'edit':
          return api.updateCase(
            change.testCase.caseId,
            patchBody(change.values),
            change.testCase.etag,
          );
        case 'remove':
          return api.removeCase(change.testCase.caseId, change.testCase.etag).then(() => null);
      }
    },
    onSuccess: (_result, change) => {
      setWriteError(null);
      setStale(false);
      setDialog(null);
      refresh(change.kind === 'add' ? change.planId : change.testCase.planId);
    },
    onError: (error) => {
      const isStale = isStaleWrite(error);
      setWriteError(writeErrorMessage(error));
      setStale(isStale);
      // A stale write closes the dialog: the modal would hide the reload prompt, and the case must be re-read first.
      if (isStale) setDialog(null);
    },
  });

  const newDraft = useMutation({
    mutationFn: () => api.createVersion(runId),
    onSuccess: (created) => {
      setPicked(created.version);
      void queryClient.invalidateQueries({ queryKey: testPlanKeys.versions(runId) });
    },
    onError: (error) => {
      setWriteError(writeErrorMessage(error));
      setStale(false);
    },
  });

  const submit = useMutation({
    mutationFn: () => api.submitForGate1(runId),
    onSuccess: (result) => {
      setSubmitError(null);
      setSubmitted(result);
      refresh(plan?.planId ?? '');
      void queryClient.invalidateQueries({ queryKey: gate1Keys.plan(runId) });
      void queryClient.invalidateQueries({ queryKey: gate1Keys.run(runId) });
    },
    onError: (error) => {
      setSubmitted(null);
      setSubmitError(writeErrorMessage(error));
    },
  });

  const reload = () => {
    setStale(false);
    setWriteError(null);
    void version.refetch();
  };

  if (versions.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the plan…
      </p>
    );
  }
  if (versions.error !== null) {
    return (
      <LoadFailure runId={runId} onRetry={() => void versions.refetch()} error={versions.error} />
    );
  }
  if (latest === null) {
    return (
      <Card>
        <CardContent className="grid gap-2 pt-6 text-sm">
          <p className="font-medium">This run has no test plan yet.</p>
          <p className="text-muted-foreground">
            The planner creates the first version. Come back once it has one.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (version.isPending || plan === undefined) {
    if (version.error !== null) {
      return (
        <LoadFailure runId={runId} onRetry={() => void version.refetch()} error={version.error} />
      );
    }
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the plan…
      </p>
    );
  }

  const editable = canEdit && isEditableVersion(plan.status);
  const pending = write.isPending || newDraft.isPending;
  const validationState = describeValidation(validation);
  const submitCheck = submitCheckOf(validationState);
  const submitBlocked = submitBlockReason({
    canEdit,
    draft: isEditableVersion(plan.status),
    check: submitCheck,
  });
  const budget =
    validationState.kind === 'ready'
      ? budgetView(validationState.result.budgetTotals, validationState.result.violations)
      : null;
  const rows = diff.data === undefined ? [] : diffRows(diff.data);

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold">Test plan</h1>
          <p className="text-sm text-muted-foreground">
            Run <span className="font-mono">{runId}</span>, version {plan.version}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span>Version</span>
            <select
              aria-label="Plan version"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={plan.version}
              onChange={(event) => {
                setPicked(Number(event.target.value));
                setWriteError(null);
              }}
            >
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <Badge>{plan.status}</Badge>
        </div>
      </header>

      {!canEdit ? (
        <p role="note" className="rounded-md border p-3 text-sm">
          You can view this plan. Editing needs the test plan edit permission.
        </p>
      ) : null}

      <ValidationBanner state={validationState} onRetry={() => void validation.refetch()} />

      {stale ? (
        <div role="alert" className="grid gap-2 rounded-md border border-danger p-3 text-sm">
          <p>{STALE_MESSAGE}</p>
          <Button type="button" variant="outline" className="w-fit" onClick={reload}>
            Reload plan
          </Button>
        </div>
      ) : null}
      {writeError !== null && !stale ? (
        <p role="alert" className="rounded-md border border-danger p-3 text-sm">
          {writeError}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="cases-heading" className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="cases-heading" className="text-base font-semibold">
              Test cases
            </h2>
            <div className="flex flex-wrap gap-2">
              {editable ? (
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setWriteError(null);
                    setDialog({ mode: 'create' });
                  }}
                >
                  Add case
                </Button>
              ) : null}
              {canEdit && !isEditableVersion(plan.status) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    newDraft.mutate();
                  }}
                >
                  Start a new draft
                </Button>
              ) : null}
            </div>
          </div>

          {!isEditableVersion(plan.status) ? (
            <p className="text-sm text-muted-foreground">
              This version is {plan.status}, so its cases are read-only. Start a new draft to change
              them.
            </p>
          ) : null}

          {plan.cases.length === 0 ? (
            <div className="grid gap-2 rounded-md border p-6 text-sm">
              <p className="font-medium">No test cases in this version.</p>
              {editable ? (
                <p className="text-muted-foreground">Add a case to start the plan.</p>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Targets</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Budget</TableHead>
                    <TableHead>Oracle</TableHead>
                    <TableHead>Negative control</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.cases.map((testCase) => (
                    <TableRow key={testCase.caseId}>
                      <TableCell className="font-medium">{testCase.title}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{testCase.class}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {testCase.targets.join(', ')}
                      </TableCell>
                      <TableCell>{testCase.roles.join(', ') || '—'}</TableCell>
                      <TableCell className="text-xs">
                        {testCase.budget.maxRequests} req · {testCase.budget.maxRps} rps
                      </TableCell>
                      <TableCell>{testCase.oracle?.type ?? '—'}</TableCell>
                      <TableCell>{testCase.negativeControl?.kind ?? '—'}</TableCell>
                      <TableCell>{testCase.status}</TableCell>
                      <TableCell>
                        {editable && !isRemoved(testCase) ? (
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={pending}
                              aria-label={`Edit ${testCase.title}`}
                              onClick={() => {
                                setWriteError(null);
                                setDialog({ mode: 'edit', testCase });
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={pending}
                              aria-label={`Remove ${testCase.title}`}
                              onClick={() => {
                                setWriteError(null);
                                write.mutate({ kind: 'remove', testCase });
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <aside className="grid content-start gap-5">
          <BudgetPanel state={validationState} budget={budget} caseCount={plan.cases.length} />

          <section aria-labelledby="diff-heading" className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="diff-heading" className="text-base font-semibold">
                Changes
              </h2>
              {numbers.length > 1 ? (
                <label className="flex items-center gap-2 text-sm">
                  <span>Compare with</span>
                  <select
                    aria-label="Compare with version"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={compareWith ?? ''}
                    onChange={(event) => {
                      setAgainst(Number(event.target.value));
                    }}
                  >
                    {numbers
                      .filter((n) => n !== plan.version)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
            </div>
            <DiffView
              loading={diff.isPending && compareWith !== null}
              failed={diff.error !== null}
              rows={rows}
              noCompare={compareWith === null}
              from={compareWith}
              to={plan.version}
            />
          </section>
        </aside>
      </div>

      <section aria-labelledby="submit-heading" className="grid gap-2 rounded-md border p-4">
        <h2 id="submit-heading" className="text-base font-semibold">
          Submit for Gate 1
        </h2>
        {submitted !== null ? (
          <p role="status" className="text-sm font-medium">
            Plan version {submitted.planVersion} is awaiting Gate 1. The run is now{' '}
            {submitted.runState}.
          </p>
        ) : null}
        {submitError !== null ? (
          <p role="alert" className="text-sm text-danger">
            {submitError}
          </p>
        ) : null}
        {submitBlocked === null ? null : (
          <p className="text-sm text-muted-foreground">{submitBlocked}</p>
        )}
        <Button
          type="button"
          className="w-fit"
          disabled={submitBlocked !== null || submit.isPending}
          onClick={() => {
            setSubmitError(null);
            submit.mutate();
          }}
        >
          {submit.isPending ? 'Submitting…' : 'Submit for Gate 1'}
        </Button>
      </section>

      {dialog !== null ? (
        <CaseDialog
          key={dialog.mode === 'edit' ? dialog.testCase.caseId : 'create'}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          mode={dialog.mode}
          {...(dialog.mode === 'edit' ? { testCase: dialog.testCase } : {})}
          pending={write.isPending}
          error={writeError}
          onSave={(values) => {
            if (plan.status !== EDITABLE_VERSION_STATUS) return;
            if (dialog.mode === 'create') {
              write.mutate({ kind: 'add', planId: plan.planId, planEtag: plan.etag, values });
            } else {
              write.mutate({ kind: 'edit', testCase: dialog.testCase, values });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function submitCheckOf(state: ValidationState): SubmitCheck {
  if (state.kind === 'loading') return 'checking';
  if (state.kind === 'failed') return 'unknown';
  return state.result.ok ? 'valid' : 'invalid';
}

type ValidationState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly result: PlanValidationResult };

/**
 * The banner's state. A result is shown only when it is current: while a refetch is running (after a write),
 * the screen says it is validating, never "valid" from before the change.
 */
function describeValidation(query: {
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  data: PlanValidationResult | undefined;
}): ValidationState {
  if (query.isPending || query.isFetching) return { kind: 'loading' };
  if (query.isError || query.data === undefined) return { kind: 'failed' };
  return { kind: 'ready', result: query.data };
}

function ValidationBanner({
  state,
  onRetry,
}: {
  readonly state: ValidationState;
  readonly onRetry: () => void;
}): React.ReactNode {
  if (state.kind === 'loading') {
    return (
      <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">
        Validating the plan…
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div role="alert" className="grid gap-2 rounded-md border border-danger p-3 text-sm">
        <p>The plan could not be validated. Its status is unknown, so treat it as not valid.</p>
        <Button type="button" variant="outline" className="w-fit" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  const { result } = state;
  if (result.ok) {
    return (
      <p role="status" className="rounded-md border p-3 text-sm">
        The plan is valid against the standing authorisation.
        {result.gate1Required ? ' Gate 1 approval is required.' : ''}
      </p>
    );
  }
  return (
    <div role="alert" className="grid gap-2 rounded-md border border-danger p-3 text-sm">
      <p className="font-medium">
        The plan has {result.violations.length}{' '}
        {result.violations.length === 1 ? 'violation' : 'violations'}.
      </p>
      <ul className="grid gap-1">
        {result.violations.map((violation, index) => (
          <li key={`${violation.code}-${violation.caseId ?? 'plan'}-${index}`}>
            <span className="font-mono text-xs">{violation.code}</span> {violation.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BudgetPanel({
  state,
  budget,
  caseCount,
}: {
  readonly state: ValidationState;
  readonly budget: ReturnType<typeof budgetView> | null;
  readonly caseCount: number;
}): React.ReactNode {
  return (
    <section aria-labelledby="budget-heading" className="grid gap-3">
      <h2 id="budget-heading" className="text-base font-semibold">
        Budget
      </h2>
      {budget === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.kind === 'failed'
            ? 'Budget totals are unavailable.'
            : 'Calculating budget totals…'}
        </p>
      ) : (
        <div className="grid gap-3 text-sm">
          {budget.overBudget ? (
            <p role="alert" className="rounded-md border border-danger p-2 font-medium">
              This plan is over budget. Reduce the requests or bytes of a case, or the server will
              refuse it.
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-muted-foreground">Total requests</dt>
            <dd className="text-right font-mono">{budget.totalRequests}</dd>
            <dt className="text-muted-foreground">Total bytes</dt>
            <dd className="text-right font-mono">{budget.totalBytes}</dd>
          </dl>
          <ul className="grid gap-2" aria-label="Cases per class">
            {budget.classes.map((entry) => (
              <li key={entry.class} className="grid gap-1">
                <div className="flex justify-between">
                  <span>{entry.class}</span>
                  <span className="font-mono">{entry.count}</span>
                </div>
                <div className="h-1.5 rounded bg-muted">
                  <div
                    className="h-1.5 rounded bg-primary"
                    style={{
                      width: `${Math.round((entry.count / Math.max(1, caseCount)) * PERCENT)}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DiffView({
  loading,
  failed,
  rows,
  noCompare,
  from,
  to,
}: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly rows: ReturnType<typeof diffRows>;
  readonly noCompare: boolean;
  readonly from: number | null;
  readonly to: number;
}): React.ReactNode {
  if (noCompare)
    return (
      <p className="text-sm text-muted-foreground">There is no earlier version to compare with.</p>
    );
  if (loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Comparing versions…
      </p>
    );
  if (failed)
    return (
      <p role="alert" className="text-sm">
        The changes could not be loaded.
      </p>
    );
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No changes from version {from} to {to}.
      </p>
    );
  return (
    <ul aria-label={`Changes from version ${from} to ${to}`} className="grid gap-2 text-sm">
      {rows.map((row) => (
        <li key={row.key} className="grid gap-0.5 rounded-md border p-2">
          <span className="font-medium">
            {row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Modified'}:{' '}
            {row.title}
          </span>
          {row.kind === 'modified' ? (
            <span className="font-mono text-xs">
              {row.field}: {row.before ?? '∅'} → {row.after ?? '∅'}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LoadFailure({
  runId,
  error,
  onRetry,
}: {
  readonly runId: string;
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.ReactNode {
  const notFound = isApiError(error) && error.status === HTTP_NOT_FOUND;
  return (
    <Card>
      <CardContent className="grid gap-3 pt-6 text-sm">
        <p role="alert" className="font-medium">
          {notFound
            ? `Run ${runId} is not available to you, or it does not exist.`
            : 'The plan could not be loaded.'}
        </p>
        {notFound ? null : (
          <Button type="button" variant="outline" className="w-fit" onClick={onRetry}>
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
