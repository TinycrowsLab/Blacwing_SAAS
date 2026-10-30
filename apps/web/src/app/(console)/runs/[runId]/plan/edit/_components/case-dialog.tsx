'use client';

import * as React from 'react';

import {
  INTRUSIVENESS_CLASSES,
  INTRUSIVENESS_DESCRIPTORS,
  type TestCaseView,
} from '@blackwing/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@blackwing/ui';

import {
  caseFormDefaults,
  caseFormSchema,
  type CaseFormOutput,
  type CaseFormValues,
} from './plan-editor-model';
import { useZodForm } from '../../../../../../../components/form/use-zod-form';

export interface CaseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `create` adds a case to the draft; `edit` changes `testCase`. */
  readonly mode: 'create' | 'edit';
  readonly testCase?: TestCaseView;
  readonly pending: boolean;
  /** The last write's failure, shown above the buttons. */
  readonly error: string | null;
  readonly onSave: (values: CaseFormOutput) => void;
}

const EMPTY: CaseFormValues = {
  title: '',
  class: 'passive',
  targets: '',
  roles: '',
  maxRequests: 10,
  maxRps: 1,
  maxConcurrency: 1,
  maxBytes: 1_048_576,
  oracleType: '',
};

/**
 * Add or edit one test case (#402). Inputs are checked with the same Zod rules the contracts use; the server
 * still validates every field and its answer is what the screen shows. Only the case's own draft is editable.
 */
export function CaseDialog({
  open,
  onOpenChange,
  mode,
  testCase,
  pending,
  error,
  onSave,
}: CaseDialogProps): React.ReactNode {
  const defaults = testCase === undefined ? EMPTY : caseFormDefaults(testCase);
  const form = useZodForm(caseFormSchema, { defaultValues: defaults });
  const { register, handleSubmit, formState, setError } = form;
  const errors = formState.errors;
  const heading = mode === 'create' ? 'Add test case' : 'Edit test case';

  const submit = handleSubmit((values) => {
    // An added case needs an oracle type; an edit keeps the case's own oracle (PLAN-006 PLAN_ORACLE_MISSING).
    if (mode === 'create' && values.oracleType.trim() === '') {
      setError('oracleType', {
        type: 'required',
        message: 'Name the oracle that proves the finding.',
      });
      return;
    }
    onSave(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            Changes go to this draft version. The server checks the class, targets, roles and budget
            against the standing authorisation.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="case-title">Title</Label>
            <Input
              id="case-title"
              aria-invalid={errors.title !== undefined}
              aria-describedby={errors.title ? 'case-title-error' : undefined}
              {...register('title')}
            />
            {errors.title ? (
              <p id="case-title-error" role="alert" className="text-sm text-danger">
                {errors.title.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-class">Class</Label>
            <select
              id="case-class"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              {...register('class')}
            >
              {INTRUSIVENESS_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  {INTRUSIVENESS_DESCRIPTORS[cls].label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-targets">Targets (one per line)</Label>
            <textarea
              id="case-targets"
              rows={3}
              className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
              aria-invalid={errors.targets !== undefined}
              aria-describedby={errors.targets ? 'case-targets-error' : undefined}
              {...register('targets')}
            />
            {errors.targets ? (
              <p id="case-targets-error" role="alert" className="text-sm text-danger">
                {errors.targets.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="case-roles">Roles (comma separated)</Label>
            <Input id="case-roles" {...register('roles')} />
          </div>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="text-sm font-medium">Budget</legend>
            <BudgetInput
              id="case-max-requests"
              label="Max requests"
              error={errors.maxRequests?.message}
              {...register('maxRequests')}
            />
            <BudgetInput
              id="case-max-rps"
              label="Max requests per second"
              error={errors.maxRps?.message}
              {...register('maxRps')}
            />
            <BudgetInput
              id="case-max-concurrency"
              label="Max concurrency"
              error={errors.maxConcurrency?.message}
              {...register('maxConcurrency')}
            />
            <BudgetInput
              id="case-max-bytes"
              label="Max bytes"
              error={errors.maxBytes?.message}
              {...register('maxBytes')}
            />
          </fieldset>

          {mode === 'create' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="case-oracle">Oracle type</Label>
              <Input
                id="case-oracle"
                aria-invalid={errors.oracleType !== undefined}
                aria-describedby={errors.oracleType ? 'case-oracle-error' : undefined}
                {...register('oracleType')}
              />
              {errors.oracleType ? (
                <p id="case-oracle-error" role="alert" className="text-sm text-danger">
                  {errors.oracleType.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save case'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface BudgetInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly id: string;
  readonly label: string;
  readonly error: string | undefined;
}

const BudgetInput = React.forwardRef<HTMLInputElement, BudgetInputProps>(function BudgetInput(
  { id, label, error, ...inputProps },
  ref,
) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        ref={ref}
        type="number"
        inputMode="decimal"
        aria-invalid={error !== undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
