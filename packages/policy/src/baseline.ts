import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { policySetTextToParts } from '@cedar-policy/cedar-wasm/nodejs';

import { schemaPin, validatePolicies, type SchemaPin } from './schema.js';

/**
 * Semantic version of the platform baseline policy set (`policies/baseline/*.cedar`, POLICY-002).
 * Any change to a baseline file is a platform-operator action: bump this version and
 * `BASELINE_SHA256` together (a contract test recomputes the digest). Adding a `forbid` is a minor
 * bump; changing or removing one is a major bump and needs a security review, because the
 * baseline is the deterministic floor every tenant inherits (§8, §8.11).
 */
export const BASELINE_VERSION = '1.0.0';

/** SHA-256 (hex) of the baseline as computed by `baselineDigest()` for `BASELINE_VERSION`. */
export const BASELINE_SHA256 = '3f3e4676672182a6ac92d8b97b80368ef0816c03294baa156a4099d250e02566';

/** Every baseline policy id starts with this prefix; tenants may never use it. */
export const BASELINE_ID_PREFIX = 'baseline.';

/** Absolute path of the directory holding the baseline `.cedar` files. */
export const BASELINE_DIR = fileURLToPath(new URL('../policies/baseline/', import.meta.url));

/** One baseline policy: its `@id` (`baseline.<file>[.<suffix>]`), source file name and Cedar text. */
export interface BaselinePolicy {
  readonly id: string;
  readonly file: string;
  readonly text: string;
}

/** One baseline source file and its exact bytes (what the digest covers). */
export interface BaselineFile {
  readonly file: string;
  readonly source: string;
}

/** The loaded baseline: its source files and the policies they contain, both in load order. */
export interface Baseline {
  readonly files: readonly BaselineFile[];
  readonly policies: readonly BaselinePolicy[];
}

/** Thrown when the shipped baseline is malformed; the platform must refuse to start. */
export class BaselineIntegrityError extends Error {
  override readonly name = 'BaselineIntegrityError';
}

const ID_ANNOTATION = /@id\(\s*"([^"]*)"\s*\)/g;

function annotatedIds(text: string): string[] {
  return [...text.matchAll(ID_ANNOTATION)].map((m) => m[1] ?? '');
}

/** Splits policy-set text into static policies; `undefined` on a parse error or any template. */
function staticParts(text: string): readonly string[] | undefined {
  const parts = policySetTextToParts(text);
  if (parts.type !== 'success' || parts.policy_templates.length > 0) return undefined;
  return parts.policies;
}

let cachedBaseline: Baseline | undefined;

/**
 * Loads the baseline in file-name order. A file holds one or more static policies (Cedar's strict
 * validator needs one policy per action namespace), each annotated with a unique
 * `@id("baseline.<file name>")` or `@id("baseline.<file name>.<suffix>")`; anything else throws
 * `BaselineIntegrityError`, so a malformed baseline can never load partially.
 */
export function loadBaseline(dir: string = BASELINE_DIR): Baseline {
  if (dir === BASELINE_DIR && cachedBaseline) return cachedBaseline;
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.cedar'))
    .sort();
  if (names.length === 0) throw new BaselineIntegrityError(`no baseline policies in ${dir}`);
  const files: BaselineFile[] = [];
  const policies: BaselinePolicy[] = [];
  const seen = new Set<string>();
  for (const file of names) {
    const base = `${BASELINE_ID_PREFIX}${file.slice(0, -'.cedar'.length)}`;
    const source = readFileSync(join(dir, file), 'utf8');
    const parts = staticParts(source);
    if (!parts || parts.length === 0) {
      throw new BaselineIntegrityError(`${file}: must parse as one or more static policies`);
    }
    for (const text of parts) {
      const ids = annotatedIds(text);
      const id = ids[0];
      if (ids.length !== 1 || id === undefined || !(id === base || id.startsWith(`${base}.`))) {
        throw new BaselineIntegrityError(
          `${file}: every policy needs one @id("${base}[.<suffix>]")`,
        );
      }
      if (seen.has(id)) throw new BaselineIntegrityError(`${file}: duplicate policy id ${id}`);
      seen.add(id);
      policies.push(Object.freeze({ id, file, text }));
    }
    files.push(Object.freeze({ file, source }));
  }
  const baseline: Baseline = Object.freeze({
    files: Object.freeze(files),
    policies: Object.freeze(policies),
  });
  if (dir === BASELINE_DIR) cachedBaseline = baseline;
  return baseline;
}

