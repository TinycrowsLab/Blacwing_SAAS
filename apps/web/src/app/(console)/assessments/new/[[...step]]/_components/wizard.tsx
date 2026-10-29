'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { Button } from '@blackwing/ui';

import { ApiError, CLIENT_ERROR_CODES } from '../../../../../../lib/api-error';
import {
  assessmentWizardKeys,
  createAssessmentRequestApi,
} from '../../../../../../lib/assessment-request-api';
import {
  canShowStep,
  firstIncompleteStep,
  neighbourStep,
  wizardHref,
  type WizardState,
  type WizardStep,
} from '../wizard-model';
import { StepAssets } from './step-assets';
import { StepMode } from './step-mode';
import { StepObjective } from './step-objective';
import { Stepper } from './stepper';

import type { AssessmentRequestResponse, RunMode } from '@blackwing/contracts';

const HTTP_PRECONDITION_FAILED = 412;

export interface AssessmentWizardProps {
  readonly step: WizardStep;
  /** The draft named by the URL (`?request=`), or null before a draft exists. */
  readonly requestId: string | null;
  /** The answers the URL carries before a draft exists (`mode`, `assets`). */
  readonly urlAnswers: { readonly mode: RunMode | null; readonly assetIds: readonly string[] };
}

type SaveInput =
  | { readonly step: 'mode'; readonly mode: RunMode }
  | { readonly step: 'assets'; readonly assetIds: string[] }
  | { readonly step: 'objective'; readonly objective: string };

type SaveOutcome =
  | {
      readonly kind: 'navigate';
      readonly to: WizardStep;
      readonly mode: RunMode | null;
      readonly assetIds: string[];
    }
  | { readonly kind: 'draft'; readonly draft: AssessmentRequestResponse };

/** The message a failed save shows. Server text is shown only when the server sent it; nothing is retried silently. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === HTTP_PRECONDITION_FAILED) {
      return 'This draft changed in another tab. Nothing was overwritten. Reload to see the latest version.';
    }
    if (error.code === CLIENT_ERROR_CODES.network) {
      return 'Network problem. Your answer was not saved. Retry to continue.';
    }
    return error.detail ?? error.title;
  }
  return 'Something went wrong. Your answer was not saved.';
}

/**
 * The scoping wizard (SCOPE-005 console form). The step comes from the URL. Before the draft exists, the answers
 * ride in the URL; the objective step creates the draft, and every later save is a PATCH with If-Match. A save
 * advances only when the server has accepted it. A deep link to a later step is redirected to the first incomplete step.
 */
