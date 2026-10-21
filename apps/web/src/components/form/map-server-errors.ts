import type { FormNotify } from './notify';
import type { ApiError } from '../../lib/api-error.js';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

/** Key of the form-level error set for violations that match no field of the form. */
export const FORM_ERROR_KEY = 'root.server';

/** Accepts `a.b[0].c` and `a.b.0.c`; RHF paths use dots only. */
function toFieldPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
}

function hasField(values: unknown, path: string): boolean {
  let cursor: unknown = values;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || !(key in cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
}

export interface MapServerErrorsOptions {
  /** Shows non-field problems as a toast. */
  readonly notify?: FormNotify | undefined;
}

/**
 * Applies the field violations of an `ApiError` (problem+json `errors[]`) with `form.setError`.
 * A violation naming a field the form does not have becomes a form-level error (never dropped),
 * and an error with no field violations at all is shown as a toast. A field is "in the form"
 * when its path exists in the form values, so declare every field in `defaultValues`.
 * Only server messages are used; submitted values are never read or logged.
 *
 * @returns the number of violations that landed on a field of the form.
 */
export function mapServerErrorsToForm<TInput extends FieldValues, TOutput>(
  error: ApiError,
  form: UseFormReturn<TInput, unknown, TOutput>,
  options: MapServerErrorsOptions = {},
): number {
  const values: unknown = form.getValues();
  const orphans: string[] = [];
  let mapped = 0;
  for (const violation of error.fieldErrors ?? []) {
    const path = toFieldPath(violation.path);
    if (path !== '' && hasField(values, path)) {
      form.setError(
        path as never,
        { type: violation.code, message: violation.message },
        {
          shouldFocus: mapped === 0,
        },
      );
      mapped += 1;
    } else {
      orphans.push(path === '' ? violation.message : `${path}: ${violation.message}`);
    }
  }
  if (orphans.length > 0) {
    form.setError(FORM_ERROR_KEY, { type: error.code, message: orphans.join('\n') });
  }
  if ((error.fieldErrors?.length ?? 0) === 0) {
    options.notify?.({
      title: error.title,
      description: error.detail,
      variant: 'destructive',
    });
  }
  return mapped;
}
