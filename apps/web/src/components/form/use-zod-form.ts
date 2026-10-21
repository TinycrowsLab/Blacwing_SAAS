import { zodResolver } from '@hookform/resolvers/zod';
import {
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';

import { withAsyncValidators, type AsyncValidators } from './async-validation';

import type { z } from 'zod';

export interface UseZodFormOptions<TInput extends FieldValues, TOutput> extends Omit<
  UseFormProps<TInput, unknown, TOutput>,
  'resolver' | 'mode' | 'reValidateMode'
> {
  /** Debounced, cancellable server-side checks (e.g. uniqueness), run after the schema passes. */
  readonly asyncValidators?: AsyncValidators<TInput>;
}

/**
 * `useForm` wired to a Zod schema from `@blackwing/contracts`: validates on blur, re-validates on
 * change. Validation is UX only; the server re-validates every input (CONTEXT_PACK §5).
 * `form.formState.isDirty` is what the unsaved-changes guard (CONSOLE-010) reads.
 */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  options: UseZodFormOptions<z.input<S>, z.output<S>> = {},
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  const { asyncValidators, ...rest } = options;
  const base = zodResolver(schema) as unknown as Resolver<z.input<S>, unknown, z.output<S>>;
  const resolver = asyncValidators ? withAsyncValidators(base, asyncValidators) : base;
  return useForm<z.input<S>, unknown, z.output<S>>({
    ...rest,
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });
}
