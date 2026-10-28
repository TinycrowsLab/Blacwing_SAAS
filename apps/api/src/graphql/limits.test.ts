import {
  buildSchema,
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
  parse,
  validate,
} from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  createQueryLimitsRule,
  measureOperation,
  QUERY_TOO_COMPLEX,
  type QueryLimits,
  violatedLimit,
} from './limits.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './page.js';

const schema = buildSchema(`
  type Query {
    tenantMembers(first: Int): [TenantMember!]!
    viewer: TenantMember
  }
  type TenantMember {
    userId: ID!
    roles: [String!]!
    user: User
  }
  type User {
    id: ID!
    name: String
    friends(first: Int): [User!]!
  }
`);

const LIMITS: QueryLimits = { maxDepth: 10, maxComplexity: 1000, maxAliases: 50 };

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) map.set(definition.name.value, definition);
  }
  return map;
}

function shapeOf(source: string, variables: Record<string, unknown> = {}) {
  const document = parse(source);
  const operation = document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (operation?.kind !== Kind.OPERATION_DEFINITION) throw new Error('no operation in fixture');
  return measureOperation(schema, operation, fragmentsOf(document), variables);
}

describe('measureOperation', () => {
  it('counts field levels as depth and leaves as cost one', () => {
    expect(shapeOf('{ viewer { userId } }')).toEqual({ depth: 2, complexity: 2, aliases: 0 });
    expect(shapeOf('{ viewer { user { name } } }')).toEqual({
      depth: 3,
      complexity: 3,
      aliases: 0,
    });
  });

  it('multiplies a list by its literal first argument', () => {
    // 20 members, each costing its own field (1) plus userId (1).
    expect(shapeOf('{ tenantMembers(first: 20) { userId } }').complexity).toBe(40);
  });

  it('prices a variable page size from its value, and an absent one at the resolver default', () => {
    const source = 'query Q($n: Int) { tenantMembers(first: $n) { userId } }';
    expect(shapeOf(source, { n: 5 }).complexity).toBe(10);
    expect(shapeOf(source).complexity).toBe(2 * DEFAULT_PAGE_SIZE);
    expect(shapeOf('{ tenantMembers { userId } }').complexity).toBe(2 * DEFAULT_PAGE_SIZE);
  });

  it('caps a page size at the pagination maximum, literal or variable', () => {
    expect(shapeOf('{ tenantMembers(first: 1000000) { userId } }').complexity).toBe(
      2 * MAX_PAGE_SIZE,
    );
    expect(
      shapeOf('query Q($n: Int) { tenantMembers(first: $n) { userId } }', { n: 99999 }).complexity,
    ).toBe(2 * MAX_PAGE_SIZE);
  });

  it('counts a fragment spread once per spread and follows inline fragments', () => {
    const shape = shapeOf(`
      { tenantMembers(first: 2) { ...M } }
      fragment M on TenantMember { userId ... on TenantMember { roles } }
    `);
    expect(shape.depth).toBe(2);
    // Two members, each costing itself (1) plus userId (1) and roles (1).
    expect(shape.complexity).toBe(2 * (1 + 2));
  });

  it('counts aliases, including aliases reached through a fragment', () => {
    const shape = shapeOf(`
      { a: viewer { x: userId y: userId } ...F }
      fragment F on Query { b: viewer { userId } }
    `);
    expect(shape.aliases).toBe(4);
  });

  it('costs a list of scalars once, whatever its page size', () => {
    expect(shapeOf('{ tenantMembers(first: 200) { roles } }').complexity).toBe(200 * (1 + 1));
    expect(shapeOf('{ viewer { roles } }').complexity).toBe(2);
  });

  it('treats __typename and unknown fields as leaves and does not recurse into them', () => {
    expect(shapeOf('{ viewer { __typename } }')).toEqual({ depth: 2, complexity: 2, aliases: 0 });
    expect(shapeOf('{ viewer { nope { deeper { deepest } } } }').depth).toBe(2);
  });

  it('terminates on fragment cycles (the spec rule reports them)', () => {
    const shape = shapeOf(`
      { viewer { ...A } }
      fragment A on TenantMember { userId ...B }
      fragment B on TenantMember { roles ...A }
    `);
    expect(shape.depth).toBe(2);
  });

  it('measures a fragment bomb in linear time and reports its cost above any limit', () => {
    // Each level spreads the next one twice over a list: 2^40 expanded selections if spreads were not memoised.
    const levels = 40;
    const lines = ['{ viewer { user { ...F0 } } }'];
    for (let i = 0; i < levels; i += 1) {
      lines.push(`fragment F${i} on User { friends(first: 2) { ...F${i + 1} ...F${i + 1} } }`);
    }
    lines.push(`fragment F${levels} on User { name }`);
    const started = performance.now();
    const shape = shapeOf(lines.join('\n'));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(shape.complexity).toBeGreaterThan(LIMITS.maxComplexity);
    expect(shape.depth).toBeGreaterThan(LIMITS.maxDepth);
  });
});

