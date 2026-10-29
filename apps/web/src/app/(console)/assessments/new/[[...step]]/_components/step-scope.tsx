'use client';

import { useMemo, useState } from 'react';

import {
  type AssessmentRequestResponse,
  type AuthorisableIntrusiveness,
  authorisableIntrusivenessSchema,
  INTRUSIVENESS_DESCRIPTORS,
  type IntrusivenessClass,
  type RunBudgets,
  SCOPE_RULES_MAX,
  type ScopeRule,
  scopeRulesSchema,
  type StandingAuthorisationDto,
} from '@blackwing/contracts';
import { Button, Input, Label } from '@blackwing/ui';

import {
  buildScopeRule,
  budgetPrefill,
  canAddRule,
  checkBudgets,
  coveringStandingAuthorisations,
  describeDecision,
  describeRule,
  intrusivenessOptions,
  needsReversalNotice,
  parseTargetInput,
  previewScope,
  type RuleDraft,
  type RunBudgetDraft,
  rulesNotGrantedBy,
} from '../scope-model';

/** What the scope step saves, in the shape the draft PATCH accepts. */
export interface ScopeAnswer {
  readonly saId: string;
  readonly scopeRules: ScopeRule[];
  readonly maxIntrusiveness: AuthorisableIntrusiveness;
  readonly budgets: RunBudgetDraft;
}

export interface StepScopeProps {
  /** The draft the scope is saved to. Its assets bound which standing authorisations may be chosen. */
  readonly draft: AssessmentRequestResponse;
  /** The SA list, or undefined while loading or when it could not be read. */
  readonly standingAuthorisations: readonly StandingAuthorisationDto[] | undefined;
  readonly loading: boolean;
  readonly pending: boolean;
  /** True when the last save was accepted, so the step confirms it. */
  readonly saved: boolean;
  readonly onSubmit: (answer: ScopeAnswer) => Promise<void>;
}

const EMPTY_RULE: RuleDraft = { effect: 'include', target: '', ports: '', paths: '', methods: '' };

const BUDGET_FIELDS = [
  { key: 'maxRequests', label: 'Maximum requests for the run' },
  { key: 'costCapUsd', label: 'Cost cap (USD)' },
  { key: 'maxDurationMs', label: 'Maximum duration (ms)' },
] as const satisfies readonly { key: keyof RunBudgets; label: string }[];

/** The run budget the inputs hold: each field is set only when its input is not empty. */
function budgetFromText(text: Readonly<Record<string, string>>): RunBudgetDraft {
  const budget: RunBudgetDraft = {};
  for (const field of BUDGET_FIELDS) {
    const value = fromText(text[field.key] ?? '');
    if (value !== undefined) budget[field.key] = value;
  }
  return budget;
}

/** Text of a budget input: empty when unset. */
function toText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** The number a budget input holds, or undefined when it is empty. A non-number stays NaN so the schema refuses it. */
function fromText(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text);
}

/**
 * Step 4: the scope. The standing authorisation (SA) is chosen first; the rules, intrusiveness and budgets are then
 * bounded by it. Every bound is checked again by the server at submit (SCOPE_EXCEEDS_SA, INTRUSIVENESS_EXCEEDS_SA,
 * BUDGET_EXCEEDS_SA), so this step only shows the problem early.
 */
