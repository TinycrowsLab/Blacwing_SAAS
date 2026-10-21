import { CheckCircle2, Circle } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';

export interface FirstRunStep {
  readonly id: string;
  readonly label: string;
  /** Derived from tenant data by the caller, never stored in the browser. */
  readonly done: boolean;
  /** Where the next action happens. Omitted when the viewer cannot act on this step. */
  readonly href?: string | undefined;
  /** Why the viewer cannot act on this step (for example, the role lacks the permission). */
  readonly disabledReason?: string | undefined;
}

export interface FirstRunChecklistProps {
  title: string;
  steps: readonly FirstRunStep[];
  className?: string | undefined;
}

/** Ordered first-run steps with their completion. Presentational only; the caller decides visibility. */
export function FirstRunChecklist({ title, steps, className }: FirstRunChecklistProps) {
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section
      aria-labelledby="first-run-checklist-title"
      className={cn('rounded-lg border border-border bg-card p-4', className)}
      data-state="first-run"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="first-run-checklist-title" className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {doneCount} of {steps.length} done
        </p>
      </div>
      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((step) => (
          <li
            key={step.id}
            className="flex items-start gap-3"
            data-step={step.id}
            data-done={step.done}
          >
            {step.done ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Done" />
            ) : (
              <Circle
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-label="To do"
              />
            )}
            <div className="flex flex-col gap-1">
              {step.href !== undefined && !step.done ? (
                <a href={step.href} className="text-sm font-medium text-primary hover:underline">
                  {step.label}
                </a>
              ) : (
                <span
                  className={cn(
                    'text-sm font-medium',
                    step.done && 'text-muted-foreground line-through',
                  )}
                >
                  {step.label}
                </span>
              )}
              {step.disabledReason !== undefined && !step.done && (
                <span className="text-xs text-muted-foreground">{step.disabledReason}</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
