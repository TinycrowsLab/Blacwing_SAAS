import {
  isWithinCeiling,
  isWithinSaDefaults,
  type IntrusivenessClass,
  type SubmitErrorCode,
} from '@blackwing/contracts';

import { canonicalize } from '../concurrency/index.js';

import type { AssetFact, StandingAuthorisationFact } from './ports.js';

/** The fields of a request the submit gate checks. */
export interface SubmitCheckInput {
  readonly assetIds: readonly string[];
  readonly saId: string | null;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly scopeRules: unknown;
  readonly budgets: Record<string, unknown>;
}

/** One failing check, addressed to the input field it concerns. */
export interface SubmitFailure {
  readonly code: SubmitErrorCode;
  readonly path: string;
  readonly message: string;
}

const MESSAGES: Readonly<Record<SubmitErrorCode, string>> = Object.freeze({
  NO_ASSETS: 'A request needs at least one asset to be submitted.',
  SA_REQUIRED: 'Submit needs a standing authorisation in this tenant.',
  SA_NOT_ACTIVE: 'The standing authorisation is not active.',
  SA_EXPIRED: 'The standing authorisation has expired.',
  SA_SCOPE_MISMATCH: 'The standing authorisation does not cover this asset.',
  ASSET_NOT_VERIFIED: 'The asset is not verified: only verified assets may be targeted.',
  INTRUSIVENESS_EXCEEDS_SA: 'The requested intrusiveness exceeds the standing authorisation.',
  INTRUSIVENESS_NOT_AUTHORISED: 'The standing authorisation does not permit state-changing tests.',
  SCOPE_EXCEEDS_SA: 'A scope rule is not covered by the standing authorisation.',
  BUDGET_EXCEEDS_SA: 'A budget exceeds the standing authorisation defaults.',
});

/** The rules of a `{ rules: [...] }` scope object; anything else holds no rules. */
function rulesOf(scope: unknown): readonly unknown[] {
  if (typeof scope !== 'object' || scope === null || !('rules' in scope)) return [];
  const rules: unknown = scope.rules;
  return Array.isArray(rules) ? rules : [];
}

/**
 * Every check of the submit gate (SCOPE-005 requirement 3), run in full: a request that fails several checks
 * reports all of them, so the wizard can show them together. Pure: no I/O, the caller supplies the facts.
 * `sa` is the tenant's standing authorisation, or undefined when none is visible to the caller.
 */
export function checkSubmission(
  request: SubmitCheckInput,
  assets: readonly AssetFact[],
  sa: StandingAuthorisationFact | undefined,
  now: Date,
): SubmitFailure[] {
  const failures: SubmitFailure[] = [];
  const fail = (code: SubmitErrorCode, path: string) => {
    failures.push({ code, path, message: MESSAGES[code] });
  };

  if (request.assetIds.length === 0) fail('NO_ASSETS', 'assetIds');
  const verified = new Map(assets.map((asset) => [asset.id, asset.verificationStatus]));
  request.assetIds.forEach((assetId, index) => {
    if (verified.get(assetId) !== 'verified')
      fail('ASSET_NOT_VERIFIED', `assetIds[${String(index)}]`);
  });

  if (sa === undefined) {
    fail('SA_REQUIRED', 'saId');
    return failures;
  }
  if (sa.expiresAt.getTime() <= now.getTime() || sa.status === 'expired') {
    fail('SA_EXPIRED', 'saId');
  } else if (sa.status !== 'active') {
    fail('SA_NOT_ACTIVE', 'saId');
  }

  const covered = new Set(sa.assetIds);
  request.assetIds.forEach((assetId, index) => {
    if (!covered.has(assetId)) fail('SA_SCOPE_MISMATCH', `assetIds[${String(index)}]`);
  });

  if (
    request.maxIntrusiveness === 'state_changing' &&
    !isWithinCeiling('state_changing', sa.maxIntrusiveness)
  ) {
    fail('INTRUSIVENESS_NOT_AUTHORISED', 'maxIntrusiveness');
  } else if (!isWithinCeiling(request.maxIntrusiveness, sa.maxIntrusiveness)) {
    fail('INTRUSIVENESS_EXCEEDS_SA', 'maxIntrusiveness');
  }

  // Exact-match subset: every requested rule must be byte-equal (canonical JSON) to a rule the SA already
  // grants. Narrower rules than the SA's are refused too; the check is conservative, never widening (§8.2).
  const grantedRules = new Set(rulesOf(sa.scopeRules).map((rule) => canonicalize(rule)));
  rulesOf(request.scopeRules).forEach((rule, index) => {
    if (!grantedRules.has(canonicalize(rule)))
      fail('SCOPE_EXCEEDS_SA', `scopeRules.rules[${String(index)}]`);
  });

  if (!isWithinSaDefaults(request.budgets, sa.defaultBudgets)) fail('BUDGET_EXCEEDS_SA', 'budgets');

  return failures;
}
