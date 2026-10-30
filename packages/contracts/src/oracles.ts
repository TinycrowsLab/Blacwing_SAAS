import { z } from 'zod';

import { isSelectable, intrusivenessClassSchema } from './intrusiveness.js';
import { LIMITS } from './limits.js';
import { nfcTextSchema } from './validation/oracle.js';

/**
 * Validation-oracle catalogue: the declared-before-execution checks a test case binds to, so a candidate
 * finding can later be confirmed deterministically (F14, CONTEXT_PACK §7, REFERENCES §7).
 *
 * This module holds oracle *specs*: declared data with no payload. Execution (replay, observation, the
 * confirm decision) belongs to the VALIDATE epic and imports these schemas; it never re-declares them.
 *
 * Every spec is a discriminated union on `type`. Each `params` object is strict and carries check
 * parameters only. No field accepts a request body, a command or any other free-form payload (§8.11,
 * content safety). Oracles are pure data, so this module has no runtime path of its own.
 */

/** Contract version of this catalogue. Consumers log it so a stored spec can be matched to its schema. */
export const ORACLE_CATALOGUE_VERSION = '1.0.0';

/** Largest serialised spec accepted (an 8 KiB `params` jsonb budget). */
export const ORACLE_SPEC_MAX_BYTES = 8_192;

/** The four response-inspection oracle types in this catalogue. */
export const ORACLE_SPEC_TYPES = [
  'marker',
  'status_diff',
  'error_signature',
  'header_cookie_flag',
] as const;
export type OracleSpecType = (typeof ORACLE_SPEC_TYPES)[number];

/** Stable machine codes `parseOracleSpec` fails with. */
export const ORACLE_SPEC_ERROR_CODES = [
  'ORACLE_TYPE_UNKNOWN',
  'ORACLE_SPEC_INVALID',
  'ORACLE_SPEC_TOO_LARGE',
] as const;
export type OracleSpecErrorCode = (typeof ORACLE_SPEC_ERROR_CODES)[number];

/** Refinement code for a read-only spec that declares a state-changing intrusiveness. */
const READ_ONLY_CONFLICT = 'ORACLE_READ_ONLY_CONFLICT';
/** Refinement code for a header/cookie spec whose `value` disagrees with its `expectation`. */
const VALUE_EXPECTATION_CONFLICT = 'ORACLE_VALUE_EXPECTATION_CONFLICT';

const MAX_STATUS_DIFF_FIELDS = 4;
const HEADER_VALUE_MAX = 120;
/** Header values compared by `equals`: printable tokens, with no quotes, angle brackets or control characters. */
const headerValueSchema = z
  .string()
  .min(1)
  .max(HEADER_VALUE_MAX)
  .regex(/^[A-Za-z0-9 ._:;=,/+*-]+$/, 'must be a printable header value');

/** The `params` object of each type. Strict, and each field is a check parameter, never a payload. */
const markerParams = z.strictObject({
  markerSource: z.enum(['generated', 'caller']),
  echoLocation: z.enum(['body', 'header', 'both']),
  mustReflect: z.boolean(),
});

const statusDiffParams = z.strictObject({
  compareTo: z.enum(['baseline', 'negative_control']),
  fields: z
    .array(z.enum(['status', 'length', 'contentType', 'location']))
    .min(1)
    .max(MAX_STATUS_DIFF_FIELDS)
    .refine((fields) => new Set(fields).size === fields.length, 'must not repeat a field'),
  expectation: z.enum(['differs', 'matches']),
});

const errorSignatureParams = z.strictObject({
  signatureId: nfcTextSchema(LIMITS.keyMax),
  matchIn: z.enum(['body', 'headers']),
  caseSensitive: z.boolean(),
});

const headerCookieFlagParams = z
  .strictObject({
    subject: z.enum(['header', 'cookie']),
    name: nfcTextSchema(LIMITS.shortTextMax),
    attribute: nfcTextSchema(LIMITS.keyMax).optional(),
    expectation: z.enum(['present', 'absent', 'equals']),
    value: headerValueSchema.optional(),
  })
  .superRefine((params, ctx) => {
    const hasValue = params.value !== undefined;
    if (params.expectation === 'equals' && !hasValue) {
      ctx.addIssue({ code: 'custom', message: VALUE_EXPECTATION_CONFLICT, path: ['value'] });
    }
    if (params.expectation !== 'equals' && hasValue) {
      ctx.addIssue({ code: 'custom', message: VALUE_EXPECTATION_CONFLICT, path: ['value'] });
    }
  });

