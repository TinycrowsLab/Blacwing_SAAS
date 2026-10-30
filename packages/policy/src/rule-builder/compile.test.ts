import { readFileSync } from 'node:fs';

import { policySetTextToParts } from '@cedar-policy/cedar-wasm/nodejs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { INTRUSIVENESS_CLASSES } from '@blackwing/contracts';

import { validatePolicies } from '../schema.js';
import {
  ACTION_KEYS,
  CONTEXT_ATTRS,
  ENTITY_ATTRS,
  RULE_BUILDER_ACTIONS,
  type AttrSpec,
  type PrincipalType,
  type ResourceType,
} from './allowlist.js';
import { compileRuleBuilder, PolicyBuilderError } from './compile.js';

import type { Condition } from './json.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const representative: unknown = JSON.parse(fixture('representative.json'));

/** A minimal, valid single-rule document; tests override one field at a time. */
function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect: 'permit',
    action: 'egress.httpRequest',
    principal: { type: 'AgentSession' },
    resource: { type: 'Target' },
    conditions: [{ op: '==', attr: 'resource.host', value: 'api.example.test' }],
    ...overrides,
  };
}

/** Runs `compileRuleBuilder` and returns the thrown builder error (fails the test otherwise). */
function errorOf(json: unknown): PolicyBuilderError {
  try {
    compileRuleBuilder(json);
  } catch (err) {
    if (err instanceof PolicyBuilderError) return err;
    throw err;
  }
  throw new Error('expected compileRuleBuilder to throw');
}

/** Every allowlisted attribute visible to a scope, as the builder path and its spec. */
function attributesFor(
  action: keyof typeof RULE_BUILDER_ACTIONS,
  principal: PrincipalType,
  resource: ResourceType,
): [string, AttrSpec][] {
  const spec = RULE_BUILDER_ACTIONS[action];
  const context: [string, AttrSpec][] = Object.entries(CONTEXT_ATTRS[spec.context]).map(
    ([k, v]) => [`context.${k}`, v],
  );
  const principals = Object.entries(ENTITY_ATTRS[principal]).map(([k, v]): [string, AttrSpec] => [
    `principal.${k}`,
    v,
  ]);
  const resources = Object.entries(ENTITY_ATTRS[resource]).map(([k, v]): [string, AttrSpec] => [
    `resource.${k}`,
    v,
  ]);
  return [...principals, ...resources, ...context];
}

