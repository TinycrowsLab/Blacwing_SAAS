import { z } from 'zod';

import { ACTION_KEYS, PRINCIPAL_TYPES, RESOURCE_TYPES } from './allowlist.js';

/** Bounds that keep a builder document small enough to compile and review (overflow is rejected). */
export const RULE_BUILDER_LIMITS = Object.freeze({
  rules: 200,
  conditionsPerRule: 20,
  groupDepth: 4,
  listValues: 50,
  stringLength: 256,
  descriptionLength: 1024,
  idLength: 128,
  attrPath: 128,
});

const ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,${RULE_BUILDER_LIMITS.idLength - 1}}$`);

/** A Cedar-safe string: well-formed Unicode (no lone surrogates) within the length bound. */
const wellFormed = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const boundedString = (max: number) =>
  z.string().max(max).refine(wellFormed, { message: 'must be well-formed Unicode' });

const scalar = z.union([
  boundedString(RULE_BUILDER_LIMITS.stringLength),
  z.number().int(),
  z.boolean(),
]);
const attrPath = z.string().min(1).max(RULE_BUILDER_LIMITS.attrPath);

/**
 * One comparison. `op` is an allowlisted operator; `attr` is an allowlisted attribute path. Whether
 * `attr` exists for the rule's scope and whether `value` has the attribute's type is checked
 * semantically (see `compile.ts`), so a wrong attribute is reported with its JSON pointer.
 */
const leafSchema = z.union([
  z.strictObject({ op: z.literal('=='), attr: attrPath, value: scalar }),
  z.strictObject({ op: z.literal('<='), attr: attrPath, value: z.number().int() }),
  z.strictObject({ op: z.literal('>='), attr: attrPath, value: z.number().int() }),
  z.strictObject({
    op: z.literal('in'),
    attr: attrPath,
    value: z.array(scalar).min(1).max(RULE_BUILDER_LIMITS.listValues),
  }),
  z.strictObject({
    op: z.literal('contains'),
    attr: attrPath,
    value: boundedString(RULE_BUILDER_LIMITS.stringLength),
  }),
]);

/** A condition is a comparison, or an `&&` / `||` group of conditions. */
export type Condition =
  z.infer<typeof leafSchema> | { readonly op: '&&' | '||'; readonly of: readonly Condition[] };

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leafSchema,
    z.strictObject({
      op: z.enum(['&&', '||']),
      of: z.array(conditionSchema).min(1).max(RULE_BUILDER_LIMITS.conditionsPerRule),
    }),
  ]),
);

/** The builder rule. `conditions` are ANDed; an omitted match leaves that side unconstrained. */
export const builderRuleSchema = z.strictObject({
  effect: z.enum(['permit', 'forbid']),
  action: z.enum(ACTION_KEYS),
  principal: z.strictObject({ type: z.enum(PRINCIPAL_TYPES) }).optional(),
  resource: z.strictObject({ type: z.enum(RESOURCE_TYPES) }).optional(),
  conditions: z.array(conditionSchema).max(RULE_BUILDER_LIMITS.conditionsPerRule).optional(),
  annotations: z
    .strictObject({
      id: z
        .string()
        .regex(ID_PATTERN, { message: 'must match ^[A-Za-z0-9][A-Za-z0-9_.-]*$' })
        .refine((id) => !id.startsWith('baseline.'), {
          message: 'the baseline. prefix is reserved',
        })
        .optional(),
      description: boundedString(RULE_BUILDER_LIMITS.descriptionLength).optional(),
    })
    .optional(),
});

/** The rule-builder document (CONTEXT_PACK §7 `policies.rule_builder_json`). */
export const ruleBuilderPolicySchema = z.strictObject({
  rules: z.array(builderRuleSchema).max(RULE_BUILDER_LIMITS.rules),
});

export type RuleBuilderPolicy = z.infer<typeof ruleBuilderPolicySchema>;
export type BuilderRule = z.infer<typeof builderRuleSchema>;
