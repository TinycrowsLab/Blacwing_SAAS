import { ValidationError } from '@blackwing/errors';

import type { z } from 'zod';

/** Parses an external value with a Zod schema; a rejection is a `VALIDATION_FAILED` error that names the field. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`invalid ${what}: ${result.error.issues[0]?.message ?? 'rejected'}`);
  }
  return result.data;
}