export function StepScope({
  draft,
  standingAuthorisations,
  loading,
  pending,
  saved,
  onSubmit,
}: StepScopeProps) {
  const now = useMemo(() => new Date(), []);
  const covering = useMemo(
    () =>
      standingAuthorisations === undefined
        ? undefined
        : coveringStandingAuthorisations(standingAuthorisations, draft.assetIds, now),
    [standingAuthorisations, draft.assetIds, now],
  );
  const [saId, setSaId] = useState<string | null>(draft.saId);
  const [rules, setRules] = useState<ScopeRule[]>(() => initialRules(draft.scopeRules));
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [intrusiveness, setIntrusiveness] = useState<IntrusivenessClass>(draft.maxIntrusiveness);
  const [budgetText, setBudgetText] = useState<Record<string, string>>(() =>
    Object.fromEntries(BUDGET_FIELDS.map((field) => [field.key, toText(draft.budgets[field.key])])),
  );
  const [formError, setFormError] = useState<string | null>(null);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading the standing authorisations...</p>;
  }
  if (covering === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        The standing authorisations are not available right now.
      </p>
    );
  }
  if (covering.length === 0) {
    return (
      <section role="alert" className="grid gap-2 rounded-md border border-destructive p-4">
        <h2 className="text-lg font-semibold">No standing authorisation covers these assets</h2>
        <p className="text-sm">
          An active standing authorisation must cover every selected asset before the scope can be
          set. Ask an administrator to create and approve one, then come back to this draft.
        </p>
      </section>
    );
  }

  const sa = covering.find((candidate) => candidate.id === saId);
  const saStale = saId !== null && sa === undefined;
  const preview = parseTargetInput(target);
  const decision = preview.ok && sa !== undefined ? previewScope(rules, preview.target) : null;
  const notGranted = sa === undefined ? [] : rulesNotGrantedBy(rules, sa);
  const options = sa === undefined ? [] : intrusivenessOptions(sa);
  const budgetInputs = budgetFromText(budgetText);

  const addRule = () => {
    const built = buildScopeRule(ruleDraft);
    if (!built.ok) {
      setRuleError(built.message);
      return;
    }
    setRules([...rules, built.rule]);
    setRuleDraft({ ...EMPTY_RULE, effect: ruleDraft.effect });
    setRuleError(null);
  };

  const submit = () => {
    setFormError(null);
    if (sa === undefined) {
      setFormError('Choose a standing authorisation.');
      return;
    }
    if (rules.length === 0 || !rules.some((rule) => rule.effect === 'include')) {
      setFormError('Add at least one include rule before saving the scope.');
      return;
    }
    const option = options.find((candidate) => candidate.value === intrusiveness);
    if (option?.allowed !== true) {
      setFormError('Choose an intrusiveness level within the standing authorisation.');
      return;
    }
    const maxIntrusiveness = authorisableIntrusivenessSchema.safeParse(intrusiveness);
    if (!maxIntrusiveness.success) {
      setFormError('Choose an intrusiveness level within the standing authorisation.');
      return;
    }
    const budget = checkBudgets(budgetInputs, sa);
    if (!budget.ok) {
      setFormError(budget.message);
      return;
    }
    void onSubmit({
      saId: sa.id,
      scopeRules: rules,
      maxIntrusiveness: maxIntrusiveness.data,
      budgets: budget.budgets,
    });
  };

  return (
    <form
      noValidate
      aria-labelledby="step-scope-title"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="grid gap-6"
    >
      <h2 id="step-scope-title" className="text-lg font-semibold">
        Set the scope and authorisation
      </h2>

      {saStale ? (
        <p role="alert" className="text-sm text-destructive">
          The standing authorisation you chose is no longer active or no longer covers these assets.
          Choose another one.
        </p>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Standing authorisation</legend>
        {covering.map((candidate) => (
          <label
            key={candidate.id}
            className={`grid cursor-pointer gap-1 rounded-md border p-3 ${
              saId === candidate.id ? 'border-primary ring-2 ring-primary' : 'border-input'
            }`}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="standing-authorisation"
                value={candidate.id}
                checked={saId === candidate.id}
                disabled={pending}
                onChange={() => {
                  setSaId(candidate.id);
                }}
              />
              <span className="font-mono text-sm">{candidate.id}</span>
            </span>
            <span className="text-sm text-muted-foreground">
              Ceiling: {INTRUSIVENESS_DESCRIPTORS[candidate.maxIntrusiveness].label}. Valid until{' '}
              {new Date(candidate.expiresAt).toLocaleDateString()}.{' '}
              {candidate.scopeRules.rules.length} scope rule(s).
            </span>
          </label>
        ))}
      </fieldset>

      {sa === undefined ? (
        <p className="text-sm text-muted-foreground">
          Choose a standing authorisation to continue.
        </p>
      ) : (
        <>
          <section aria-labelledby="scope-rules-title" className="grid gap-3">
            <h3 id="scope-rules-title" className="font-medium">
              Scope rules
            </h3>
            <p className="text-sm text-muted-foreground">
              Rules are checked in order. Default deny: a target is in scope only when an include
              rule matches and no exclude rule wins. {rules.length} of {String(SCOPE_RULES_MAX)}{' '}
              rules.
            </p>
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rules yet.</p>
            ) : (
              <ol className="grid gap-2">
                {rules.map((rule, index) => (
                  <li
                    key={`${String(index)}-${canonicalKey(rule)}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-input p-2 text-sm"
                  >
                    <span>
                      <span className="font-medium">Rule {index + 1}.</span> {describeRule(rule)}
                      {notGranted.includes(index) ? (
                        <span className="ml-2 text-destructive">
                          Not covered by this standing authorisation. Submit will be rejected.
                        </span>
                      ) : null}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label={`Remove rule ${String(index + 1)}`}
                      onClick={() => {
                        setRules(rules.filter((_, position) => position !== index));
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ol>
            )}

            <div className="grid gap-3 rounded-md border border-input p-3 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="rule-effect">Effect</Label>
                <select
                  id="rule-effect"
                  className="rounded-md border border-input bg-background p-2 text-sm"
                  value={ruleDraft.effect}
                  disabled={pending}
                  onChange={(event) => {
                    setRuleDraft({
                      ...ruleDraft,
                      effect: event.target.value === 'exclude' ? 'exclude' : 'include',
                    });
                  }}
                >
                  <option value="include">Include</option>
                  <option value="exclude">Exclude</option>
                </select>
              </div>
              <RuleField
                id="rule-target"
                label="Host or CIDR"
                placeholder="app.example.test or 10.0.0.0/24"
                value={ruleDraft.target}
                disabled={pending}
                onChange={(value) => {
                  setRuleDraft({ ...ruleDraft, target: value });
                }}
              />
              <RuleField
                id="rule-ports"
                label="Ports (optional)"
                placeholder="443, 8000-8100"
                value={ruleDraft.ports}
                disabled={pending}
                onChange={(value) => {
                  setRuleDraft({ ...ruleDraft, ports: value });
                }}
              />
              <RuleField
                id="rule-paths"
                label="Paths (optional)"
                placeholder="/api/*"
                value={ruleDraft.paths}
                disabled={pending}
                onChange={(value) => {
                  setRuleDraft({ ...ruleDraft, paths: value });
                }}
              />
              <RuleField
                id="rule-methods"
                label="Methods (optional)"
                placeholder="GET, POST"
                value={ruleDraft.methods}
                disabled={pending}
                onChange={(value) => {
                  setRuleDraft({ ...ruleDraft, methods: value });
                }}
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !canAddRule(rules.length)}
                  onClick={addRule}
                >
                  Add rule
                </Button>
              </div>
            </div>
            {ruleError === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {ruleError}
              </p>
            )}

            <div className="grid gap-2 rounded-md border border-input p-3">
              <Label htmlFor="scope-target">Test a target</Label>
              <Input
                id="scope-target"
                placeholder="https://app.example.test/login"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              />
              <p role="status" aria-live="polite" className="text-sm">
                {target.trim() === ''
                  ? 'Type a host, IP address or URL to see whether the rules put it in scope.'
                  : preview.ok && decision !== null
                    ? describeDecision(decision)
                    : preview.ok
                      ? 'Choose a standing authorisation to test against its rules.'
                      : preview.message}
              </p>
            </div>
          </section>

          <fieldset className="grid gap-2">
            <legend className="font-medium">Intrusiveness ceiling</legend>
            {options.map((option) => (
              <label
                key={option.value}
                className={`grid gap-1 rounded-md border p-3 ${
                  option.allowed ? 'cursor-pointer border-input' : 'border-input opacity-60'
                }`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="intrusiveness"
                    value={option.value}
                    checked={intrusiveness === option.value}
                    disabled={pending || !option.allowed}
                    aria-describedby={`intrusiveness-${option.value}-desc`}
                    onChange={() => {
                      setIntrusiveness(option.value);
                      setBudgetText(
                        Object.fromEntries(
                          BUDGET_FIELDS.map((field) => [
                            field.key,
                            toText(budgetPrefill(option.value, sa)[field.key]),
                          ]),
                        ),
                      );
                    }}
                  />
                  {option.label}
                </span>
                <span
                  id={`intrusiveness-${option.value}-desc`}
                  className="text-sm text-muted-foreground"
                >
                  {option.meaning}
                  {option.disabledReason === null ? '' : ` ${option.disabledReason}`}
                </span>
              </label>
            ))}
            {needsReversalNotice(intrusiveness) ? (
              <p role="status" className="text-sm">
                State-changing tests write a reversal-journal entry before they run, and Gate 1 must
                approve them before any action executes.
              </p>
            ) : null}
          </fieldset>

          <section aria-labelledby="budgets-title" className="grid gap-3">
            <h3 id="budgets-title" className="font-medium">
              Budgets
            </h3>
            <p className="text-sm text-muted-foreground">
              Pre-filled from the {INTRUSIVENESS_DESCRIPTORS[intrusiveness].label.toLowerCase()}{' '}
              class and capped by this standing authorisation. Values above its defaults are
              refused.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {BUDGET_FIELDS.map((field) => {
                const bound = sa.defaultBudgets[field.key];
                return (
                  <div key={field.key} className="grid gap-1.5">
                    <Label htmlFor={`budget-${field.key}`}>{field.label}</Label>
                    <Input
                      id={`budget-${field.key}`}
                      inputMode="decimal"
                      disabled={pending}
                      value={budgetText[field.key] ?? ''}
                      aria-describedby={`budget-${field.key}-bound`}
                      onChange={(event) => {
                        setBudgetText({ ...budgetText, [field.key]: event.target.value });
                      }}
                    />
                    <span
                      id={`budget-${field.key}-bound`}
                      className="text-xs text-muted-foreground"
                    >
                      Standing authorisation limit: {String(bound)}.
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {formError === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {saved ? (
              <p role="status" className="text-sm text-muted-foreground">
                Scope saved. Submitting the request comes next.
              </p>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving...' : 'Save scope'}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function canonicalKey(rule: ScopeRule): string {
  return JSON.stringify(rule);
}

/** The draft's stored rules, read back through the scope schema. Anything the schema refuses is shown as none. */
function initialRules(stored: Record<string, unknown>): ScopeRule[] {
  const parsed = scopeRulesSchema.safeParse(stored);
  return parsed.success ? parsed.data.rules : [];
}

interface RuleFieldProps {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}

function RuleField({ id, label, placeholder, value, disabled, onChange }: RuleFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}
