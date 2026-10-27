'use client';

import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  type SubmitHandler,
  type UseFormReturn,
} from 'react-hook-form';

import { cn, Label } from '@blackwing/ui';

import { FORM_ERROR_KEY, mapServerErrorsToForm } from './map-server-errors';
import { NavigationGuardDialog } from './navigation-guard-dialog';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';
import { isApiError } from '../../lib/api-error.js';
import { t } from '../../lib/i18n';

import type { FormNotify } from './notify';

const HTTP_PRECONDITION_FAILED = 412;

interface FormFieldContextValue {
  readonly name: string;
}
interface FormItemContextValue {
  readonly id: string;
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);
const FormItemContext = React.createContext<FormItemContextValue | null>(null);

export interface FormProps<TInput extends FieldValues, TOutput> extends Omit<
  React.FormHTMLAttributes<HTMLFormElement>,
  'onSubmit' | 'children'
> {
  /** The result of `useZodForm`. */
  readonly form: UseFormReturn<TInput, unknown, TOutput>;
  readonly onSubmit: SubmitHandler<TOutput>;
  readonly children: React.ReactNode;
  /** Stable form name; the only thing reported when client validation fails. */
  readonly name: string;
  /** Shows toasts for non-field errors, network failures and conflicts. */
  readonly notify?: FormNotify;
  /** Called with the form name (never values) when submit is blocked by validation. */
  readonly onValidationFail?: (formName: string) => void;
  /** Called on a 412 (stale ETag) when the user chooses to reload the latest version. */
  readonly onRefetch?: () => void;
  /** After a successful submit, reset to the submitted values so `isDirty` clears. Default true. */
  readonly resetOnSuccess?: boolean;
}

/**
 * Provides the form context, blocks double submits and maps failures: field violations to their
 * fields, a 412 to a conflict toast offering a refetch, anything else to a retry toast. User
 * input is never cleared on failure.
 */
export function Form<TInput extends FieldValues, TOutput>({
  form,
  onSubmit,
  children,
  name,
  notify,
  onValidationFail,
  onRefetch,
  resetOnSuccess = true,
  className,
  ...props
}: FormProps<TInput, TOutput>) {
  const inFlight = React.useRef(false);
  // Holds in-app navigation and reloads while the form has unsaved edits (CONSOLE-010).
  const guard = useUnsavedChangesGuard({ when: form.formState.isDirty });

  const submit = form.handleSubmit(
    async (values) => {
      if (inFlight.current) return;
      inFlight.current = true;
      form.clearErrors(FORM_ERROR_KEY);
      try {
        await onSubmit(values);
        if (resetOnSuccess) form.reset(form.getValues());
      } catch (error) {
        if (isApiError(error)) {
          if (error.status === HTTP_PRECONDITION_FAILED) {
            notify?.({
              title: t('toast.changedElsewhere.title'),
              description: t('toast.changedElsewhere.description'),
              variant: 'destructive',
              ...(onRefetch ? { action: { label: t('toast.reload'), run: onRefetch } } : {}),
            });
          } else {
            mapServerErrorsToForm(error, form, { notify });
          }
        } else {
          notify?.({
            title: t('toast.couldNotSave.title'),
            description: t('toast.couldNotSave.description'),
            variant: 'destructive',
            action: {
              label: t('toast.retry'),
              run: () => {
                void submit();
              },
            },
          });
        }
      } finally {
        inFlight.current = false;
      }
    },
    () => {
      onValidationFail?.(name);
    },
  );

  return (
    <FormProvider {...form}>
      <form
        noValidate
        data-form={name}
        className={cn('grid gap-4', className)}
        {...props}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <FormRootError />
        {children}
      </form>
      <NavigationGuardDialog guard={guard} />
    </FormProvider>
  );
}

/** Form-level server error (violations that match no field). Live region, always mounted. */
function FormRootError() {
  const { formState } = useFormContext();
  const root = formState.errors.root as { server?: { message?: string } } | undefined;
  const message = root?.server?.message;
  return (
    <div role="status" aria-live="polite" className="whitespace-pre-line text-sm text-destructive">
      {message}
    </div>
  );
}

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

/** Ids and state every part of one field shares. */
export function useFormField() {
  const field = React.useContext(FormFieldContext);
  const item = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  if (!field || !item)
    throw new Error('useFormField must be used inside <FormField> and <FormItem>');
  const state = getFieldState(field.name, formState);
  return {
    name: field.name,
    id: item.id,
    formItemId: `${item.id}-form-item`,
    formDescriptionId: `${item.id}-form-item-description`,
    formMessageId: `${item.id}-form-item-message`,
    ...state,
  };
}

export const FormItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const id = React.useId();
    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={ref} className={cn('grid gap-1.5', className)} {...props} />
      </FormItemContext.Provider>
    );
  },
);
FormItem.displayName = 'FormItem';

export const FormLabel = React.forwardRef<
  React.ComponentRef<typeof Label>,
  React.ComponentPropsWithoutRef<typeof Label>
>(({ className, ...props }, ref) => {
  const { error, formItemId } = useFormField();
  return (
    <Label
      ref={ref}
      className={cn(error && 'text-destructive', className)}
      htmlFor={formItemId}
      {...props}
    />
  );
});
FormLabel.displayName = 'FormLabel';

/** Wires id, `aria-describedby` (description + error) and `aria-invalid` onto its child control. */
export const FormControl = React.forwardRef<
  React.ComponentRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={error ? true : undefined}
      {...props}
    />
  );
});
FormControl.displayName = 'FormControl';

export const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();
  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
});
FormDescription.displayName = 'FormDescription';

/**
 * The field error from the Zod schema or the server. The element is always mounted with
 * `aria-live="polite"` so screen readers announce a message when it appears.
 */
export const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField();
  const body = error ? (error.message ?? '') : children;
  return (
    <p
      ref={ref}
      id={formMessageId}
      aria-live="polite"
      className={cn('text-xs font-medium text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  );
});
FormMessage.displayName = 'FormMessage';
