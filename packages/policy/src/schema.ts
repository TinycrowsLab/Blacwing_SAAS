import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkParseSchema, validate, type CedarValueJson } from '@cedar-policy/cedar-wasm/nodejs';

import {
  INTRUSIVENESS_ORDER,
  intrusivenessClassSchema,
  type IntrusivenessClass,
} from '@blackwing/contracts';

import type { CedarDatetime, Intrusiveness } from './schema.types.js';

/**
 * Semantic version of `schema/blackwing.cedarschema` (POLICY-001). Recorded by every policy
 * snapshot (POLICY-007) and pinned per run (§8.9). Rules (schema/README.md): adding an entity
 * type, attribute or action is a minor bump; removing or renaming one, or changing a type, is a
 * major bump that requires a snapshot/version migration. `SCHEMA_SHA256` must change with it.
 */
export const SCHEMA_VERSION = '2.0.0';

/**
 * SHA-256 (hex) of the schema file bytes for `SCHEMA_VERSION`. A contract test recomputes it, so
 * editing the schema without bumping the version (and this digest) fails review-visibly.
 */
export const SCHEMA_SHA256 = '6cc43de6cdc80c1151f35ee1f0c30ffc6bef53a4a53849d52d5c6ee62c1b4d75';

/** Absolute path of the shared Cedar schema (also read by the Go egress gateway's tests). */
export const BLACKWING_SCHEMA_PATH = fileURLToPath(
  new URL('../schema/blackwing.cedarschema', import.meta.url),
);

let cachedSchema: string | undefined;

/** The Cedar schema text (human-readable format), read once and cached. */
export function loadBlackwingSchema(): string {
  cachedSchema ??= readFileSync(BLACKWING_SCHEMA_PATH, 'utf8');
  return cachedSchema;
}

/** SHA-256 (hex) of the given schema text, as recorded in snapshots. */
export function schemaDigest(schemaText: string = loadBlackwingSchema()): string {
  return createHash('sha256').update(schemaText, 'utf8').digest('hex');
}

/** What a policy snapshot (POLICY-007) and a run's version pin (§8.9) record about the schema. */
export interface SchemaPin {
  readonly schemaVersion: string;
  readonly schemaSha256: string;
}

/** The schema pin for the schema this package ships. */
export function schemaPin(): SchemaPin {
  return { schemaVersion: SCHEMA_VERSION, schemaSha256: SCHEMA_SHA256 };
}

/** Result of a schema or policy validation; `errors` is empty exactly when `ok` is true. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Parses and checks the schema itself with `@cedar-policy/cedar-wasm`. */
export function validateSchema(schemaText: string = loadBlackwingSchema()): ValidationResult {
  const answer = checkParseSchema(schemaText);
  return answer.type === 'success'
    ? { ok: true, errors: [] }
    : { ok: false, errors: answer.errors.map((e) => e.message) };
}

/**
 * Strictly validates Cedar policy text (one policy-set text, or a map of policy id to the text of
 * exactly one policy, so errors name the ids) against the schema. Any parse error, unknown entity type,
 * action or attribute, or type error makes the result `ok: false`; callers must treat that as a
 * rejected policy (never load it). Validator warnings (e.g. a policy that can never apply because
 * its scope matches no declared action signature) are rejected too: a `forbid` that silently
 * never fires would weaken the baseline.
 */
export function validatePolicies(
  policyText: string | Readonly<Record<string, string>>,
  schemaText: string = loadBlackwingSchema(),
): ValidationResult {
  const answer = validate({
    schema: schemaText,
    policies: { staticPolicies: typeof policyText === 'string' ? policyText : { ...policyText } },
    validationSettings: { mode: 'strict' },
  });
  if (answer.type === 'failure') {
    return { ok: false, errors: answer.errors.map((e) => e.message) };
  }
  const errors = [...answer.validationErrors, ...answer.validationWarnings].map(
    (e) => `${e.policyId}: ${e.error.message}`,
  );
  return { ok: errors.length === 0, errors };
}

/**
 * Builds the Cedar `Intrusiveness` value for a class: its entity reference plus its rank in the
 * SCOPE-003 order. The only supported way to build one, so `rank` can never disagree with
 * `level`. Untyped input is parsed strictly (`SCOPE_INVALID_CLASS` on anything unknown).
 */
export function intrusivenessValue(cls: IntrusivenessClass): Intrusiveness {
  const level = intrusivenessClassSchema.parse(cls);
  return {
    level: { __entity: { type: 'Blackwing::IntrusivenessClass', id: level } },
    rank: INTRUSIVENESS_ORDER[level],
  };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Wraps an ISO-8601 UTC instant (`…Z`) as a Cedar `datetime` value; rejects anything else. */
export function cedarDatetime(isoUtc: string): CedarDatetime {
  if (!ISO_UTC.test(isoUtc) || Number.isNaN(Date.parse(isoUtc))) {
    throw new RangeError(`not an ISO-8601 UTC instant: ${JSON.stringify(isoUtc)}`);
  }
  return { __extn: { fn: 'datetime', arg: isoUtc } };
}

/**
 * Converts a typed entity-attribute or context value (see `schema.types.ts`) into the plain
 * Cedar JSON record the engine accepts. It is a deep copy, so the caller's object is never shared
 * with the engine (optional attributes are omitted, never `undefined`, under
 * `exactOptionalPropertyTypes`).
 */
export function toCedarAttrs(value: object): Record<string, CedarValueJson> {
  return structuredClone(value) as Record<string, CedarValueJson>;
}
