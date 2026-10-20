import { z } from 'zod';

/** One field-level problem inside a `422` (or other 4xx) problem+json body. */
export const problemFieldErrorSchema = z.object({
  /** Dotted/bracketed path of the offending input field, e.g. `scope.rules[0].value`. */
  path: z.string(),
  /** Human-readable, already redacted message. */
  message: z.string(),
  /** Stable machine key of the violated rule. */
  code: z.string(),
});
export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

/**
 * RFC 9457 `application/problem+json` body of every API error (CONTEXT_PACK §9, API-004). camelCase.
 * Shared by the API's exception filter, the validation pipe (API-002/003) and the web client.
 */
export const problemSchema = z.object({
  /** `https://errors.blackwing.dev/{code}`. */
  type: z.url(),
  /** Constant human-readable title per `code`. */
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  /** Stable registry code (snake_case on the wire). */
  code: z.string(),
  traceId: z.string(),
  errors: z.array(problemFieldErrorSchema).optional(),
});
export type Problem = z.infer<typeof problemSchema>;
