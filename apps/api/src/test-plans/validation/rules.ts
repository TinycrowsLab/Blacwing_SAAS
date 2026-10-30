import { z } from 'zod';

import {
  INTRUSIVENESS_ORDER,
  type IntrusivenessClass,
  parseIp,
  parseScopeRules,
  type PlanBudgetTotals,
  type PlanViolation,
  type PlanViolationCode,
  type ScopeRules,
  type ScopeTarget,
} from '@blackwing/contracts';
import { matchScope } from '@blackwing/domain';

/**
 * Deterministic checks of a test plan version against its standing authorisation (PLAN-006, §8.1, §8.3, §8.6,
 * §8.11). Pure functions over plain facts: the service loads the facts in one snapshot, these decide, and the Cedar
 * PDP (`policy.ts`) adds its own verdict on top. Every check fails closed: a value that does not parse, a target
 * that is not an http(s) URL and a rule set that does not parse all count against the plan.
 */

/** The standing authorisation fields the checks read. */
export interface SaFacts {
  readonly status: string;
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly scopeRules: unknown;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: Readonly<Record<string, number>>;
}

/** One non-removed test case as the checks read it. */
export interface CaseFacts {
  readonly id: string;
  readonly class: IntrusivenessClass;
  readonly targets: readonly unknown[];
  readonly roles: readonly string[];
  readonly budget: unknown;
  readonly oracle: unknown;
  readonly negativeControl: unknown;
}

/** The whole plan version the checks run over. `knownRoles` is null when no role is known (fail closed). */
export interface PlanFacts {
  readonly cases: readonly CaseFacts[];
  readonly sa: SaFacts;
  readonly knownRoles: readonly string[] | null;
  readonly runBudgets: { readonly maxRequests: number };
}

const HTTPS_PORT = 443;
const HTTP_PORT = 80;

/** The stored request budget of a case; a value that does not match is a budget violation. */
const caseBudgetSchema = z.looseObject({
  maxRequests: z.number().int().min(0),
  maxBytes: z.number().int().min(0),
});

/** Messages are fixed text. A message never echoes a target, a title or any other input value. */
const MESSAGES: Readonly<Record<PlanViolationCode, string>> = {
  PLAN_SA_MISSING: 'the run has no standing authorisation to validate against',
  PLAN_SA_NOT_ACTIVE: 'the standing authorisation is not active at validation time',
  PLAN_CLASS_DESTRUCTIVE_BLOCKED: 'the destructive class is never allowed',
  PLAN_CLASS_EXCEEDS_SA: 'the test case class exceeds the standing authorisation maximum',
  PLAN_STATE_CHANGING_NOT_AUTHORISED:
    'a state-changing test case needs the standing authorisation to pre-approve the class',
  PLAN_TARGET_OUT_OF_SCOPE: 'a target is not in scope of the standing authorisation',
  PLAN_ROLE_UNKNOWN: 'a role is not in the asset role matrix',
  PLAN_ORACLE_MISSING: 'the test case declares no oracle',
  PLAN_NEGATIVE_CONTROL_MISSING: 'the test case declares no negative control',
  PLAN_BUDGET_EXCEEDED: 'a budget exceeds the standing authorisation or the run budget',
  PLAN_POLICY_DENIED: 'the policy engine denied the plan',
  PLAN_POLICY_EVAL_FAILED: 'the policy engine could not evaluate the plan',
};

/** A violation with its fixed message. `caseId` is null for a plan-level finding. */
export function violation(
  code: PlanViolationCode,
  caseId: string | null,
  policyId: string | null = null,
): PlanViolation {
  return { code, caseId, policyId, message: MESSAGES[code] };
}

/** True when the SA is `active` and `now` lies in its validity window: `validFrom` inclusive, `expiresAt` exclusive. */
export function saIsActive(sa: SaFacts, now: Date): boolean {
  return (
    sa.status === 'active' &&
    sa.validFrom.getTime() <= now.getTime() &&
    now.getTime() < sa.expiresAt.getTime()
  );
}

/**
 * The scope target of a planned target URL. Only http(s) URLs with a host are targets; anything else is `undefined`
 * (and so out of scope). An IP literal becomes `ip`, a name becomes `host`. Port defaults follow the scheme.
 */
export function parseTarget(raw: unknown): ScopeTarget | undefined {
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (hostname === '') return undefined;
  const port =
    url.port === '' ? (url.protocol === 'https:' ? HTTPS_PORT : HTTP_PORT) : Number(url.port);
  const address = parseIp(hostname) === null ? { host: hostname } : { ip: hostname };
  return { ...address, port, path: url.pathname };
}

/** The SA's scope rules when they parse; `undefined` otherwise, so every target is then out of scope. */
export function scopeRulesOf(raw: unknown): ScopeRules | undefined {
  try {
    return parseScopeRules(raw);
  } catch {
    return undefined;
  }
}