/**
 * One oracle spec variant. The shared envelope is `type`, `description`, `readOnly` (mirrors the MCP
 * `readOnlyHint`; a literal `true` for every type here) and an `intrusiveness` hint. A read-only spec
 * cannot declare a state-changing class. Destructive is never selectable.
 */
function specVariant<T extends OracleSpecType, P extends z.ZodType>(type: T, params: P) {
  return z
    .strictObject({
      type: z.literal(type),
      description: nfcTextSchema(LIMITS.reasonMax),
      readOnly: z.literal(true),
      intrusiveness: intrusivenessClassSchema.refine(isSelectable),
      params,
    })
    .refine(
      (spec) => spec.intrusiveness === 'passive' || spec.intrusiveness === 'active_safe',
      READ_ONLY_CONFLICT,
    );
}

/** Serialised size of a spec. A value that cannot be serialised is treated as over budget. */
function oracleSpecByteLength(spec: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(spec)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The oracle spec: a discriminated union on `type`. An unknown `type` fails the union, which
 * `parseOracleSpec` surfaces as `ORACLE_TYPE_UNKNOWN`.
 */
export const OracleSpecSchema = z
  .discriminatedUnion(
    'type',
    [
      specVariant('marker', markerParams),
      specVariant('status_diff', statusDiffParams),
      specVariant('error_signature', errorSignatureParams),
      specVariant('header_cookie_flag', headerCookieFlagParams),
    ],
    { error: () => 'ORACLE_TYPE_UNKNOWN' },
  )
  .refine((spec) => oracleSpecByteLength(spec) <= ORACLE_SPEC_MAX_BYTES, 'ORACLE_SPEC_TOO_LARGE');
export type OracleSpec = z.infer<typeof OracleSpecSchema>;

/** Human label and standards hint for each oracle type. Standards are IDs, never payloads. */
interface OracleRegistryEntry {
  readonly label: string;
  readonly standards: readonly string[];
}

/** Metadata for every type. `satisfies` makes a new type a compile error until it is described here. */
export const ORACLE_REGISTRY = Object.freeze({
  marker: {
    label: 'Marker reflection',
    standards: ['CWE-79', 'WSTG-INPV-01'],
  },
  status_diff: {
    label: 'Status or response differential',
    standards: ['CWE-639', 'WSTG-ATHZ-02'],
  },
  error_signature: {
    label: 'Catalogued error signature',
    standards: ['CWE-209', 'WSTG-ERRH-01'],
  },
  header_cookie_flag: {
    label: 'Security header or cookie attribute',
    standards: ['CWE-614', 'CWE-1004', 'WSTG-SESS-02'],
  },
} as const satisfies Record<OracleSpecType, OracleRegistryEntry>);

/** Failure from `parseOracleSpec`, carrying a stable `code` from `ORACLE_SPEC_ERROR_CODES`. */
export class OracleSpecError extends Error {
  readonly code: OracleSpecErrorCode;

  constructor(code: OracleSpecErrorCode, message: string) {
    super(message);
    this.name = 'OracleSpecError';
    this.code = code;
  }
}

/**
 * Parses an untrusted, already-decoded JSON value into an `OracleSpec`. Fails closed with an
 * `OracleSpecError`: `ORACLE_SPEC_TOO_LARGE` over the byte budget, `ORACLE_TYPE_UNKNOWN` for an unknown
 * or removed `type`, otherwise `ORACLE_SPEC_INVALID`.
 */
export function parseOracleSpec(json: unknown): OracleSpec {
  if (oracleSpecByteLength(json) > ORACLE_SPEC_MAX_BYTES) {
    throw new OracleSpecError('ORACLE_SPEC_TOO_LARGE', 'oracle spec exceeds the size budget');
  }
  const result = OracleSpecSchema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  const unknownType = result.error.issues.some(
    (issue) => issue.code === 'invalid_union' && issue.message === 'ORACLE_TYPE_UNKNOWN',
  );
  if (unknownType) {
    throw new OracleSpecError('ORACLE_TYPE_UNKNOWN', 'oracle type is not in the catalogue');
  }
  throw new OracleSpecError('ORACLE_SPEC_INVALID', result.error.message);
}

/** True when `value` is a valid `OracleSpec`. */
export function isOracleSpec(value: unknown): value is OracleSpec {
  return OracleSpecSchema.safeParse(value).success;
}
