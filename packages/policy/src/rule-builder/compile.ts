import { INTRUSIVENESS_CLASSES } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import { validatePolicies } from '../schema.js';
import {
  ATTRIBUTE_ROOTS,
  CONTEXT_ATTRS,
  ENTITY_ATTRS,
  RULE_BUILDER_ACTIONS,
  type ActionSpec,
  type AttrSpec,
  type ContextKind,
  type PrincipalType,
  type ResourceType,
} from './allowlist.js';
import {
  RULE_BUILDER_LIMITS,
  ruleBuilderPolicySchema,
  type BuilderRule,
  type Condition,
  type RuleBuilderPolicy,
} from './json.js';

/** How many issues the error message lists; the full set stays on `issues`. */
const SUMMARY_ISSUES = 5;
/** Control characters below U+0020 and DEL are escaped in Cedar strings. */
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const HEX_RADIX = 16;

/** A problem that stops compilation, located by an RFC 6901 JSON pointer into the builder document. */
export interface RuleBuilderIssue {
  readonly pointer: string;
  readonly message: string;
}

/** A non-fatal finding for the editor; warnings never block compilation. */
export type RuleBuilderWarning = RuleBuilderIssue;

/** The result of a successful compilation. */
export interface CompiledRuleBuilder {
  /** Canonical Cedar policy text (`''` for an empty rule set). Identical input gives identical bytes. */
  readonly cedarSource: string;
  readonly warnings: readonly RuleBuilderWarning[];
}

/**
 * Thrown for any builder document the compiler cannot express against POLICY-001 (`POLICY_BUILDER_INVALID`).
 * `issues` lists every problem with its JSON pointer, so the editor can point at the offending node.
 */
export class PolicyBuilderError extends AppError {
  declare readonly code: 'POLICY_BUILDER_INVALID';
  readonly issues: readonly RuleBuilderIssue[];

  constructor(issues: readonly RuleBuilderIssue[]) {
    const summary = issues
      .slice(0, SUMMARY_ISSUES)
      .map((i) => `${i.pointer || '/'}: ${i.message}`)
      .join('; ');
    super('POLICY_BUILDER_INVALID', `invalid rule-builder policy: ${summary}`);
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
  }
}

const ANNOTATION_SOURCE = 'rule-builder';

/** Compiles a rule-builder document to canonical Cedar text (CONTEXT_PACK §8.11, POLICY-005 baseline floor). */
export function compileRuleBuilder(json: unknown): CompiledRuleBuilder {
  const parsed = ruleBuilderPolicySchema.safeParse(json);
  if (!parsed.success) {
    throw new PolicyBuilderError(
      parsed.error.issues.map((i) => ({ pointer: pointerOf(i.path), message: i.message })),
    );
  }
  const policy: RuleBuilderPolicy = parsed.data;
  const analysis = analyse(policy);
  if (analysis.issues.length > 0) throw new PolicyBuilderError(analysis.issues);

  if (analysis.emitted.length === 0) return { cedarSource: '', warnings: analysis.warnings };
  const cedarSource = `${analysis.emitted.join('\n\n')}\n`;

  // Defence in depth: the emitter only produces allowlisted names, but the output must also pass
  // strict validation against the shipped schema before anyone can load it.
  const validation = validatePolicies(cedarSource);
  if (!validation.ok) {
    throw new PolicyBuilderError([
      {
        pointer: '/rules',
        message: `compiled Cedar failed schema validation: ${validation.errors[0] ?? 'unknown'}`,
      },
    ]);
  }
  return { cedarSource, warnings: analysis.warnings };
}

/* ------------------------------------------------------------------------------------------------ */
/* Semantic analysis: everything Zod cannot express (per-action attributes, value types, ranges).   */
/* ------------------------------------------------------------------------------------------------ */

interface Scope {
  readonly principal: PrincipalType | undefined;
  readonly resource: ResourceType | undefined;
  readonly context: ContextKind;
}

interface Analysis {
  readonly issues: RuleBuilderIssue[];
  readonly warnings: RuleBuilderWarning[];
  /** Cedar text per rule, in input order (empty when the document has no rules). */
  readonly emitted: string[];
}

