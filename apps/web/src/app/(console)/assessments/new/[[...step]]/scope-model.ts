// Scope step model (SCOPE-005 wizard, step 4). Pure: no React, no I/O. It reuses the contracts (SCOPE-002 rule model,
// SCOPE-003 intrusiveness order, SCOPE-004 budgets) and the domain matcher, so the preview and the bounds the user sees
// are the ones the server applies. The server stays authoritative: submit re-checks every bound (§8.11, UI is not a
// safety control).

import {
  defaultBudgetForClass,
  INTRUSIVENESS_DESCRIPTORS,
  type IntrusivenessClass,
  isWithinCeiling,
  isWithinSaDefaults,
  normaliseHost,
  parseIp,
  runBudgetSchema,
  type RunBudgets,
  SCOPE_RULES_MAX,
  SELECTABLE_INTRUSIVENESS_CLASSES,
  type ScopeRule,
  type ScopeDecision,
  scopeRuleSchema,
  type ScopeTarget,
  scopeTargetSchema,
  type StandingAuthorisationDto,
} from '@blackwing/contracts';
import { matchScope } from '@blackwing/domain';

/** The run budget the step edits: the fields the draft (and the SA `default_budgets`) carry. */
export type RunBudgetDraft = Partial<RunBudgets>;

/** Whether an SA is usable now: active, inside its validity window. Mirrors the server submit gate. */
function isSaUsable(sa: StandingAuthorisationDto, now: Date): boolean {
  return (
    sa.status === 'active' &&
    Date.parse(sa.validFrom) <= now.getTime() &&
    Date.parse(sa.expiresAt) > now.getTime()
  );
}

/**
 * The SAs the user may pick for these assets: usable now and covering every selected asset. An empty asset list has
 * no covering SA, so the step blocks until an asset is chosen.
 */
export function coveringStandingAuthorisations(
  sas: readonly StandingAuthorisationDto[],
  assetIds: readonly string[],
  now: Date,
): StandingAuthorisationDto[] {
  if (assetIds.length === 0) return [];
  return sas.filter(
    (sa) => isSaUsable(sa, now) && assetIds.every((id) => sa.assetIds.includes(id)),
  );
}

/**
 * Stable JSON with object keys sorted, so two equal rules compare equal whatever order their keys were written in.
 * Matches the server's exact-match subset check (`canonicalize`), which the SA coverage check uses.
 */
export function canonicalRule(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/**
 * Indexes of the request's rules that the SA does not grant. The server requires each rule to equal an SA rule
 * exactly (`SCOPE_EXCEEDS_SA`), so a rule that is narrower or wider than the SA's is flagged here too.
 */
export function rulesNotGrantedBy(
  rules: readonly ScopeRule[],
  sa: StandingAuthorisationDto,
): number[] {
  const granted = new Set(sa.scopeRules.rules.map((rule) => canonicalRule(rule)));
  return rules.flatMap((rule, index) => (granted.has(canonicalRule(rule)) ? [] : [index]));
}

/** One selectable intrusiveness class with whether the SA allows it. Destructive is never an option. */
export interface IntrusivenessOption {
  readonly value: IntrusivenessClass;
  readonly label: string;
  readonly meaning: string;
  readonly allowed: boolean;
  /** Why the option is disabled; null when it is allowed. */
  readonly disabledReason: string | null;
}

/** The picker's options, least intrusive first. Only selectable classes appear (§8.3). */
export function intrusivenessOptions(sa: StandingAuthorisationDto): IntrusivenessOption[] {
  return SELECTABLE_INTRUSIVENESS_CLASSES.map((value) => {
    const allowed = isWithinCeiling(value, sa.maxIntrusiveness);
    return {
      value,
      label: INTRUSIVENESS_DESCRIPTORS[value].label,
      meaning: INTRUSIVENESS_DESCRIPTORS[value].meaning,
      allowed,
      disabledReason: allowed
        ? null
        : `Above this standing authorisation's ceiling (${INTRUSIVENESS_DESCRIPTORS[sa.maxIntrusiveness].label}).`,
    };
  });
}

/** Whether the chosen class needs the reversal journal and Gate 1 (§3.5, §8.3). */
export function needsReversalNotice(value: IntrusivenessClass): boolean {
  return value === 'state_changing';
}

/**
 * Prefill for the run budget: the class's request-count default, clamped down to the SA's bound. The cost cap and
 * wall-clock cap come from the SA when it sets them, and are left empty otherwise so the user states them.
 */
export function budgetPrefill(
  value: IntrusivenessClass,
  sa: StandingAuthorisationDto,
): RunBudgetDraft {
  const classRequests = defaultBudgetForClass(value).maxRequests;
  const bounds = sa.defaultBudgets;
  return {
    maxRequests: Math.min(classRequests, bounds.maxRequests),
    costCapUsd: bounds.costCapUsd,
    maxDurationMs: bounds.maxDurationMs,
  };
}

/** Result of checking a budget against the schema and the SA bounds. Messages name fields, never values. */
export type BudgetCheck =
  | { readonly ok: true; readonly budgets: RunBudgetDraft }
  | { readonly ok: false; readonly message: string };

/**
 * Checks the budget inputs against the run-budget schema (SCOPE-004), then against the SA `default_budgets` (SCOPE-005).
 * Empty inputs are dropped: the server keeps the stored value for an absent field.
 */
export function checkBudgets(input: RunBudgetDraft, sa: StandingAuthorisationDto): BudgetCheck {
  const present = definedOnly(input);
  const parsed = runBudgetSchema.partial().safeParse(present);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    return {
      ok: false,
      message: `Check ${fields.join(', ')}: each budget must be a positive whole number or amount.`,
    };
  }
  const budgets = definedOnly(parsed.data);
  if (!isWithinSaDefaults(budgets, sa.defaultBudgets)) {
    return {
      ok: false,
      message: 'A budget is above the standing authorisation default. Lower it to save.',
    };
  }
  return { ok: true, budgets };
}

