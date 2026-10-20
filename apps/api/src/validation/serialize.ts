import { AppError } from '@blackwing/errors';

import { toIssueDetails } from './zod-validation.pipe.js';

import type { z } from 'zod';

/**
 * Outbound contract check. Outside production the value is parsed against the response schema and a
 * mismatch throws `INTERNAL` (a contract-drift bug in this service, never a client error), so drift
 * fails tests and dev loudly. In production the value is returned as is: no extra cost, no new failure
 * mode. Returns the original value, not the parse result, so no outbound data is stripped or reshaped.
 */
export function serialize<S extends z.ZodType>(
  schema: S,
  value: z.input<S>,
  nodeEnv: string | undefined,
): z.input<S> {
  if (nodeEnv === 'production') return value;
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = toIssueDetails(result.error.issues)
      .map((i) => `${i.path === '' ? '(root)' : i.path}:${i.code}`)
      .join(', ');
    throw new AppError('INTERNAL', `Response violates its contract: ${fields}`, {
      cause: result.error,
    });
  }
  return value;
}
