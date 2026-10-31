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
/** How a status differential compares the probe with its recorded baseline. */
const STATUS_DIFF_COMPARES = ['status', 'length', 'structural'] as const;
/** Security attributes a cookie check can require (RFC 6265bis and the SameSite draft). */
const COOKIE_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite'] as const;
const HEADER_DISALLOWED_VALUE_MAX = 120;
/** Most signatures one error check declares, and most assertions one header check declares. */
const ERROR_SIGNATURES_MAX = 32;
const HEADER_ASSERTIONS_MAX = 32;
/** Largest tolerated length or structural difference a status differential may declare (one body's bound). */
const STATUS_DIFF_THRESHOLD_MAX = 65_536;

export const markerParamsSchema = z.strictObject({
  token: nfcTextSchema(LIMITS.shortTextMax),
  location: z.enum(MARKER_LOCATIONS).default('body'),
});

/**
 * A status differential against a baseline recorded earlier in the same replay. `baselineRef` names that exchange's
 * evidence reference. `compare: 'status'` fires when the status differs and takes no threshold. `'length'` and
 * `'structural'` fire when the difference exceeds `threshold` (characters, or differing structural tokens).
 */
export const statusDiffParamsSchema = z
  .strictObject({
    baselineRef: evidenceRefSchema,
    compare: z.enum(STATUS_DIFF_COMPARES),
    threshold: z.int().min(0).max(STATUS_DIFF_THRESHOLD_MAX).default(0),
  })
  .refine(
    (params) => params.compare !== 'status' || params.threshold === 0,
    'a status comparison takes no threshold',
  );

export const errorSignatureParamsSchema = z.strictObject({
  signatures: z
    .array(nfcTextSchema(LIMITS.shortTextMax))
    .min(1)
    .max(ERROR_SIGNATURES_MAX)
    .refine((values) => new Set(values).size === values.length, 'signatures must be distinct'),
  scope: z.enum(ERROR_SIGNATURE_SCOPES).default('body'),
});

/**
 * One header or cookie assertion. A header with `expectation: 'present'` fails when it is missing, `'absent'` fails
 * when it is set, and `'not_value'` fails when it carries `disallowedValue` (for example `*` on
 * `Access-Control-Allow-Origin`). A missing header is never a `not_value` failure. A cookie assertion names one
 * security `attribute` and fails on the cookie's attribute state (`'present'`: the attribute is missing).
 */
const headerCookieAssertionSchema = z
  .strictObject({
    target: z.enum(['header', 'cookie']),
    name: httpTokenSchema,
    expectation: z.enum(['present', 'absent', 'not_value']),
    attribute: z.enum(COOKIE_ATTRIBUTES).optional(),
    disallowedValue: nfcTextSchema(HEADER_DISALLOWED_VALUE_MAX).optional(),
  })
  .superRefine((assertion, ctx) => {
    const issue = (message: string, path: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [path] });
    };
    if (assertion.target === 'cookie') {
      if (assertion.attribute === undefined)
        issue('a cookie assertion must name an attribute', 'attribute');
      if (assertion.expectation === 'not_value') {
        issue('a cookie assertion cannot use not_value', 'expectation');
      }
      if (assertion.disallowedValue !== undefined) {
        issue('a disallowed value applies only to a header', 'disallowedValue');
      }
      return;
    }
    if (assertion.attribute !== undefined)
      issue('only a cookie assertion names an attribute', 'attribute');
    if (assertion.expectation === 'not_value' && assertion.disallowedValue === undefined) {
      issue('a not_value assertion must name the disallowed value', 'disallowedValue');
    }
    if (assertion.expectation !== 'not_value' && assertion.disallowedValue !== undefined) {
      issue('a disallowed value applies only to not_value', 'disallowedValue');
    }
  });

/** A header-cookie check: it fires when any one of its assertions fails. */
export const headerCookieParamsSchema = z.strictObject({
  assertions: z.array(headerCookieAssertionSchema).min(1).max(HEADER_ASSERTIONS_MAX),
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
