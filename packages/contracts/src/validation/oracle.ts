import { z } from 'zod';

import { CodePlusRuntimeOracleSchema } from '../findings/whitebox.js';
import { LIMITS } from '../limits.js';
import { isoDateTimeSchema } from '../primitives.js';

/**
 * Declared oracle types (CONTEXT_PACK §7, REFERENCES §7). The validator replays a candidate against a check that
 * was declared before the test ran. Eight are the declared types; `code_plus_runtime` is contributed by CODESPEC-006
 * into this same union. Specialists, EXPLOIT and CODESPEC import this union; they must not fork it.
 */
export const ORACLE_BINDING_TYPES = [
  'marker',
  'status_diff',
  'timing_baseline',
  'oob',
  'access_matrix',
  'error_signature',
  'file_read',
  'header_cookie',
  'code_plus_runtime',
] as const;
export const oracleBindingTypeSchema = z.enum(ORACLE_BINDING_TYPES);
export type OracleBindingType = z.infer<typeof oracleBindingTypeSchema>;

/** Text in params and reasons: NFC-normalised, non-empty after normalisation, no control characters. */
export function nfcTextSchema(
  max: number,
): z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString> {
  return z
    .string()
    .transform((value) => value.normalize('NFC'))
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters'),
    );
}

/**
 * An evidence reference (an object key or id), never a blob: bounded length and a restricted charset, so an
 * inline payload, a data URI or a path with `..` segments cannot pass.
 */
export const evidenceRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/, 'must be an evidence reference')
  .refine((value) => !value.split('/').includes('..'), 'must not contain dot segments');
export const evidenceRefsSchema = z.array(evidenceRefSchema).max(LIMITS.shortTextMax);

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
/** Longest injected-delay window a timing check may declare (one minute). */
const TIMING_DELTA_MAX_MS = 60_000;
/** Longest window an out-of-band callback is awaited (five minutes). */
export const OOB_WINDOW_MAX_MS = 300_000;

const httpStatusSchema = z.int().min(HTTP_STATUS_MIN).max(HTTP_STATUS_MAX);
/** A lowercase persona or role key, as used in access checks and pins. */
export const roleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'must be a lowercase role key');
const httpTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,128}$/, 'must be an HTTP header or cookie name');

/** Typed `params` per oracle type. Each shape is strict and holds check parameters only, never a payload. */
const oracleParamsSchemas = {
  marker: z.strictObject({ token: nfcTextSchema(LIMITS.shortTextMax) }),
  status_diff: z.strictObject({
    expectedStatus: httpStatusSchema,
    baselineStatus: httpStatusSchema,
  }),
  timing_baseline: z.strictObject({
    baselineMs: z.int().min(0).max(TIMING_DELTA_MAX_MS),
    minDeltaMs: z.int().min(1).max(TIMING_DELTA_MAX_MS),
  }),
  oob: z.strictObject({
    channel: z.enum(['dns', 'http']),
    windowMs: z.int().min(1).max(OOB_WINDOW_MAX_MS),
  }),
  access_matrix: z.strictObject({
    subjectRole: roleKeySchema,
    objectRole: roleKeySchema,
    expectation: z.enum(['allow', 'deny']),
  }),
  error_signature: z.strictObject({ signature: nfcTextSchema(LIMITS.shortTextMax) }),
  file_read: z.strictObject({ marker: nfcTextSchema(LIMITS.shortTextMax) }),
  header_cookie: z.strictObject({
    target: z.enum(['header', 'cookie']),
    name: httpTokenSchema,
    expectation: z.enum(['present', 'absent']),
  }),
  code_plus_runtime: CodePlusRuntimeOracleSchema.shape.params,
} as const;

/** One oracle binding variant: the type, the declaration time and the typed params. */
function bindingVariant<T extends OracleBindingType>(type: T) {
  return z.strictObject({
    type: z.literal(type),
    declaredAt: isoDateTimeSchema,
    params: oracleParamsSchemas[type],
  });
}

/**
 * The oracle binding: a discriminated union on `type`, one typed `params` shape per type. `declaredAt` is the
 * moment the check was declared; the replay spec refines it against the test start (post-hoc oracles are rejected).
 */
export const OracleBindingSchema = z.discriminatedUnion('type', [
  bindingVariant('marker'),
  bindingVariant('status_diff'),
  bindingVariant('timing_baseline'),
  bindingVariant('oob'),
  bindingVariant('access_matrix'),
  bindingVariant('error_signature'),
  bindingVariant('file_read'),
  bindingVariant('header_cookie'),
  bindingVariant('code_plus_runtime'),
]);
export type OracleBinding = z.infer<typeof OracleBindingSchema>;

/** What an evaluator observed for one oracle: whether it fired, and the evidence it looked at. */
export const OracleObservationSchema = z.discriminatedUnion('type', [
  observationVariant('marker'),
  observationVariant('status_diff'),
  observationVariant('timing_baseline'),
  observationVariant('oob'),
  observationVariant('access_matrix'),
  observationVariant('error_signature'),
  observationVariant('file_read'),
  observationVariant('header_cookie'),
  observationVariant('code_plus_runtime'),
]);
export type OracleObservation = z.infer<typeof OracleObservationSchema>;

function observationVariant<T extends OracleBindingType>(type: T) {
  return z.strictObject({
    type: z.literal(type),
    fired: z.boolean(),
    evidenceRefs: evidenceRefsSchema,
  });
}