function analyse(policy: RuleBuilderPolicy): Analysis {
  const issues: RuleBuilderIssue[] = [];
  const warnings: RuleBuilderWarning[] = [];
  const emitted: string[] = [];
  const ids = new Map<string, string>();
  const shapes = new Map<string, { effect: BuilderRule['effect']; pointer: string }>();

  policy.rules.forEach((rule, index) => {
    const at = `/rules/${index}`;
    const spec = RULE_BUILDER_ACTIONS[rule.action];
    const scope: Scope = {
      principal: rule.principal?.type ?? singleton(spec.principals),
      resource: rule.resource?.type ?? singleton(spec.resources),
      context: spec.context,
    };
    const ruleIssues: RuleBuilderIssue[] = checkScope(rule, spec, at);
    // Conditions are resolved against the scope, so they are only meaningful once the scope is valid.
    if (ruleIssues.length === 0) {
      (rule.conditions ?? []).forEach((c, ci) => {
        checkCondition(c, scope, `${at}/conditions/${ci}`, 1, ruleIssues, warnings);
      });
    }
    const explicitId = rule.annotations?.id;
    const id = explicitId ?? `rule-${index + 1}`;
    const previous = ids.get(id);
    if (previous !== undefined) {
      ruleIssues.push({
        pointer: explicitId === undefined ? at : `${at}/annotations/id`,
        message: `policy id is already used at ${previous}`,
      });
    }
    if (ruleIssues.length > 0) {
      issues.push(...ruleIssues);
      return;
    }
    ids.set(id, at);

    const shape = emitShape(rule, spec, scope);
    emitted.push(emitPolicy(rule, id, shape));

    const seen = shapes.get(shape);
    if (seen !== undefined) {
      warnings.push(
        seen.effect === rule.effect
          ? {
              pointer: at,
              message: `duplicates the rule at ${seen.pointer} and can never change a decision`,
            }
          : {
              pointer: at,
              message: `contradicts the rule at ${seen.pointer}: forbid overrides permit, so the permit has no effect`,
            },
      );
    } else {
      shapes.set(shape, { effect: rule.effect, pointer: at });
    }
  });

  if (issues.length === 0) addShadowWarnings(policy.rules, warnings);
  return { issues, warnings, emitted };
}

/** A permit is shadowed by an unconditional forbid over the same action and a covering scope. */
function addShadowWarnings(rules: readonly BuilderRule[], warnings: RuleBuilderWarning[]): void {
  rules.forEach((permit, pi) => {
    if (permit.effect !== 'permit') return;
    const forbidIndex = rules.findIndex(
      (f) =>
        f.effect === 'forbid' &&
        (f.conditions?.length ?? 0) === 0 &&
        f.action === permit.action &&
        (f.principal === undefined || f.principal.type === permit.principal?.type) &&
        (f.resource === undefined || f.resource.type === permit.resource?.type),
    );
    if (forbidIndex >= 0) {
      warnings.push({
        pointer: `/rules/${pi}`,
        message: `shadowed by the unconditional forbid at /rules/${forbidIndex}`,
      });
    }
  });
}

function singleton<T extends string>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function checkScope(rule: BuilderRule, spec: ActionSpec, at: string): RuleBuilderIssue[] {
  const issues: RuleBuilderIssue[] = [];
  if (
    rule.principal !== undefined &&
    !(spec.principals as readonly string[]).includes(rule.principal.type)
  ) {
    issues.push({
      pointer: `${at}/principal/type`,
      message: 'action does not accept this principal type',
    });
  }
  if (
    rule.resource !== undefined &&
    !(spec.resources as readonly string[]).includes(rule.resource.type)
  ) {
    issues.push({
      pointer: `${at}/resource/type`,
      message: 'action does not accept this resource type',
    });
  }
  return issues;
}

function checkCondition(
  c: Condition,
  scope: Scope,
  at: string,
  depth: number,
  issues: RuleBuilderIssue[],
  warnings: RuleBuilderWarning[],
): void {
  if ('of' in c) {
    if (depth > RULE_BUILDER_LIMITS.groupDepth) {
      issues.push({
        pointer: at,
        message: `groups may nest at most ${RULE_BUILDER_LIMITS.groupDepth} deep`,
      });
      return;
    }
    c.of.forEach((child, i) => {
      checkCondition(child, scope, `${at}/of/${i}`, depth + 1, issues, warnings);
    });
    return;
  }
  const resolved = resolve(c.attr, scope);
  if (!resolved.ok) {
    issues.push({ pointer: `${at}/attr`, message: resolved.message });
    return;
  }
  const { spec } = resolved;
  const typeIssue = (message: string): void => {
    issues.push({ pointer: at, message });
  };

  switch (c.op) {
    case '==': {
      if (spec.type === 'stringSet') {
        typeIssue('set attributes use the contains operator');
        return;
      }
      if (!fits(spec, c.value)) {
        typeIssue('value does not match the attribute type or range');
        return;
      }
      return;
    }
    case '<=':
    case '>=': {
      if (spec.type !== 'long') {
        typeIssue(`operator ${c.op} needs a numeric attribute`);
        return;
      }
      if (!fits(spec, c.value)) {
        typeIssue('value is outside the attribute range');
        return;
      }
      if (spec.range !== undefined && isAlwaysTrue(c.op, c.value, spec.range)) {
        warnings.push({ pointer: at, message: 'condition is always true for every request' });
      }
      return;
    }
    case 'in': {
      if (spec.type === 'stringSet' || spec.type === 'bool') {
        typeIssue('membership needs a scalar attribute (use contains for sets)');
        return;
      }
      c.value.forEach((v, i) => {
        if (!fits(spec, v))
          issues.push({
            pointer: `${at}/value/${i}`,
            message: 'value does not match the attribute type or range',
          });
      });
      if (new Set(c.value.map(String)).size !== c.value.length) {
        warnings.push({
          pointer: `${at}/value`,
          message: 'duplicate values in the list are ignored',
        });
      }
      return;
    }
    case 'contains': {
      if (spec.type !== 'stringSet') {
        typeIssue('contains needs a set attribute');
        return;
      }
      return;
    }
  }
}

