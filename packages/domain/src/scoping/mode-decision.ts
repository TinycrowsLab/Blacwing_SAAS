import { z } from 'zod';

import {
  type RunMode,
  runBudgetSchema,
  runModeSchema,
  scopeRulesSchema,
} from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';

import {
  type CanonicalTarget,
  canonicaliseTarget,
  redactedTargetValue,
  type SuppliedTarget,
  suppliedTargetSchema,
} from './targets.js';
import {
  RECON_PERSONAS,
  type ReconManifestEntry,
  type ReconPersona,
  resolveReconManifest,
} from '../recon/manifest.js';
import { matchScope } from '../scope/matcher.js';

/**
 * Recon plan decision (CONTEXT_PACK §3.2 step 2, F7): given an assessment request and its input manifest,
 * decide which recon personas the Run Controller dispatches and which it skips, with a human-readable reason
 * for each. Pure and deterministic: no IO, no clock, no randomness. The same inputs always give the same plan.
 *
 * The mode -> persona table and the budget slices come from `resolveReconManifest` (ORCH-004), the one place
 * that table lives. This module only narrows it by what the manifest supplies: clean spec and source objects
 * (SCOPE-009), credential references, and the in-scope targets (SCOPE-002).
 */

export class InvalidAssessmentModeError extends AppError {
  constructor(message: string) {
    super('SCOPE_INVALID_MODE', message, { detail: message });
    this.name = 'InvalidAssessmentModeError';
  }
}

const OBJECT_STATUSES = ['clean', 'pending_scan', 'blocked'] as const;
const objectStatusSchema = z.enum(OBJECT_STATUSES);

/** Spec kinds that can describe an API surface (grey/white box coverage). */
const COVERAGE_SPEC_KINDS: ReadonlySet<string> = new Set(['openapi', 'graphql', 'postman']);

const MAX_TARGETS = 1000;
const MAX_OBJECTS = 100;
const MAX_CREDENTIAL_REFS = 100;
const ROLE_MAX = 100;
const REF_MAX = 512;

/** One uploaded spec object (`input_manifests.spec_objects`). `coveredTargets` lists what the spec describes. */
const specObjectSchema = z.object({
  kind: z.enum(['openapi', 'graphql', 'postman', 'har']),
  objectKey: z.string().min(1).max(REF_MAX),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  status: objectStatusSchema,
  coveredTargets: z.array(suppliedTargetSchema).max(MAX_TARGETS).default([]),
});

/** A source repository reference (`input_manifests.source_repo`). Missing status means not scanned. */
const sourceRepoSchema = z.object({
  url: z.string().max(REF_MAX).optional(),
  ref: z.string().max(REF_MAX).optional(),
  deployKeyRef: z.string().max(REF_MAX).optional(),
  archiveKey: z.string().max(REF_MAX).optional(),
  status: objectStatusSchema.optional(),
});

const credentialRefSchema = z.object({
  role: z.string().min(1).max(ROLE_MAX),
  secretRef: z.string().min(1).max(REF_MAX),
});

/** The part of an input manifest the recon plan reads (SCOPE-001). Credentials are references, never secrets. */
export const reconInputManifestSchema = z.object({
  suppliedTargets: z.array(suppliedTargetSchema).max(MAX_TARGETS),
  specObjects: z.array(specObjectSchema).max(MAX_OBJECTS),
  credentialRefs: z.array(credentialRefSchema).max(MAX_CREDENTIAL_REFS),
  sourceRepo: sourceRepoSchema.nullable(),
});
export type ReconInputManifest = z.input<typeof reconInputManifestSchema>;

/** The part of an assessment request the recon plan reads (SCOPE-005). */
const reconRequestSchema = z.object({
  mode: runModeSchema,
  budgets: runBudgetSchema,
  scopeRules: scopeRulesSchema,
});
export type ReconRequest = z.input<typeof reconRequestSchema>;

export const reconPlanSchema = z.object({
  mode: runModeSchema,
  personas: z.array(
    z.object({
      persona: z.enum(RECON_PERSONAS),
      reason: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()),
    }),
  ),
  skipped: z.array(z.object({ persona: z.enum(RECON_PERSONAS), reason: z.string().min(1) })),
  /** Targets and objects the plan refused, each with the reason (scope is authoritative, SCOPE-002). */
  excluded: z.object({
    targets: z.array(z.object({ kind: z.string(), value: z.string(), reason: z.string().min(1) })),
    objects: z.array(
      z.object({
        kind: z.string(),
        sha256: z.string().optional(),
        status: objectStatusSchema,
        reason: z.string().min(1),
      }),
    ),
  }),
  warnings: z.array(z.string()),
});
export type ReconPlan = z.infer<typeof reconPlanSchema>;

/** A spec or source group after de-duplication by sha256 (fail closed: one non-clean copy taints the group). */
interface ObjectGroup {
  readonly kind: string;
  readonly sha256: string;
  readonly status: (typeof OBJECT_STATUSES)[number];
  readonly coveredTargets: readonly SuppliedTarget[];
}