describe('compileRuleBuilder: representative document', () => {
  it('compiles to the golden Cedar text, with no warnings', () => {
    const out = compileRuleBuilder(representative);
    expect(out.cedarSource).toBe(fixture('representative.cedar'));
    expect(out.warnings).toEqual([]);
  });

  it('produces Cedar that validates against the POLICY-001 schema', () => {
    const { cedarSource } = compileRuleBuilder(representative);
    expect(validatePolicies(cedarSource)).toEqual({ ok: true, errors: [] });
  });

  it('is byte-identical for identical input, and independent of JSON key order', () => {
    const first = compileRuleBuilder(representative).cedarSource;
    expect(compileRuleBuilder(representative).cedarSource).toBe(first);
    const reordered = JSON.parse(
      JSON.stringify(representative, (_k, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as unknown;
    expect(compileRuleBuilder(reordered).cedarSource).toBe(first);
  });

  it('emits one policy per rule keyed by its annotation id, tagged as builder output', () => {
    const { cedarSource } = compileRuleBuilder(representative);
    const parts = policySetTextToParts(cedarSource);
    expect(parts.type === 'success' && parts.policies).toHaveLength(4);
    for (const id of [
      'tenant.allow-read-in-scope',
      'tenant.block-admin-paths',
      'tenant.allow-passive-probe',
      'tenant.approver-gates',
    ]) {
      expect(cedarSource).toContain(`@id("${id}")`);
    }
    expect(cedarSource.match(/@source\("rule-builder"\)/g)).toHaveLength(4);
  });
});

describe('compileRuleBuilder: empty and generated ids', () => {
  it('compiles an empty rule set to an empty tenant policy, not an error', () => {
    expect(compileRuleBuilder({ rules: [] })).toEqual({ cedarSource: '', warnings: [] });
  });

  it('uses rule-<n> as the policy id when a rule has no annotation id', () => {
    const { cedarSource } = compileRuleBuilder({ rules: [rule(), rule({ effect: 'forbid' })] });
    expect(cedarSource).toContain('@id("rule-1")');
    expect(cedarSource).toContain('@id("rule-2")');
    expect(validatePolicies(cedarSource).ok).toBe(true);
  });

  it('rejects a generated id that collides with an explicit one, at the generated rule', () => {
    const err = errorOf({
      rules: [rule({ annotations: { id: 'rule-2' } }), rule()],
    });
    expect(err.code).toBe('POLICY_BUILDER_INVALID');
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/1' })]);
  });

  it('rejects two rules that name the same id', () => {
    const err = errorOf({
      rules: [rule({ annotations: { id: 'dup' } }), rule({ annotations: { id: 'dup' } })],
    });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/1/annotations/id' })]);
  });
});

describe('compileRuleBuilder: rejections with JSON pointers', () => {
  it('rejects an unknown action with a pointer to it', () => {
    const err = errorOf({ rules: [rule({ action: 'egress.raw' })] });
    expect(err.code).toBe('POLICY_BUILDER_INVALID');
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/action');
  });

  it('rejects an unknown attribute with a pointer to the condition attribute', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '==', attr: 'resource.ip', value: '10.0.0.1' }] })],
    });
    expect(err.issues).toEqual([
      expect.objectContaining({
        pointer: '/rules/0/conditions/0/attr',
        message: 'unknown attribute for this action',
      }),
    ]);
  });

  it('rejects an unknown operator with a pointer to the condition', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '!=', attr: 'resource.host', value: 'x' }] })],
    });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0');
  });

  it('rejects a prototype key as an attribute', () => {
    for (const attr of ['principal.constructor', 'context.__proto__', 'resource.toString']) {
      const err = errorOf({ rules: [rule({ conditions: [{ op: '==', attr, value: 'x' }] })] });
      expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0/attr');
    }
  });

  it('rejects an attribute that belongs to another context or action', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '==', attr: 'context.toolName', value: 'x' }] })],
    });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0/attr');
  });

  it('rejects a principal or resource attribute when the scope type is not set', () => {
    const err = errorOf({
      rules: [
        {
          effect: 'permit',
          action: 'policy.edit',
          conditions: [{ op: '==', attr: 'resource.tenantId', value: 'acme' }],
        },
      ],
    });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0/attr');
  });

  it('rejects a principal type the action does not accept', () => {
    const err = errorOf({ rules: [rule({ principal: { type: 'User' } })] });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/principal/type' })]);
  });

  it('rejects a resource type the action does not accept', () => {
    const err = errorOf({ rules: [rule({ resource: { type: 'Asset' } })] });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/resource/type' })]);
  });

  it('rejects a value of the wrong type', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '==', attr: 'resource.host', value: 5 }] })],
    });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/conditions/0' })]);
  });

  it('rejects an intrusiveness rank outside the SCOPE-003 range, against the enum bound', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '<=', attr: 'context.intrusiveness.rank', value: 7 }] })],
    });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/conditions/0' })]);
  });

  it('rejects an intrusiveness level that is not a class in the enum', () => {
    const err = errorOf({
      rules: [
        rule({
          conditions: [{ op: '==', attr: 'context.intrusiveness.level', value: 'destructive_ish' }],
        }),
      ],
    });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/conditions/0' })]);
  });

  it('accepts every intrusiveness class as a level literal', () => {
    for (const level of INTRUSIVENESS_CLASSES) {
      const { cedarSource } = compileRuleBuilder({
        rules: [
          rule({ conditions: [{ op: '==', attr: 'context.intrusiveness.level', value: level }] }),
        ],
      });
      expect(validatePolicies(cedarSource).ok).toBe(true);
    }
  });

  it('rejects set attributes compared with ==, and scalars tested with contains', () => {
    const roles = errorOf({
      rules: [
        rule({
          action: 'gate.decide',
          principal: { type: 'User' },
          resource: { type: 'Run' },
          conditions: [{ op: '==', attr: 'principal.roles', value: 'admin' }],
        }),
      ],
    });
    expect(roles.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/conditions/0' })]);
    const scalar = errorOf({
      rules: [rule({ conditions: [{ op: 'contains', attr: 'resource.host', value: 'x' }] })],
    });
    expect(scalar.issues).toEqual([expect.objectContaining({ pointer: '/rules/0/conditions/0' })]);
  });

  it('rejects <= on a non-numeric attribute', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '<=', attr: 'resource.host', value: 3 }] })],
    });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0');
  });

  it('rejects groups nested deeper than the limit', () => {
    let node: Record<string, unknown> = { op: '==', attr: 'resource.host', value: 'x' };
    for (let i = 0; i < 5; i++) node = { op: '&&', of: [node] };
    const err = errorOf({ rules: [rule({ conditions: [node] })] });
    expect(err.issues.some((i) => i.message.includes('nest'))).toBe(true);
  });

  it('rejects a document with more rules than the bound', () => {
    const err = errorOf({ rules: Array.from({ length: 201 }, () => rule()) });
    expect(err.issues).toEqual([expect.objectContaining({ pointer: '/rules' })]);
  });

  it('rejects a string with a lone surrogate', () => {
    const err = errorOf({
      rules: [rule({ conditions: [{ op: '==', attr: 'resource.host', value: '\uD800' }] })],
    });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0/value');
  });

  it('rejects the reserved baseline. id namespace and malformed ids', () => {
    expect(errorOf({ rules: [rule({ annotations: { id: 'baseline.x' } })] }).issues).toEqual([
      expect.objectContaining({ pointer: '/rules/0/annotations/id' }),
    ]);
    expect(errorOf({ rules: [rule({ annotations: { id: 'a"b' } })] }).issues).toEqual([
      expect.objectContaining({ pointer: '/rules/0/annotations/id' }),
    ]);
  });
});

