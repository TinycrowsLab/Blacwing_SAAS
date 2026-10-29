'use client';

import { Button } from '@blackwing/ui';

import { useZodForm } from '../../../../../../components/form/use-zod-form';
import { MODE_OPTIONS, modeAnswerSchema } from '../wizard-model';

import type { RunMode } from '@blackwing/contracts';

export interface StepModeProps {
  readonly defaultMode: RunMode | null;
  readonly pending: boolean;
  readonly onSubmit: (mode: RunMode) => Promise<void>;
}

/** Step 1: the assessment mode. Each card names the engineering altitude and the recon it implies (read-only). */
export function StepMode({ defaultMode, pending, onSubmit }: StepModeProps) {
  const form = useZodForm(modeAnswerSchema, {
    defaultValues: defaultMode === null ? {} : { mode: defaultMode },
  });
  const selected = form.watch('mode');
  const error = form.formState.errors.mode?.message;
  return (
    <form
      noValidate
      aria-labelledby="step-mode-title"
      onSubmit={(event) => {
        void form.handleSubmit((values) => onSubmit(values.mode))(event);
      }}
      className="grid gap-4"
    >
      <h2 id="step-mode-title" className="text-lg font-semibold">
        Choose the assessment mode
      </h2>
      <fieldset className="grid gap-3 md:grid-cols-3">
        <legend className="sr-only">Assessment mode</legend>
        {MODE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`grid cursor-pointer gap-2 rounded-md border p-4 ${
              selected === option.value ? 'border-primary ring-2 ring-primary' : 'border-input'
            }`}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                value={option.value}
                disabled={pending}
                aria-describedby={`mode-${option.value}-desc`}
                {...form.register('mode')}
              />
              {option.label}
            </span>
            <span id={`mode-${option.value}-desc`} className="text-sm text-muted-foreground">
              {option.altitude} {option.reconImplication}
            </span>
          </label>
        ))}
      </fieldset>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