function groupSpecObjects(objects: z.output<typeof specObjectSchema>[]): ObjectGroup[] {
  const byDigest = new Map<string, z.output<typeof specObjectSchema>[]>();
  for (const object of objects) {
    const copies = byDigest.get(object.sha256) ?? [];
    copies.push(object);
    byDigest.set(object.sha256, copies);
  }
  const groups: ObjectGroup[] = [];
  for (const [sha256, copies] of byDigest) {
    const first = copies[0];
    if (first === undefined) continue;
    const sameKind = copies.every((c) => c.kind === first.kind);
    const allClean = copies.every((c) => c.status === 'clean');
    const anyBlocked = copies.some((c) => c.status === 'blocked');
    let status: ObjectGroup['status'] = 'pending_scan';
    if (allClean && sameKind) status = 'clean';
    else if (anyBlocked || !sameKind) status = 'blocked';
    groups.push({
      kind: first.kind,
      sha256,
      status,
      coveredTargets: copies.flatMap((c) => c.coveredTargets),
    });
  }
  return groups.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
}

const byValue = (a: CanonicalTarget, b: CanonicalTarget): number =>
  a.kind === b.kind
    ? a.value < b.value
      ? -1
      : a.value > b.value
        ? 1
        : 0
    : a.kind < b.kind
      ? -1
      : 1;

/** Shared fields of every planned persona: its budget slice and intrusiveness ceiling. */
const budgetInputs = (entry: ReconManifestEntry): Record<string, unknown> => ({
  budget: entry.budget,
  intrusiveness: entry.intrusiveness,
});

/**
 * Decides the recon plan for an assessment request and its input manifest (CONTEXT_PACK §3.2 step 2, F7).
 *
 * Mode rules come from the shared table. A grey or white request with a clean spec that covers every in-scope
 * target skips the black-box discovery personas (F7) and keeps `active-recon` to confirm the deployed surface.
 * Only clean objects feed `source-spec-ingestion`. Credential references feed `session-setup`. Targets outside
 * the request's scope rules are dropped with a reason.
 *
 * Throws `SCOPE_INVALID_MODE` for an unknown mode (checked before anything else), `VALIDATION_FAILED` for any
 * other malformed input, and an internal error if the plan would dispatch no recon at all (cannot happen with
 * the shared table, asserted anyway).
 */
