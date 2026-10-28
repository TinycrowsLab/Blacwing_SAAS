import {
  getNamedType,
  getNullableType,
  GraphQLError,
  isCompositeType,
  isListType,
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type SelectionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';

/** Wire code of every rejected operation (mirrors the REST problem registry). */
export const QUERY_TOO_COMPLEX = 'query_too_complex';

/** Argument that sizes a list field (`tenantMembers(first: 20)`). */
const LIST_SIZE_ARG = 'first';

export type QueryLimitReason = 'depth' | 'complexity' | 'aliases';

export interface QueryLimits {
  /** Deepest field nesting allowed. */
  readonly maxDepth: number;
  /** Largest estimated cost allowed (a list multiplies the cost of its children). */
  readonly maxComplexity: number;
  /** Most aliased fields allowed in one operation (fragments are counted once). */
  readonly maxAliases: number;
}

export interface QueryShape {
  readonly depth: number;
  readonly complexity: number;
  readonly aliases: number;
}

export interface QueryLimitsHooks {
  /** Called once per analysed operation, with its name (or `anonymous`) and measured shape. */
  readonly onOperation?: (operation: string, shape: QueryShape) => void;
  /** Called with the reason when an operation is rejected. */
  readonly onRejected?: (reason: QueryLimitReason, operation: string, shape: QueryShape) => void;
}

interface Measure {
  /** Field levels below the selection set (0 when it selects no fields). */
  readonly depth: number;
  readonly cost: number;
  readonly aliases: number;
}

const NO_MEASURE: Measure = Object.freeze({ depth: 0, cost: 0, aliases: 0 });

/** Estimated cost of one leaf field; a list multiplies its element cost by its size. */
const LEAF_COST = 1;

/** Measures one operation against the schema. Fragment spreads are measured once and reused, so a
 * fragment that spreads others many times costs linear, not exponential, time; a cycle measures as zero
 * (the spec's `NoFragmentCycles` rule reports it). */
class OperationMeter {
  readonly #fragments: ReadonlyMap<string, FragmentDefinitionNode>;
  readonly #memo = new Map<string, Measure>();
  readonly #inProgress = new Set<string>();

  constructor(
    private readonly schema: GraphQLSchema,
    fragments: ReadonlyMap<string, FragmentDefinitionNode>,
    private readonly variables: Readonly<Record<string, unknown>>,
  ) {
    this.#fragments = fragments;
  }

  measureRoot(root: GraphQLCompositeType | null | undefined, set: SelectionSetNode): Measure {
    return this.#selections(set, root ?? undefined);
  }

  #selections(set: SelectionSetNode, parent: GraphQLCompositeType | undefined): Measure {
    let depth = 0;
    let cost = 0;
    let aliases = 0;
    for (const selection of set.selections) {
      const part = this.#selection(selection, parent);
      depth = Math.max(depth, part.depth);
      cost += part.cost;
      aliases += part.aliases;
    }
    return { depth, cost, aliases };
  }

  #selection(node: SelectionNode, parent: GraphQLCompositeType | undefined): Measure {
    if (node.kind === Kind.INLINE_FRAGMENT) {
      const typeName = node.typeCondition?.name.value;
      const type = typeName === undefined ? parent : this.schema.getType(typeName);
      return this.#selections(node.selectionSet, isCompositeType(type) ? type : parent);
    }
    if (node.kind === Kind.FRAGMENT_SPREAD) return this.#spread(node.name.value);
    return this.#field(node, parent);
  }

  #field(node: FieldNode, parent: GraphQLCompositeType | undefined): Measure {
    const aliasCount = node.alias === undefined ? 0 : 1;
    const name = node.name.value;
    const definition =
      parent !== undefined && 'getFields' in parent && !name.startsWith('__')
        ? parent.getFields()[name]
        : undefined;
    if (definition === undefined) {
      // `__typename`, introspection meta fields and unknown fields (rejected by spec rules) are leaves.
      return { depth: 1, cost: LEAF_COST, aliases: aliasCount };
    }
    const child = node.selectionSet
      ? this.#selections(node.selectionSet, childComposite(definition.type))
      : NO_MEASURE;
    // A list of objects multiplies its elements' cost; a list of scalars is one resolver value and costs once.
    const multiplier =
      node.selectionSet !== undefined && isListType(getNullableType(definition.type))
        ? this.#listSize(node)
        : 1;
    return {
      depth: 1 + child.depth,
      cost: multiplier * (LEAF_COST + child.cost),
      aliases: aliasCount + child.aliases,
    };
  }

  #spread(name: string): Measure {
    const memo = this.#memo.get(name);
    if (memo !== undefined) return memo;
    const fragment = this.#fragments.get(name);
    if (fragment === undefined || this.#inProgress.has(name)) return NO_MEASURE;
    this.#inProgress.add(name);
    const typeName = fragment.typeCondition.name.value;
    const measure = this.#selections(fragment.selectionSet, this.#compositeNamed(typeName));
    this.#inProgress.delete(name);
    this.#memo.set(name, measure);
    return measure;
  }

  #compositeNamed(name: string): GraphQLCompositeType | undefined {
    const type = this.schema.getType(name);
    return isCompositeType(type) ? type : undefined;
  }

  /** The page size a list field asks for: a literal `first`, a variable's value, else the pagination maximum. */
  #listSize(node: FieldNode): number {
    const arg = node.arguments?.find((candidate) => candidate.name.value === LIST_SIZE_ARG);
    // The resolver clamps and defaults `first` the same way, so the estimate prices the page it will return.
    if (arg === undefined) return DEFAULT_PAGE_SIZE;
    if (arg.value.kind === Kind.INT) return Math.min(Number(arg.value.value), MAX_PAGE_SIZE);
    if (arg.value.kind === Kind.VARIABLE) {
      const value = this.variables[arg.value.name.value];
      if (typeof value === 'number' && Number.isFinite(value))
        return Math.min(Math.max(value, 0), MAX_PAGE_SIZE);
    }
    return DEFAULT_PAGE_SIZE;
  }
}

