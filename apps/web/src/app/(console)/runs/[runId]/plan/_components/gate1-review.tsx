'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import {
  GATE1_DECISIONS,
  type Gate1Decision,
  type Gate1DecisionRequest,
  type Gate1DecisionResponse,
  type Gate1PlanView,
} from '@blackwing/contracts';
import { Badge, Button, Card, CardContent, CardHeader, FormField } from '@blackwing/ui';

import {
  attemptFor,
  DECISION_HINT,
  DECISION_LABEL,
  decisionBody,
  decisionNeedsReason,
  type DecisionAttempt,
  failureOf,
  reasonError,
  sodBannerText,
  type DecisionFailure,
} from './gate1-model';
import { isApiError } from '../../../../../../lib/api-error';
import { emitClientEvent } from '../../../../../../lib/client-events';
import { createGate1Api, gate1Keys, type Gate1Api } from '../../../../../../lib/gate1-api';
import { uuidV7 } from '../../../../../../lib/uuid7';
import { canActAtGate } from '../../_components/gate-model';

const ROUTE = '/runs/:id/plan';
const HTTP_NOT_FOUND = 404;

const defaultApi: Gate1Api = createGate1Api();

const OUTCOME_MESSAGE: Readonly<Record<Gate1Decision, string>> = {
  approve: 'Plan approved. The run is now approved and can start execution.',
  request_changes: 'Changes requested. The run is back in planning.',
  reject: 'Plan rejected. The run is cancelled.',
};

export interface Gate1ReviewProps {
  readonly runId: string;
  /** The signed-in user. Used for the separation-of-duties banner only; the server decides. */
  readonly currentUserId: string | null;
  /** The signed-in user's roles. Cosmetic: a role without testplan:approve gets a read-only view. */
  readonly roles: readonly string[];
  /** Test seams. */
  readonly api?: Gate1Api;
  readonly newKey?: () => string;
}

/**
 * Gate 1 approver review (#877): the plan read-only, its budget and changes, and the decision form. The form
 * is disabled for the requester; the server enforces separation of duties and state, and its refusals render here.
 */