export function decideReconPlan(request: unknown, manifest: unknown): ReconPlan {
  const rawMode =
    typeof request === 'object' && request !== null && 'mode' in request ? request.mode : undefined;
  const modeCheck = runModeSchema.safeParse(rawMode);
  if (!modeCheck.success) {
    throw new InvalidAssessmentModeError('Unknown assessment mode for the recon plan.');
  }
  const mode: RunMode = modeCheck.data;

  const requestParse = reconRequestSchema.safeParse(request);
  const manifestParse = reconInputManifestSchema.safeParse(manifest);
  if (!requestParse.success || !manifestParse.success) {
    throw new ValidationError('Invalid input for the recon plan', {
      detail: 'Invalid assessment request or input manifest.',
    });
  }
  const req = requestParse.data;
  const man = manifestParse.data;
  const coverageApplies = mode !== 'black';

  // Spec and source objects: only clean ones feed ingestion. Excluded ones are reported, never silently dropped.
  const excludedObjects: {
    kind: string;
    sha256?: string;
    status: ObjectGroup['status'];
    reason: string;
  }[] = [];
  const specGroups = groupSpecObjects(man.specObjects);
  const cleanSpecs = specGroups.filter((g) => g.status === 'clean');
  for (const group of specGroups) {
    if (group.status === 'clean') continue;
    excludedObjects.push({
      kind: group.kind,
      sha256: group.sha256,
      status: group.status,
      reason: `${group.status} spec object is excluded from source-spec-ingestion (only clean objects are fed)`,
    });
  }
  const source = man.sourceRepo;
  const cleanSource = source !== null && source.status === 'clean' ? source : null;
  if (source !== null && cleanSource === null) {
    const status = source.status ?? 'pending_scan';
    excludedObjects.push({
      kind: 'source_repo',
      status,
      reason: `${status} source repository is excluded from source-spec-ingestion (only clean objects are fed)`,
    });
  }

  // Targets: canonical form, then scope (authoritative), then de-duplication by canonical value.
  const scopedTargets: CanonicalTarget[] = [];
  const excludedTargets: { kind: string; value: string; reason: string }[] = [];
  const seenValues = new Set<string>();
  for (const raw of man.suppliedTargets) {
    const canonical = canonicaliseTarget(raw);
    if (!canonical.ok) {
      excludedTargets.push({
        kind: raw.kind,
        value: redactedTargetValue(raw),
        reason: canonical.reason,
      });
      continue;
    }
    const decision = matchScope(canonical.target.scope, req.scopeRules);
    if (!decision.inScope) {
      excludedTargets.push({
        kind: raw.kind,
        value: redactedTargetValue(raw),
        reason: `outside the request scope: ${decision.reason}`,
      });
      continue;
    }
    if (seenValues.has(canonical.target.value)) continue;
    seenValues.add(canonical.target.value);
    scopedTargets.push(canonical.target);
  }
  scopedTargets.sort(byValue);
  const scopedValues = scopedTargets.map((t) => t.value);

  // F7 coverage: every in-scope target is named by a clean coverage spec (grey and white only).
  const coveredIdentities = new Set<string>();
  for (const group of cleanSpecs) {
    if (!COVERAGE_SPEC_KINDS.has(group.kind)) continue;
    for (const covered of group.coveredTargets) {
      const canonical = canonicaliseTarget(covered);
      if (canonical.ok) coveredIdentities.add(canonical.target.identity);
    }
  }
  const coveredBySpec =
    coverageApplies &&
    scopedTargets.length > 0 &&
    scopedTargets.every((t) => coveredIdentities.has(t.identity));

  // Budget slices and the fallback warning come from the shared table. Supplied surface only counts when clean.
  const recon = resolveReconManifest(mode, req.budgets, {
    manifestSupplied: cleanSpecs.length > 0 || cleanSource !== null,
  });

  const personas: { persona: ReconPersona; reason: string; inputs: Record<string, unknown> }[] = [];
  const skipped: { persona: ReconPersona; reason: string }[] = [];
  const warnings: string[] = [...recon.warnings];
  if (scopedTargets.length === 0) warnings.push('RECON_NO_IN_SCOPE_TARGETS');
  const fellBack = recon.warnings.includes('RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON');

  if (coveredBySpec) {
    const kinds = [...new Set(cleanSpecs.map((g) => g.kind))].sort().join(', ');
    for (const persona of ['passive-recon', 'osint'] as const) {
      skipped.push({
        persona,
        reason: `clean ${kinds} spec covers every in-scope target; black-box discovery is not needed (F7)`,
      });
    }
  }

  for (const entry of recon.entries) {
    switch (entry.persona) {
      case 'passive-recon':
        personas.push({
          persona: entry.persona,
          reason:
            'black box: third-party passive recon (DNS, certificate transparency, archives, fingerprints)',
          inputs: { ...budgetInputs(entry), targets: scopedValues },
        });
        break;
      case 'osint':
        personas.push({
          persona: entry.persona,
          reason:
            'black box: organisation footprint and leaked-credential metadata (no credential use)',
          inputs: { ...budgetInputs(entry), targets: scopedValues },
        });
        break;
      case 'active-recon': {
        const scope = entry.minimal ? 'confirm-deployed-surface' : 'full-discovery';
        let reason: string;
        if (entry.minimal)
          reason = 'white box: minimal active recon to confirm the deployed surface';
        else if (mode === 'grey') reason = 'grey box: active recon to confirm the supplied surface';
        else if (fellBack)
          reason = 'no supplied surface: full active discovery to confirm the surface';
        else reason = 'black box: full active discovery inside the standing authorisation';
        personas.push({
          persona: entry.persona,
          reason,
          inputs: {
            ...budgetInputs(entry),
            targets: scopedValues,
            scope,
            suppliedSurfaceCovered: coveredBySpec,
          },
        });
        break;
      }
      case 'threat-intel':
        personas.push({
          persona: entry.persona,
          reason: 'CVE/KEV/EPSS/GHSA/OSV enrichment for detected components',
          inputs: budgetInputs(entry),
        });
        break;
      case 'source-spec-ingestion':
        if (cleanSpecs.length > 0 || cleanSource !== null) {
          personas.push({
            persona: entry.persona,
            reason: `ingest ${cleanSpecs.length} clean spec object(s) and ${cleanSource === null ? 'no' : 'one'} clean source repository into the surface model`,
            inputs: {
              ...budgetInputs(entry),
              specObjects: cleanSpecs.map((g) => ({ kind: g.kind, sha256: g.sha256 })),
              sourceRepo: cleanSource,
            },
          });
        } else {
          skipped.push({
            persona: entry.persona,
            reason:
              excludedObjects.length > 0
                ? 'no clean spec or source object supplied; the supplied objects are excluded until they are scanned'
                : 'no spec or source object supplied',
          });
        }
        break;
      case 'session-setup':
        if (man.credentialRefs.length > 0) {
          const roles = [...new Set(man.credentialRefs.map((c) => c.role))].sort();
          personas.push({
            persona: entry.persona,
            reason: `log in and verify ${roles.length} role(s) from the supplied credential references`,
            inputs: { ...budgetInputs(entry), roles },
          });
        } else {
          skipped.push({ persona: entry.persona, reason: 'no credential references supplied' });
        }
        break;
    }
  }

  // Invariant: every mode keeps active-recon or threat-intel, so a plan can never be empty (fail closed).
  if (!personas.some((p) => p.persona === 'active-recon' || p.persona === 'threat-intel')) {
    throw new AppError('INTERNAL', 'Recon plan dispatches no active or threat-intel persona', {
      detail: 'Recon plan invariant violated.',
    });
  }

  return reconPlanSchema.parse({
    mode,
    personas,
    skipped,
    excluded: { targets: excludedTargets, objects: excludedObjects },
    warnings,
  });
}