/** The keys whose value is set. Zod's optional output carries `undefined`; the budget types do not allow it. */
function definedOnly(
  input: Readonly<Partial<Record<keyof RunBudgets, number | undefined>>>,
): RunBudgetDraft {
  const out: RunBudgetDraft = {};
  for (const key of Object.keys(input) as (keyof RunBudgets)[]) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The preview: the server's matcher run on one target against the rules being authored (SCOPE-002). */
export function previewScope(rules: readonly ScopeRule[], target: ScopeTarget): ScopeDecision {
  return matchScope(target, { rules: [...rules] });
}

/**
 * Reads a target typed by the user: a host, an IP, or a URL (`host:port`, `https://host/path`). A bare host gets
 * `https` defaults. Hostnames are normalised the way the server does (IDNA, lowercase), so the preview agrees with
 * the matcher. Anything that is not a valid target is refused with a reason.
 */
export function parseTargetInput(
  text: string,
):
  | { readonly ok: true; readonly target: ScopeTarget }
  | { readonly ok: false; readonly message: string } {
  const raw = text.trim();
  if (raw === '') return { ok: false, message: 'Enter a host, an IP address or a URL to test.' };
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { ok: false, message: 'That is not a valid host, IP address or URL.' };
  }
  const hostname = url.hostname;
  const defaultPort = url.protocol === 'http:' ? HTTP_PORT : HTTPS_PORT;
  const common = {
    port: url.port === '' ? defaultPort : Number(url.port),
    path: url.pathname === '' ? '/' : url.pathname,
    method: 'GET',
  };
  const isIp = parseIp(hostname) !== null;
  const host = isIp ? null : normaliseHost(hostname);
  if (!isIp && host === null) {
    return { ok: false, message: 'That is not a valid host, IP address or URL.' };
  }
  const checked = scopeTargetSchema.safeParse(
    isIp ? { ip: hostname, ...common } : { host, ...common },
  );
  if (!checked.success) {
    return { ok: false, message: 'That is not a valid host, IP address or URL.' };
  }
  return { ok: true, target: checked.data };
}

const HTTP_PORT = 80;
const HTTPS_PORT = 443;

/** The raw text of one rule row, as the user typed it. Lists are comma-separated; a port range is `from-to`. */
export interface RuleDraft {
  readonly effect: 'include' | 'exclude';
  readonly target: string;
  readonly ports: string;
  readonly paths: string;
  readonly methods: string;
}

/** Splits a comma list into trimmed, non-empty items. */
function listOf(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** A port item: a number, or `from-to` for a range. Anything else stays a string so the schema refuses it. */
function portItem(part: string): number | { from: number; to: number } | string {
  const range = /^(\d+)-(\d+)$/.exec(part);
  if (range !== null) return { from: Number(range[1]), to: Number(range[2]) };
  return /^\d+$/.test(part) ? Number(part) : part;
}

/**
 * Builds one scope rule from the row text, validated by the SCOPE-002 schema. A target with a slash is a CIDR,
 * otherwise a host. Returns the first refusal in plain words.
 */
export function buildScopeRule(
  draft: RuleDraft,
):
  | { readonly ok: true; readonly rule: ScopeRule }
  | { readonly ok: false; readonly message: string } {
  const target = draft.target.trim();
  const ports = listOf(draft.ports).map((part) => portItem(part));
  const paths = listOf(draft.paths);
  const methods = listOf(draft.methods);
  const candidate = {
    effect: draft.effect,
    ...(target.includes('/') ? { cidr: target } : target === '' ? {} : { host: target }),
    ...(ports.length > 0 ? { ports } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(methods.length > 0 ? { methods } : {}),
  };
  const parsed = scopeRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        draft.effect === 'include' && target === ''
          ? 'An include rule needs a host or a CIDR.'
          : 'This rule is not valid. Check the host or CIDR, ports, paths and methods.',
    };
  }
  return { ok: true, rule: parsed.data };
}

/** Whether another rule may be added (the schema caps the set). */
export function canAddRule(count: number): boolean {
  return count < SCOPE_RULES_MAX;
}

/** One line that says what a rule covers, for the rule list. Read-only text; never sent anywhere. */
export function describeRule(rule: ScopeRule): string {
  const parts: string[] = [];
  parts.push(rule.host ?? rule.cidr ?? 'any host');
  if (rule.ports !== undefined) {
    parts.push(
      `ports ${rule.ports.map((p) => (typeof p === 'number' ? String(p) : `${String(p.from)}-${String(p.to)}`)).join(', ')}`,
    );
  }
  if (rule.paths !== undefined) parts.push(`paths ${rule.paths.join(', ')}`);
  if (rule.methods !== undefined) parts.push(`methods ${rule.methods.join(', ')}`);
  return `${rule.effect === 'include' ? 'Include' : 'Exclude'} ${parts.join('; ')}`;
}

/** Plain-words result of a preview decision, naming the matched rule by its position (1-based). */
export function describeDecision(decision: ScopeDecision): string {
  if (decision.inScope && decision.matchedRuleIndex !== undefined) {
    return `In scope: matched rule ${String(decision.matchedRuleIndex + 1)}.`;
  }
  if (decision.matchedRuleIndex !== undefined) {
    return `Out of scope: excluded by rule ${String(decision.matchedRuleIndex + 1)}.`;
  }
  return 'Out of scope: no include rule matches this target (default deny).';
}