export function AssessmentWizard({ step, requestId, urlAnswers }: AssessmentWizardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = useMemo(() => createAssessmentRequestApi(), []);

  const draftQuery = useQuery({
    queryKey: assessmentWizardKeys.draft(requestId ?? ''),
    queryFn: ({ signal }) => api.get(requestId ?? '', signal),
    enabled: requestId !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const assetsQuery = useQuery({
    queryKey: assessmentWizardKeys.assets,
    queryFn: ({ signal }) => api.assets(signal),
    enabled: step === 'assets',
    retry: false,
    refetchOnWindowFocus: false,
  });

  const draft = draftQuery.data ?? null;
  const answers: WizardState =
    draft === null
      ? { mode: urlAnswers.mode, assetIds: [...urlAnswers.assetIds], objective: '' }
      : { mode: draft.mode, assetIds: draft.assetIds, objective: draft.objective };
  const waitingForDraft = requestId !== null && draft === null && !draftQuery.isError;

  const redirectTo =
    waitingForDraft || draftQuery.isError || canShowStep(step, answers)
      ? null
      : wizardHref(firstIncompleteStep(answers), {
          requestId: draft?.id ?? null,
          mode: answers.mode,
          assetIds: answers.assetIds,
        });
  useEffect(() => {
    if (redirectTo !== null) router.replace(redirectTo);
  }, [redirectTo, router]);

  const save = useMutation({
    mutationFn: async (input: SaveInput): Promise<SaveOutcome> => {
      if (draft !== null) {
        const body =
          input.step === 'mode'
            ? { mode: input.mode }
            : input.step === 'assets'
              ? { assetIds: input.assetIds }
              : { objective: input.objective };
        const updated = await api.patch(draft.id, draft.stateVersion, body);
        return { kind: 'draft', draft: updated };
      }
      if (input.step === 'mode') {
        return {
          kind: 'navigate',
          to: 'assets',
          mode: input.mode,
          assetIds: [...urlAnswers.assetIds],
        };
      }
      if (input.step === 'assets') {
        return {
          kind: 'navigate',
          to: 'objective',
          mode: urlAnswers.mode,
          assetIds: input.assetIds,
        };
      }
      if (urlAnswers.mode === null || urlAnswers.assetIds.length === 0) {
        throw new Error(
          'The mode and at least one asset are needed before the draft can be created.',
        );
      }
      const created = await api.create({
        mode: urlAnswers.mode,
        assetIds: [...urlAnswers.assetIds],
        objective: input.objective,
      });
      return { kind: 'draft', draft: created };
    },
    onSuccess: (outcome, input) => {
      if (outcome.kind === 'navigate') {
        router.push(
          wizardHref(outcome.to, {
            requestId: null,
            mode: outcome.mode,
            assetIds: outcome.assetIds,
          }),
        );
        return;
      }
      queryClient.setQueryData(assessmentWizardKeys.draft(outcome.draft.id), outcome.draft);
      const answersNow = {
        requestId: outcome.draft.id,
        mode: outcome.draft.mode,
        assetIds: outcome.draft.assetIds,
      };
      if (input.step === 'objective') {
        router.replace(wizardHref('objective', answersNow));
        return;
      }
      const next = neighbourStep(step, 1);
      if (next !== undefined) router.push(wizardHref(next, answersNow));
    },
  });

  const saveStep = (input: SaveInput): Promise<void> =>
    save.mutateAsync(input).then(
      () => undefined,
      () => undefined,
    );
  const back = neighbourStep(step, -1);
  const pending = save.isPending;

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">New assessment request</h1>
        <p className="text-sm text-muted-foreground">
          Describe what to assess. Nothing runs until the request is submitted and authorised.
        </p>
      </header>

      {waitingForDraft ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading your draft...
        </p>
      ) : null}

      {draftQuery.isError ? (
        <section role="alert" className="grid gap-3 rounded-md border border-destructive p-4">
          <p className="text-sm">{messageFor(draftQuery.error)}</p>
          <div>
            <Button variant="outline" onClick={() => void draftQuery.refetch()}>
              Try again
            </Button>
          </div>
        </section>
      ) : null}

      {waitingForDraft || draftQuery.isError || redirectTo !== null ? null : (
        <>
          <Stepper current={step} answers={answers} requestId={draft?.id ?? requestId} />
          {back === undefined ? null : (
            <Link
              className="text-sm text-primary underline-offset-4 hover:underline"
              href={wizardHref(back, {
                requestId: draft?.id ?? null,
                mode: answers.mode,
                assetIds: answers.assetIds,
              })}
            >
              Back
            </Link>
          )}

          {save.error === null ? null : (
            <section role="alert" className="grid gap-3 rounded-md border border-destructive p-4">
              <p className="text-sm">{messageFor(save.error)}</p>
              {save.error instanceof ApiError && save.error.status === HTTP_PRECONDITION_FAILED ? (
                <div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      window.location.reload();
                    }}
                  >
                    Reload draft
                  </Button>
                </div>
              ) : null}
            </section>
          )}

          {step === 'mode' ? (
            <StepMode
              defaultMode={answers.mode}
              pending={pending}
              onSubmit={(mode) => saveStep({ step: 'mode', mode })}
            />
          ) : null}
          {step === 'assets' ? (
            <StepAssets
              assets={assetsQuery.data?.items}
              loading={assetsQuery.isPending}
              defaultAssetIds={answers.assetIds}
              pending={pending}
              onSubmit={(assetIds) => saveStep({ step: 'assets', assetIds })}
            />
          ) : null}
          {step === 'objective' ? (
            <StepObjective
              defaultObjective={draft?.objective ?? ''}
              pending={pending}
              savedDraftId={draft?.id ?? null}
              onSubmit={(objective) => saveStep({ step: 'objective', objective })}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
