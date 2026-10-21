'use client';

import { useFormContext } from 'react-hook-form';

import { Button, type ButtonProps } from '@blackwing/ui';

export type SubmitButtonProps = Omit<ButtonProps, 'type' | 'asChild'> & {
  /** Label while submitting; defaults to the normal children. */
  readonly pendingLabel?: string;
};

/**
 * Submit button for a `<Form>`: disabled while submitting (so it cannot double-fire) or while the
 * form has a known validation error, with a spinner and `aria-busy` during submit.
 */
export function SubmitButton({ children, pendingLabel, disabled, ...props }: SubmitButtonProps) {
  const { formState } = useFormContext();
  const { isSubmitting, errors } = formState;
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <Button
      type="submit"
      disabled={disabled === true || isSubmitting || hasErrors}
      aria-busy={isSubmitting}
      {...props}
    >
      {isSubmitting ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {isSubmitting && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