/** Whether `raw` (a planned target URL) is in scope of `rules`. Anything unparseable is out of scope. */
export function targetInScope(raw: unknown, rules: ScopeRules | undefined): boolean {
  const target = parseTarget(raw);
  if (target === undefined || rules === undefined) return false;
  return matchScope(target, rules).inScope;
}

/** The request and byte caps of a stored case budget, or `undefined` when it does not parse. */
export function budgetOf(raw: unknown): { maxRequests: number; maxBytes: number } | undefined {
  const parsed = caseBudgetSchema.safeParse(raw);
  return parsed.success
    ? { maxRequests: parsed.data.maxRequests, maxBytes: parsed.data.maxBytes }
    : undefined;
}

/**
 * Totals over the non-removed cases: the request and byte caps summed, and the case count per class. A case whose
 * budget does not parse adds nothing here; its own budget violation already fails the plan.
 */
export function budgetTotals(cases: readonly CaseFacts[]): PlanBudgetTotals {
  const perClassCounts = { passive: 0, active_safe: 0, state_changing: 0, destructive: 0 };
  let totalRequests = 0;
  let totalBytes = 0;
  for (const testCase of cases) {
    perClassCounts[testCase.class] += 1;
    const budget = budgetOf(testCase.budget);
    if (budget !== undefined) {
      totalRequests += budget.maxRequests;
      totalBytes += budget.maxBytes;
    }
  }
  return { totalRequests, totalBytes, perClassCounts };
}

/** Violations of one case against the SA. Destructive is refused outright, before any other check (§8.3). */
function caseViolations(testCase: CaseFacts, facts: PlanFacts, rules: ScopeRules | undefined) {
  const found: PlanViolation[] = [];
  const caseId = testCase.id;
  if (testCase.class === 'destructive') {
    found.push(violation('PLAN_CLASS_DESTRUCTIVE_BLOCKED', caseId));
    return found;
  }
  if (INTRUSIVENESS_ORDER[testCase.class] > INTRUSIVENESS_ORDER[facts.sa.maxIntrusiveness]) {
    found.push(violation('PLAN_CLASS_EXCEEDS_SA', caseId));
  }
  if (
    testCase.class === 'state_changing' &&
    !facts.sa.preApprovedTestClasses.includes('state_changing')
  ) {
    found.push(violation('PLAN_STATE_CHANGING_NOT_AUTHORISED', caseId));
  }
  const targetsInScope =
    testCase.targets.length > 0 && testCase.targets.every((t) => targetInScope(t, rules));
  if (!targetsInScope) found.push(violation('PLAN_TARGET_OUT_OF_SCOPE', caseId));

  const known = facts.knownRoles;
  const unknownRole = known === null || testCase.roles.some((role) => !known.includes(role));
  if (unknownRole) found.push(violation('PLAN_ROLE_UNKNOWN', caseId));

  if (testCase.oracle === null) found.push(violation('PLAN_ORACLE_MISSING', caseId));
  if (testCase.class !== 'passive' && testCase.negativeControl === null) {
    found.push(violation('PLAN_NEGATIVE_CONTROL_MISSING', caseId));
  }

  const budget = budgetOf(testCase.budget);
  const ceilings = facts.sa.defaultBudgets;
  const overSa =
    budget === undefined ||
    (ceilings.maxRequests !== undefined && budget.maxRequests > ceilings.maxRequests) ||
    (ceilings.maxBytes !== undefined && budget.maxBytes > ceilings.maxBytes);
  if (overSa) found.push(violation('PLAN_BUDGET_EXCEEDED', caseId));
  return found;
}

/**
 * Every violation of the plan version against its SA, the run budget and the role matrix. Callers handle a
 * missing or inactive SA before this point (see `validatePlanFacts`). Duplicates of one code on one case collapse.
 */
export function planViolations(facts: PlanFacts, totals: PlanBudgetTotals): PlanViolation[] {
  const rules = scopeRulesOf(facts.sa.scopeRules);
  const all = facts.cases.flatMap((testCase) => caseViolations(testCase, facts, rules));
  if (totals.totalRequests > facts.runBudgets.maxRequests) {
    all.push(violation('PLAN_BUDGET_EXCEEDED', null));
  }
  const seen = new Set<string>();
  return all.filter((v) => {
    const key = `${v.code}:${v.caseId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether a human Gate 1 decision is still needed: at least one case class is not pre-approved by the SA. With no
 * pre-approved classes at all, nothing passes automatically (§8.3). Auto-approval itself is PLAN-010.
 */
export function gate1Required(facts: PlanFacts): boolean {
  return facts.cases.some((c) => !facts.sa.preApprovedTestClasses.includes(c.class));
}