function childComposite(type: GraphQLOutputType): GraphQLCompositeType | undefined {
  const named = getNamedType(type);
  return isCompositeType(named) ? named : undefined;
}

/** Shape of one operation, measured against the schema. */
export function measureOperation(
  schema: GraphQLSchema,
  operation: { readonly operation: string; readonly selectionSet: SelectionSetNode },
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variables: Readonly<Record<string, unknown>> = {},
): QueryShape {
  const root =
    operation.operation === 'mutation'
      ? schema.getMutationType()
      : operation.operation === 'subscription'
        ? schema.getSubscriptionType()
        : schema.getQueryType();
  const measure = new OperationMeter(schema, fragments, variables).measureRoot(
    root,
    operation.selectionSet,
  );
  return { depth: measure.depth, complexity: measure.cost, aliases: measure.aliases };
}

/** The first limit an operation exceeds, in the order depth, complexity, aliases. */
export function violatedLimit(
  shape: QueryShape,
  limits: QueryLimits,
): QueryLimitReason | undefined {
  if (shape.depth > limits.maxDepth) return 'depth';
  if (shape.complexity > limits.maxComplexity) return 'complexity';
  if (shape.aliases > limits.maxAliases) return 'aliases';
  return undefined;
}

/**
 * The GraphQL validation rule that rejects over-limit operations before any resolver runs (API-009).
 * It needs the request's variables, so it is installed through Mercurius' function form of
 * `validationRules` (which disables the document cache; see `graphql/module.ts`).
 */
export function createQueryLimitsRule(
  limits: QueryLimits,
  variables: Readonly<Record<string, unknown>>,
  hooks: QueryLimitsHooks = {},
): ValidationRule {
  return (context: ValidationContext) => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of context.getDocument().definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION)
        fragments.set(definition.name.value, definition);
    }
    return {
      OperationDefinition(node) {
        const name = node.name?.value ?? 'anonymous';
        const schema = context.getSchema();
        const shape = measureOperation(schema, node, fragments, variables);
        hooks.onOperation?.(name, shape);
        const reason = violatedLimit(shape, limits);
        if (reason === undefined) return;
        hooks.onRejected?.(reason, name, shape);
        context.reportError(
          new GraphQLError(rejectionMessage(reason, shape, limits), {
            nodes: [node],
            extensions: { code: QUERY_TOO_COMPLEX },
          }),
        );
      },
    };
  };
}

function rejectionMessage(
  reason: QueryLimitReason,
  shape: QueryShape,
  limits: QueryLimits,
): string {
  switch (reason) {
    case 'depth':
      return `query depth ${shape.depth} exceeds the limit of ${limits.maxDepth}`;
    case 'complexity':
      return `query complexity ${shape.complexity} exceeds the limit of ${limits.maxComplexity}`;
    case 'aliases':
      return `query uses ${shape.aliases} aliases, above the limit of ${limits.maxAliases}`;
  }
}