export function Gate1Review({
  runId,
  currentUserId,
  roles,
  api = defaultApi,
  newKey = uuidV7,
}: Gate1ReviewProps): React.ReactNode {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: gate1Keys.plan(runId),
    queryFn: ({ signal }) => api.plan(runId, signal),
    meta: { suppressGlobalError: true },
  });
  const [decision, setDecision] = React.useState<Gate1Decision | null>(null);
  const [reason, setReason] = React.useState('');
  const [showErrors, setShowErrors] = React.useState(false);
  const [failure, setFailure] = React.useState<DecisionFailure | null>(null);
  const [outcome, setOutcome] = React.useState<Gate1DecisionResponse | null>(null);
  const attempt = React.useRef<DecisionAttempt | null>(null);
  const alertRef = React.useRef<HTMLDivElement | null>(null);

  const mutation = useMutation({
    mutationFn: (body: Gate1DecisionRequest) => {
      const next = attemptFor(attempt.current, body, newKey);
      attempt.current = next;
      emitClientEvent('gate1.decision.submitted', ROUTE, { runId, idempotencyKey: next.key });
      return api.decide(runId, body, next.key);
    },
    onSuccess: (response) => {
      attempt.current = null;
      setFailure(null);
      setOutcome(response);
      void queryClient.invalidateQueries({ queryKey: gate1Keys.plan(runId) });
      void queryClient.invalidateQueries({ queryKey: gate1Keys.run(runId) });
    },
    onError: (error) => {
      const next = failureOf(error);
      setFailure(next);
      // A transport failure keeps the attempt, so the retry reuses its key; any refusal ends it.
      if (!next.retryable) attempt.current = null;
      if (next.refresh) void query.refetch();
    },
  });

  React.useEffect(() => {
    if (failure !== null) alertRef.current?.focus();
  }, [failure]);

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the plan…
      </p>
    );
  }
  if (query.error !== null) {
    const notFound = isApiError(query.error) && query.error.status === HTTP_NOT_FOUND;
    return (
      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm">
          <p role="alert" className="font-medium">
            {notFound
              ? 'This run is not available to you, or it does not exist.'
              : 'The plan could not be loaded.'}
          </p>
          {notFound ? null : (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() => {
                void query.refetch();
              }}
            >
              Try again
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const plan: Gate1PlanView = query.data;
  const submitting = mutation.isPending;
  const canApprove = canActAtGate(roles, 1);
  const awaiting = plan.runState === 'awaiting_gate1';
  const expired = plan.expiresAt !== null && Date.parse(plan.expiresAt) <= Date.now();
  const reasonProblem = decision === null ? null : reasonError(decision, reason);

  const submit = (body: Gate1DecisionRequest) => {
    setFailure(null);
    mutation.mutate(body);
  };
  const onSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setShowErrors(true);
    if (decision === null || reasonProblem !== null || submitting || outcome !== null) return;
    submit(decisionBody(decision, plan.planVersion, reason));
  };
  const retry = () => {
    if (attempt.current !== null) submit(attempt.current.body);
  };

  // The requester sees the form disabled with the reason; the server would refuse them anyway (SoD).
  const locked = plan.viewer.isRequester || submitting || outcome !== null;

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold">Plan approval</h1>
          <p className="text-sm text-muted-foreground">
            Run <span className="font-mono">{plan.runId}</span>, plan version {plan.planVersion}
          </p>
        </div>
        <Badge variant="warning">Gate 1</Badge>
      </header>

      <p role="note" data-testid="sod-banner" className="rounded-md border p-3 text-sm">
        {sodBannerText(plan.requesterId, currentUserId)}
      </p>

      {plan.viewer.isRequester ? (
        <p role="note" className="text-sm">
          You requested this plan. Separation of duties: a different person must approve it, so the
          decision form is disabled for you.
        </p>
      ) : null}

      {outcome !== null ? (
        <div role="status" className="rounded-md border p-3 text-sm font-medium">
          {OUTCOME_MESSAGE[outcome.decision]}
        </div>
      ) : null}

      {failure !== null ? (
        <div
          role="alert"
          tabIndex={-1}
          ref={alertRef}
          className="grid gap-2 rounded-md border border-danger p-3 text-sm"
        >
          <p className="font-medium text-danger">{failure.message}</p>
          {failure.traceId === undefined ? null : (
            <p className="text-muted-foreground">Support reference: {failure.traceId}</p>
          )}
          {failure.retryable ? (
            <Button type="button" variant="outline" className="w-fit" onClick={retry}>
              Retry the decision
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Test cases</h2>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <p>
            {String(plan.testCases.length)} test case{plan.testCases.length === 1 ? '' : 's'} ·
            budget {String(plan.budgetTotals.maxRequests)} requests,{' '}
            {String(plan.budgetTotals.maxBytes)} bytes in total.
          </p>
          {plan.changes === null ? null : (
            <p data-testid="plan-changes">
              Changes since version {String(plan.changes.fromVersion)}: added{' '}
              {plan.changes.added.length}, removed {plan.changes.removed.length}, changed{' '}
              {plan.changes.changed.length}.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">Test cases in this plan</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Title
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Intrusiveness
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Targets
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Budget (requests)
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.testCases.map((testCase) => (
                  <tr key={testCase.id} className="border-b align-top">
                    <td className="py-2 pr-3">{testCase.title}</td>
                    <td className="py-2 pr-3">{testCase.class}</td>
                    <td className="py-2 pr-3 break-all">{testCase.targets.join(', ')}</td>
                    <td className="py-2">{String(testCase.budget.maxRequests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {awaiting ? (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Decision</h2>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {!canApprove ? (
              <p>Read-only: your role cannot approve test plans.</p>
            ) : expired ? (
              <p role="alert">The approval window for this plan has closed.</p>
            ) : (
              <form
                onSubmit={onSubmit}
                aria-label="Gate 1 decision"
                className="grid gap-4"
                noValidate
              >
                <fieldset className="grid gap-2" disabled={locked}>
                  <legend className="text-sm font-medium">Decision</legend>
                  {GATE1_DECISIONS.map((value) => (
                    <label key={value} className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="gate1-decision"
                        value={value}
                        checked={decision === value}
                        onChange={() => {
                          setDecision(value);
                        }}
                      />
                      <span>
                        <span className="font-medium">{DECISION_LABEL[value]}</span>
                        <span className="block text-muted-foreground">{DECISION_HINT[value]}</span>
                      </span>
                    </label>
                  ))}
                  {decision !== null && decisionNeedsReason(decision) ? (
                    <FormField
                      label="Reason"
                      description="Required. Recorded in the audit ledger."
                      {...(showErrors && reasonProblem !== null ? { error: reasonProblem } : {})}
                    >
                      {(control) => (
                        <textarea
                          {...control}
                          rows={3}
                          maxLength={2000}
                          value={reason}
                          onChange={(event) => {
                            setReason(event.target.value);
                          }}
                          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        />
                      )}
                    </FormField>
                  ) : null}
                  <div>
                    <Button type="submit" disabled={locked}>
                      {submitting ? 'Submitting…' : 'Submit decision'}
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          This plan is not waiting for approval. The run is {plan.runState}.
        </p>
      )}
    </div>
  );
}
