import Link from 'next/link';

import {
  canShowStep,
  WIZARD_STEPS,
  wizardHref,
  type WizardState,
  type WizardStep,
} from '../wizard-model';

const STEP_LABELS: Readonly<Record<WizardStep, string>> = {
  mode: 'Mode',
  assets: 'Assets',
  objective: 'Objective',
};

export interface StepperProps {
  readonly current: WizardStep;
  readonly answers: Pick<WizardState, 'mode' | 'assetIds'>;
  readonly requestId: string | null;
}

/**
 * The wizard stepper. The current step carries `aria-current="step"`. A step is a link only when it may be shown
 * (the first incomplete step or one before it), so the keyboard reaches exactly the steps the user may open.
 */
export function Stepper({ current, answers, requestId }: StepperProps) {
  const mode = answers.mode;
  return (
    <nav aria-label="Assessment request steps">
      <ol className="flex flex-wrap gap-2 text-sm">
        {WIZARD_STEPS.map((step, index) => {
          const reachable = canShowStep(step, answers);
          const isCurrent = step === current;
          const label = `${String(index + 1)}. ${STEP_LABELS[step]}`;
          const content = isCurrent ? (
            <span aria-current="step" className="font-semibold text-foreground">
              {label}
            </span>
          ) : reachable ? (
            <Link
              href={wizardHref(step, { requestId, mode, assetIds: answers.assetIds })}
              className="text-primary underline-offset-4 hover:underline"
            >
              {label}
            </Link>
          ) : (
            <span aria-disabled="true" className="text-muted-foreground">
              {label}
            </span>
          );
          return (
            <li key={step} className="flex items-center gap-2">
              {content}
              {index < WIZARD_STEPS.length - 1 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