describe('compileRuleBuilder: no free-form Cedar', () => {
  it('rejects a rule that carries raw Cedar text in any field', () => {
    const raw = 'permit (principal, action, resource);';
    expect(errorOf({ rules: [rule({ cedar: raw })] }).code).toBe('POLICY_BUILDER_INVALID');
    expect(errorOf({ rules: [rule({ action: 'Egress::Action::"httpRequest"' })] }).issues).toEqual([
      expect.objectContaining({ pointer: '/rules/0/action' }),
    ]);
    expect(
      errorOf({
        rules: [rule({ conditions: [{ op: '==', attr: 'resource.host', value: 'x', raw }] })],
      }).code,
    ).toBe('POLICY_BUILDER_INVALID');
  });

  it('rejects an attribute path that tries to close the expression and add a policy', () => {
    const attr = 'principal.persona) || true; permit(principal, action, resource) when { true';
    const err = errorOf({ rules: [rule({ conditions: [{ op: '==', attr, value: 'x' }] })] });
    expect(err.issues.map((i) => i.pointer)).toContain('/rules/0/conditions/0/attr');
  });

  it('keeps an injection attempt in a string value as data, not as a second policy', () => {
    const value = 'x" || true || "';
    const { cedarSource } = compileRuleBuilder({
      rules: [rule({ conditions: [{ op: '==', attr: 'resource.host', value }] })],
    });
    const parts = policySetTextToParts(cedarSource);
    expect(parts.type === 'success' && parts.policies.length).toBe(1);
    expect(validatePolicies(cedarSource).ok).toBe(true);
    expect(cedarSource).toContain('resource.host == "x\\" || true || \\""');
  });

  it('escapes annotation descriptions so a */ or newline cannot break out of the annotation', () => {
    const description = 'ends */ here\n permit (principal, action, resource);\r\u0000 café 東京';
    const { cedarSource } = compileRuleBuilder({ rules: [rule({ annotations: { description } })] });
    expect(validatePolicies(cedarSource).ok).toBe(true);
    const parts = policySetTextToParts(cedarSource);
    expect(parts.type === 'success' && parts.policies).toHaveLength(1);
    expect(cedarSource).toContain(
      '@description("ends */ here\\u{a} permit (principal, action, resource);\\u{d}\\u{0} café 東京")',
    );
  });
});

describe('compileRuleBuilder: warnings never block compilation', () => {
  it('warns that a duplicate rule can never change a decision', () => {
    const out = compileRuleBuilder({ rules: [rule(), rule()] });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ pointer: '/rules/1' });
    expect(out.warnings[0]?.message).toContain('duplicates');
  });

  it('warns on a contradictory permit and forbid over the same condition', () => {
    const out = compileRuleBuilder({ rules: [rule(), rule({ effect: 'forbid' })] });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ pointer: '/rules/1' });
    expect(out.warnings[0]?.message).toContain('forbid overrides');
    expect(validatePolicies(out.cedarSource).ok).toBe(true);
  });

  it('warns that a permit is shadowed by an unconditional forbid over a covering scope', () => {
    const out = compileRuleBuilder({
      rules: [rule({ effect: 'forbid', conditions: [], resource: undefined }), rule()],
    });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ pointer: '/rules/1' });
    expect(out.warnings[0]?.message).toContain('shadowed');
  });

  it('does not treat a forbid with a narrower scope as shadowing a broader permit', () => {
    const out = compileRuleBuilder({
      rules: [
        rule({ resource: undefined, conditions: [] }),
        rule({ effect: 'forbid', conditions: [] }),
      ],
    });
    expect(out.warnings.filter((w) => w.message.includes('shadowed'))).toEqual([]);
  });

  it('warns on a condition that is always true for every request', () => {
    const out = compileRuleBuilder({
      rules: [rule({ conditions: [{ op: '>=', attr: 'context.intrusiveness.rank', value: 0 }] })],
    });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ pointer: '/rules/0/conditions/0' });
    expect(out.warnings[0]?.message).toContain('always true');
    expect(out.cedarSource).toContain('context.intrusiveness.rank >= 0');
  });

  it('warns on duplicate values in a membership list and still emits them once', () => {
    const out = compileRuleBuilder({
      rules: [rule({ conditions: [{ op: 'in', attr: 'resource.host', value: ['a', 'a', 'b'] }] })],
    });
    expect(out.warnings).toEqual([
      expect.objectContaining({ pointer: '/rules/0/conditions/0/value' }),
    ]);
    expect(out.cedarSource).toContain('["a", "b"].contains(resource.host)');
  });
});