describe('violatedLimit', () => {
  it('reports the first exceeded limit in depth, complexity, aliases order', () => {
    const limits = { maxDepth: 2, maxComplexity: 5, maxAliases: 1 };
    expect(violatedLimit({ depth: 3, complexity: 9, aliases: 9 }, limits)).toBe('depth');
    expect(violatedLimit({ depth: 2, complexity: 9, aliases: 9 }, limits)).toBe('complexity');
    expect(violatedLimit({ depth: 2, complexity: 5, aliases: 2 }, limits)).toBe('aliases');
    expect(violatedLimit({ depth: 2, complexity: 5, aliases: 1 }, limits)).toBeUndefined();
  });
});

describe('createQueryLimitsRule', () => {
  function check(source: string, limits: QueryLimits, variables: Record<string, unknown> = {}) {
    const hooks = { onOperation: [] as string[], onRejected: [] as string[] };
    const errors = validate(schema, parse(source), [
      createQueryLimitsRule(limits, variables, {
        onOperation: (name) => hooks.onOperation.push(name),
        onRejected: (reason) => hooks.onRejected.push(reason),
      }),
    ]);
    return { errors, hooks };
  }

  it('accepts an operation within every limit', () => {
    const { errors, hooks } = check('query Dash { viewer { userId } }', LIMITS);
    expect(errors).toEqual([]);
    expect(hooks.onOperation).toEqual(['Dash']);
    expect(hooks.onRejected).toEqual([]);
  });

  it('rejects an over-deep operation with query_too_complex and the depth reason', () => {
    const { errors, hooks } = check('{ viewer { user { friends { name } } } }', {
      ...LIMITS,
      maxDepth: 3,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.extensions).toEqual({ code: QUERY_TOO_COMPLEX });
    expect(errors[0]?.message).toMatch(/depth 4 exceeds the limit of 3/);
    expect(hooks.onRejected).toEqual(['depth']);
  });

  it('rejects an over-complex operation and reads variables for list sizes', () => {
    const source = 'query Q($n: Int) { tenantMembers(first: $n) { userId roles } }';
    expect(check(source, { ...LIMITS, maxComplexity: 30 }, { n: 10 }).errors).toEqual([]);
    const rejected = check(source, { ...LIMITS, maxComplexity: 30 }, { n: 100 });
    expect(rejected.errors[0]?.extensions).toEqual({ code: QUERY_TOO_COMPLEX });
    expect(rejected.hooks.onRejected).toEqual(['complexity']);
  });

  it('rejects an alias flood even when the operation is shallow and cheap', () => {
    const aliases = Array.from({ length: 4 }, (_, i) => `a${i}: viewer { userId }`).join(' ');
    const { errors, hooks } = check(`{ ${aliases} }`, { ...LIMITS, maxAliases: 3 });
    expect(errors[0]?.extensions).toEqual({ code: QUERY_TOO_COMPLEX });
    expect(hooks.onRejected).toEqual(['aliases']);
  });
});
