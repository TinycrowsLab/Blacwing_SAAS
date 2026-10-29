'use client';

import { LIMITS } from '@blackwing/contracts';
import { Button, Label } from '@blackwing/ui';

import { useZodForm } from '../../../../../../components/form/use-zod-form';
import { objectiveAnswerSchema, OBJECTIVE_PRESETS } from '../wizard-model';

export interface StepObjectiveProps {
  readonly defaultObjective: string;
  readonly pending: boolean;
  /** The draft id once it exists; shown so the user can come back to it (save and continue later). */
  readonly savedDraftId: string | null;
  readonly onSubmit: (objective: string) => Promise<void>;
}

/** Step 3: the objective. Presets only fill in editable text; they carry no exploit content. */
export function StepObjective({
  defaultObjective,
  pending,
  savedDraftId,
  onSubmit,
}: StepObjectiveProps) {
  const form = useZodForm(objectiveAnswerSchema, {
    defaultValues: { objective: defaultObjective },
  });
  const objective = form.watch('objective');
  const error = form.formState.errors.objective?.message;
  const labelId = 'objective-field';
  return (
    <form
      noValidate
      aria-labelledby="step-objective-title"
      onSubmit={(event) => {
        void form.handleSubmit((values) => onSubmit(values.objective))(event);
      }}
      className="grid gap-4"
    >
      <h2 id="step-objective-title" className="text-lg font-semibold">
        State the objective
      </h2>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Objective presets">
        {OBJECTIVE_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              form.setValue('objective', preset.text, { shouldValidate: true, shouldDirty: true });
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={labelId}>Objective</Label>
        <textarea
          id={labelId}
          rows={5}
          maxLength={LIMITS.objectiveMax}
          disabled={pending}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={`${labelId}-count`}
          className="rounded-md border border-input bg-background p-2 text-sm"
          {...form.register('objective')}
        />
        <p
          id={`${labelId}-count`}
          className="text-right text-xs text-muted-foreground"
          aria-live="polite"
        >
          {String(objective.length)} / {String(LIMITS.objectiveMax)}
        </p>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {savedDraftId === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          Draft saved as <span className="font-mono">{savedDraftId}</span>. Open this page again to
          resume it.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : savedDraftId === null ? 'Create draft' : 'Save draft'}
        </Button>
      </div>
    </form>
  );
}