describe('compileRuleBuilder: allowlist and property checks', () => {
  it('every allowlisted attribute validates against the schema for every action scope', () => {
    for (const action of ACTION_KEYS) {
      const spec = RULE_BUILDER_ACTIONS[action];
      for (const principal of spec.principals) {
        for (const resource of spec.resources) {
          for (const [attr, attrSpec] of attributesFor(action, principal, resource)) {
            const condition = leafFor(attr, attrSpec);
            const { cedarSource } = compileRuleBuilder({
              rules: [
                {
                  effect: 'permit',
                  action,
                  principal: { type: principal },
                  resource: { type: resource },
                  conditions: [condition],
                },
              ],
            });
            const result = validatePolicies(cedarSource);
            expect(result, `${action} ${principal}/${resource} ${attr}`).toEqual({
              ok: true,
              errors: [],
            });
          }
        }
      }
    }
  }, 120_000);

  it('compiles any generated valid document to Cedar that validates, deterministically', () => {
    const literal = (attr: string, spec: AttrSpec): fc.Arbitrary<Condition> => {
      switch (spec.type) {
        case 'stringSet':
          return fc
            .string({ maxLength: 12 })
            .map((value) => ({ op: 'contains' as const, attr, value }));
        case 'bool':
          return fc.boolean().map((value) => ({ op: '==' as const, attr, value }));
        case 'intrusivenessLevel':
          return fc
            .constantFrom(...INTRUSIVENESS_CLASSES)
            .map((value) => ({ op: '==' as const, attr, value }));
        case 'string':
          return fc.oneof(
            fc.string({ maxLength: 12 }).map((value) => ({ op: '==' as const, attr, value })),
            fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 3 }).map((value) => ({
              op: 'in' as const,
              attr,
              value,
            })),
          );
        case 'long': {
          const [lo, hi] = spec.range ?? [-5, 5];
          return fc.oneof(
            fc.integer({ min: lo, max: hi }).map((value) => ({ op: '<=' as const, attr, value })),
            fc.integer({ min: lo, max: hi }).map((value) => ({ op: '>=' as const, attr, value })),
            fc.integer({ min: lo, max: hi }).map((value) => ({ op: '==' as const, attr, value })),
          );
        }
      }
    };
    const documentArb = fc.constantFrom(...ACTION_KEYS).chain((action) => {
      const spec = RULE_BUILDER_ACTIONS[action];
      return fc
        .tuple(
          fc.constantFrom(...spec.principals),
          fc.constantFrom(...spec.resources),
          fc.constantFrom('permit' as const, 'forbid' as const),
        )
        .chain(([principal, resource, effect]) => {
          const attrs = attributesFor(action, principal, resource);
          const condition = fc
            .constantFrom(...attrs)
            .chain(([attr, attrSpec]) => literal(attr, attrSpec));
          return fc.array(condition, { maxLength: 4 }).map((conditions) => ({
            rules: [
              {
                effect,
                action,
                principal: { type: principal },
                resource: { type: resource },
                conditions,
              },
            ],
          }));
        });
    });
    fc.assert(
      fc.property(documentArb, (doc) => {
        const first = compileRuleBuilder(doc);
        expect(compileRuleBuilder(doc).cedarSource).toBe(first.cedarSource);
        expect(validatePolicies(first.cedarSource).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  }, 120_000);
});

/** The simplest well-typed comparison for an allowlisted attribute. */
function leafFor(attr: string, spec: AttrSpec) {
  switch (spec.type) {
    case 'stringSet':
      return { op: 'contains', attr, value: 'x' };
    case 'bool':
      return { op: '==', attr, value: true };
    case 'intrusivenessLevel':
      return { op: '==', attr, value: 'passive' };
    case 'string':
      return { op: '==', attr, value: 'x' };
    case 'long':
      return { op: '<=', attr, value: spec.range?.[1] ?? 0 };
  }
}