/** The baseline policies in load order (see `loadBaseline`). */
export function loadBaselinePolicies(dir: string = BASELINE_DIR): readonly BaselinePolicy[] {
  return loadBaseline(dir).policies;
}

/**
 * SHA-256 (hex) over the baseline source files in load order: for each file, its name and its
 * exact bytes, each terminated by NUL, so renaming, reordering or editing any file (comments
 * included) changes the digest.
 */
export function baselineDigest(baseline: Baseline = loadBaseline()): string {
  const hash = createHash('sha256');
  for (const f of baseline.files) hash.update(`${f.file}\0${f.source}\0`, 'utf8');
  return hash.digest('hex');
}

/** What a policy snapshot (POLICY-007) and a run's version pin (§8.9) record about the baseline. */
export interface BaselinePin {
  readonly baselineVersion: string;
  readonly baselineSha256: string;
}

/** The baseline pin for the baseline this package ships. */
export function baselinePin(): BaselinePin {
  return { baselineVersion: BASELINE_VERSION, baselineSha256: BASELINE_SHA256 };
}

/** True when `id` is in the reserved baseline namespace. */
export function isBaselinePolicyId(id: string): boolean {
  return id.startsWith(BASELINE_ID_PREFIX);
}

/** A compiled policy set: baseline first, then tenant policies, all keyed by policy id. */
export interface CompiledPolicySet {
  readonly ok: true;
  /** Policy id → text, in evaluation-set order (baseline ids first). */
  readonly staticPolicies: Readonly<Record<string, string>>;
  readonly baselineIds: readonly string[];
  readonly tenantIds: readonly string[];
  readonly pin: BaselinePin & SchemaPin;
}

/** A rejected tenant policy set; nothing from it may be loaded. */
export interface RejectedPolicySet {
  readonly ok: false;
  readonly errors: readonly string[];
}

/**
 * Compiles a tenant policy set on top of the platform baseline. Baseline policies are placed
 * first and are never replaceable: a tenant id or `@id` annotation in the reserved `baseline.`
 * namespace, a duplicate id, an entry that is not exactly one static policy, or any strict schema
 * validation error (unknown entity/action/attribute, i.e. an attempt to redefine the model)
 * rejects the whole set. Because Cedar `forbid` always overrides `permit`, no tenant `permit` can
 * undo a baseline `forbid`; the tenant layer can only narrow what the baseline allows.
 */
export function compilePolicySet(
  tenantPolicies: Readonly<Record<string, string>> = {},
): CompiledPolicySet | RejectedPolicySet {
  const baseline = loadBaselinePolicies();
  const errors: string[] = [];
  const staticPolicies: Record<string, string> = {};
  for (const p of baseline) staticPolicies[p.id] = p.text;

  const tenantIds: string[] = [];
  for (const [id, text] of Object.entries(tenantPolicies)) {
    if (id.trim() === '') {
      errors.push('tenant policy id must not be empty');
      continue;
    }
    if (isBaselinePolicyId(id)) {
      errors.push(`${id}: the "${BASELINE_ID_PREFIX}" id namespace is reserved for the platform`);
      continue;
    }
    if (annotatedIds(text).some((a) => isBaselinePolicyId(a))) {
      errors.push(`${id}: @id annotations in the "${BASELINE_ID_PREFIX}" namespace are reserved`);
      continue;
    }
    if (staticParts(text)?.length !== 1) {
      errors.push(`${id}: must contain exactly one static policy`);
      continue;
    }
    staticPolicies[id] = text;
    tenantIds.push(id);
  }
  if (errors.length > 0) return { ok: false, errors };

  const validation = validatePolicies(staticPolicies);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  return {
    ok: true,
    staticPolicies: Object.freeze(staticPolicies),
    baselineIds: Object.freeze(baseline.map((p) => p.id)),
    tenantIds: Object.freeze(tenantIds),
    pin: { ...baselinePin(), ...schemaPin() },
  };
}
