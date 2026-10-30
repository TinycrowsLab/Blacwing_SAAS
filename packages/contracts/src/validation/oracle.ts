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
const httpStatusSchema = z.int().min(HTTP_STATUS_MIN).max(HTTP_STATUS_MAX);
/** Longest injected-delay window a timing check may declare (one minute). */
const TIMING_DELTA_MAX_MS = 60_000;
/** Fewest timed samples a timing verdict may rest on; below this a median is not meaningful. */
export const TIMING_SAMPLES_MIN = 3;
/** Most timed samples a timing check may declare. */
export const TIMING_SAMPLES_MAX = 50;
/** Samples used when a timing binding does not declare its own count. */
export const TIMING_SAMPLES_DEFAULT = 5;
/** Longest window an out-of-band callback is awaited (five minutes). */
export const OOB_WINDOW_MAX_MS = 300_000;

/**
 * A benign sentinel id: a harmless, in-scope marker the lab placed in a file that must not be reachable. It is a short
 * token of letters, digits, `_` and `-`, so it can never express a path, a separator or a credential-shaped value.
 */
export const benignSentinelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{4,128}$/, 'must be a benign sentinel id, not a path or a value');

/** A lowercase persona or role key, as used in access checks and pins. */
export const roleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'must be a lowercase role key');
const httpTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,128}$/, 'must be an HTTP header or cookie name');

/** Most roles one access-matrix check may compare the acting role against (the negative-control roles). */
export const ACCESS_MATRIX_COMPARISON_MAX = 8;

/** An authorisation id (a matrix function or object): a lowercase, path-safe slug. Never a payload. */
export const authzIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'must be an authorisation id');

/**
 * The `access-matrix` oracle (F9, F16; AUTHLOGIC-002). It declares one matrix cell before the test runs: the
 * acting role's access to a function (and optionally one object) is expected to be `expected`, and the
 * comparison roles are the negative controls the outcome is differenced against. Ids only, never credentials.
 */
export const accessMatrixParamsSchema = z
  .strictObject({
    functionId: authzIdSchema,
    objectId: authzIdSchema.optional(),
    actingRole: roleKeySchema,
    comparisonRoles: z
      .array(roleKeySchema)
      .min(1)
      .max(ACCESS_MATRIX_COMPARISON_MAX)
      .refine((roles) => new Set(roles).size === roles.length, 'must not repeat a role'),
    expected: z.enum(['allow', 'deny']),
  })
  .refine(
    (params) => !params.comparisonRoles.includes(params.actingRole),
    'the acting role cannot be its own comparison role',
  );

/** Where a marker token must appear: the raw body, a response header value, or the visible text of an HTML body. */
const MARKER_LOCATIONS = ['body', 'header', 'dom'] as const;
/** Where an error signature is searched: the body or the response headers. */
const ERROR_SIGNATURE_SCOPES = ['body', 'header'] as const;
/** Security attributes a cookie check can require (RFC 6265bis and the SameSite draft). */
const COOKIE_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite'] as const;
const HEADER_DISALLOWED_VALUE_MAX = 120;

export const markerParamsSchema = z.strictObject({
  token: nfcTextSchema(LIMITS.shortTextMax),
  location: z.enum(MARKER_LOCATIONS).default('body'),
});

/** A status differential: the probe must return `expectedStatus`, and that must differ from the recorded baseline. */
export const statusDiffParamsSchema = z
  .strictObject({
    expectedStatus: httpStatusSchema,
    baselineStatus: httpStatusSchema,
  })
  .refine(
    (params) => params.expectedStatus !== params.baselineStatus,
    'expected and baseline statuses must differ',
  );

export const errorSignatureParamsSchema = z.strictObject({
  signature: nfcTextSchema(LIMITS.shortTextMax),
  scope: z.enum(ERROR_SIGNATURE_SCOPES).default('body'),
});

/**
 * A header or cookie assertion. `expectation: 'present'` fails when the header is missing, and `'absent'` fails
 * when it is set. A cookie assertion names one security `attribute` and fails on the cookie's attribute state.
 * A header assertion may name a `disallowedValue` (for example `*` on `Access-Control-Allow-Origin`) that fails when
 * the header carries exactly that value.
 */
export const headerCookieParamsSchema = z
  .strictObject({
    target: z.enum(['header', 'cookie']),
    name: httpTokenSchema,
    expectation: z.enum(['present', 'absent']),
    attribute: z.enum(COOKIE_ATTRIBUTES).optional(),
    disallowedValue: nfcTextSchema(HEADER_DISALLOWED_VALUE_MAX).optional(),
  })
  .superRefine((params, ctx) => {
    if (params.target === 'cookie' && params.attribute === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a cookie assertion must name an attribute',
        path: ['attribute'],
      });
    }
    if (params.target === 'header' && params.attribute !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'only a cookie assertion names an attribute',
        path: ['attribute'],
      });
    }
    if (
      params.disallowedValue !== undefined &&
      (params.target !== 'header' || params.expectation !== 'present')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'a disallowed value applies only to a header that must be present',
        path: ['disallowedValue'],
      });
    }
  });

/** Typed `params` per oracle type. Each shape is strict and holds check parameters only, never a payload. */
export const oracleParamsSchemas = {
  marker: markerParamsSchema,
  status_diff: statusDiffParamsSchema,
  timing_baseline: z.strictObject({
    baselineMs: z.int().min(0).max(TIMING_DELTA_MAX_MS),
    minDeltaMs: z.int().min(1).max(TIMING_DELTA_MAX_MS),
    /** Timed samples per side the verdict needs. Absent means `TIMING_SAMPLES_DEFAULT`. */
    samples: z.int().min(TIMING_SAMPLES_MIN).max(TIMING_SAMPLES_MAX).optional(),
  }),
  oob: z.strictObject({
    channel: z.enum(['dns', 'http', 'smtp']),
    windowMs: z.int().min(1).max(OOB_WINDOW_MAX_MS),
  }),
  access_matrix: accessMatrixParamsSchema,
  error_signature: errorSignatureParamsSchema,
  file_read: z.strictObject({ marker: benignSentinelIdSchema }),
  header_cookie: headerCookieParamsSchema,
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