/** Resolves an allowlisted attribute path for a scope; anything else is unknown. */
function resolve(
  attr: string,
  scope: Scope,
):
  | { readonly ok: true; readonly spec: AttrSpec }
  | { readonly ok: false; readonly message: string } {
  const dot = attr.indexOf('.');
  const root = dot < 0 ? attr : attr.slice(0, dot);
  const rest = attr.slice(dot + 1);
  if (dot < 0 || !(ATTRIBUTE_ROOTS as readonly string[]).includes(root)) {
    return { ok: false, message: 'unknown attribute' };
  }
  let table: Readonly<Record<string, AttrSpec>> | undefined;
  if (root === 'principal') {
    if (scope.principal === undefined)
      return { ok: false, message: 'set principal.type to use principal attributes' };
    table = ENTITY_ATTRS[scope.principal];
  } else if (root === 'resource') {
    if (scope.resource === undefined)
      return { ok: false, message: 'set resource.type to use resource attributes' };
    table = ENTITY_ATTRS[scope.resource];
  } else {
    table = CONTEXT_ATTRS[scope.context];
  }
  // Own-property lookup only: `constructor` or `__proto__` must not resolve.
  const spec = Object.hasOwn(table, rest) ? table[rest] : undefined;
  return spec === undefined
    ? { ok: false, message: 'unknown attribute for this action' }
    : { ok: true, spec };
}

/** True when a scalar literal is well-typed for the attribute (and inside its range). */
function fits(spec: AttrSpec, value: unknown): boolean {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'intrusivenessLevel':
      return (
        typeof value === 'string' && (INTRUSIVENESS_CLASSES as readonly string[]).includes(value)
      );
    case 'long':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        (spec.range === undefined || (value >= spec.range[0] && value <= spec.range[1]))
      );
    case 'stringSet':
      return false;
  }
}

function isAlwaysTrue(op: '<=' | '>=', value: number, range: readonly [number, number]): boolean {
  return op === '>=' ? value <= range[0] : value >= range[1];
}

/* ------------------------------------------------------------------------------------------------ */
/* Emission: canonical Cedar text built only from allowlisted names and escaped literals.           */
/* ------------------------------------------------------------------------------------------------ */

/** The policy body without annotations: scope and `when`. Equal shapes mean equal decisions. */
function emitShape(rule: BuilderRule, spec: ActionSpec, scope: Scope): string {
  const principal = rule.principal ? `principal is Blackwing::${rule.principal.type}` : 'principal';
  const resource = rule.resource ? `resource is Blackwing::${rule.resource.type}` : 'resource';
  const head = [`${principal},`, `action == ${spec.cedar},`, resource]
    .map((s) => `  ${s}`)
    .join('\n');
  const conditions = rule.conditions ?? [];
  const when =
    conditions.length === 0
      ? ''
      : `\nwhen {\n  ${conditions.map((c) => `(${emitCondition(c, scope)})`).join(' &&\n  ')}\n}`;
  return `(\n${head}\n)${when};`;
}

function emitPolicy(rule: BuilderRule, id: string, shape: string): string {
  const lines = [`@id(${cedarString(id)})`, `@source(${cedarString(ANNOTATION_SOURCE)})`];
  const description = rule.annotations?.description;
  if (description !== undefined) lines.push(`@description(${cedarString(description)})`);
  return `${lines.join('\n')}\n${rule.effect} ${shape}`;
}

function emitCondition(c: Condition, scope: Scope): string {
  if ('of' in c) {
    return c.of.map((child) => `(${emitCondition(child, scope)})`).join(` ${c.op} `);
  }
  const resolved = resolve(c.attr, scope);
  // Validated during analysis; an unresolved path cannot reach the emitter.
  const type = resolved.ok ? resolved.spec.type : 'string';
  const ref = c.attr;
  switch (c.op) {
    case '==':
      return `${ref} == ${literal(c.value, type)}`;
    case '<=':
    case '>=':
      return `${ref} ${c.op} ${String(c.value)}`;
    case 'in': {
      const unique = [...new Set(c.value.map((v) => literal(v, type)))];
      return `[${unique.join(', ')}].contains(${ref})`;
    }
    case 'contains':
      return `${ref}.contains(${cedarString(c.value)})`;
  }
}

function literal(value: string | number | boolean, type: AttrSpec['type']): string {
  if (type === 'intrusivenessLevel')
    return `Blackwing::IntrusivenessClass::${cedarString(String(value))}`;
  if (typeof value === 'string') return cedarString(value);
  return String(value);
}

/** Cedar string literal: quotes, backslashes and control characters escaped; all other text kept as is. */
function cedarString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < FIRST_PRINTABLE || code === DELETE) out += `\\u{${code.toString(HEX_RADIX)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** RFC 6901 JSON pointer of a Zod issue path. */
function pointerOf(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`)
    .join('');
}
