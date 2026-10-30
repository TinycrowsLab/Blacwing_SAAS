import { describe, expect, it } from 'vitest';

import { OracleBindingSchema } from '@blackwing/contracts';

import {
  ACCESS_CONTROL_CLASSES,
  accessMatrixBinding,
  AUTHZ_MATRIX_CELLS_METRIC,
  AUTHZ_MATRIX_CELLS_METRIC_LABELS,
  AuthorisationMatrixSchema,
  AuthzMatrixError,
  authzMatrixCellSamples,
  deriveAuthorisationMatrix,
  NEGATIVE_CONTROL_TEMPLATES,
  parseAuthorisationMatrix,
  projectMatrix,
  resolveExpectedAccess,
  selectControlRole,
  type AuthorisationMatrix,
} from './model.js';

const DECLARED_AT = '2026-01-01T00:00:00.000Z';

/** The raw input of a small matrix: anonymous, customer and admin over three functions, with one owned object. */
function rawMatrix(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    roles: ['anonymous', 'customer', 'admin'],
    functions: [
      { id: 'search_products', method: 'GET', pathTemplate: '/rest/products/search' },
      { id: 'view_basket', method: 'GET', pathTemplate: '/rest/basket/{id}' },
      { id: 'list_users', method: 'GET', pathTemplate: '/api/Users' },
    ],
    objects: [{ id: 'basket_7', ownerRoleId: 'customer' }],
    cells: [
      { roleId: 'anonymous', functionId: 'search_products', expected: 'allow' },
      { roleId: 'customer', functionId: 'search_products', expected: 'allow' },
      { roleId: 'admin', functionId: 'search_products', expected: 'allow' },
      { roleId: 'anonymous', functionId: 'list_users', expected: 'deny' },
      { roleId: 'customer', functionId: 'list_users', expected: 'deny' },
      { roleId: 'admin', functionId: 'list_users', expected: 'allow' },
      { roleId: 'customer', functionId: 'view_basket', objectId: 'basket_7', expected: 'allow' },
      { roleId: 'admin', functionId: 'view_basket', objectId: 'basket_7', expected: 'deny' },
    ],
    ...overrides,
  };
}

/** A valid matrix built from `rawMatrix`. */
function sampleMatrix(overrides: Record<string, unknown> = {}): AuthorisationMatrix {
  return parseAuthorisationMatrix(rawMatrix(overrides));
}

/** A `role_matrices.matrix` payload in the shape the seed writes. */
function storedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roles: ['anonymous', 'customer', 'admin'],
    functions: [
      {
        function: 'view_own_basket',
        method: 'GET',
        path: '/rest/basket/{id}',
        expected: { anonymous: 'deny', customer: 'allow', admin: 'allow' },
      },
      {
        function: 'list_users',
        method: 'GET',
        path: '/api/Users',
        expected: { anonymous: 'deny', customer: 'deny', admin: 'allow' },
      },
    ],
    ...overrides,
  };
}

describe('AuthorisationMatrixSchema', () => {
  it('parses a complete matrix', () => {
    expect(AuthorisationMatrixSchema.safeParse(sampleMatrix()).success).toBe(true);
  });

  it('accepts a matrix with no objects declared', () => {
    const matrix = sampleMatrix({ objects: undefined, cells: [] });
    expect(AuthorisationMatrixSchema.safeParse(matrix).success).toBe(true);
  });

  it.each([
    [
      'a cell role that is not declared',
      { cells: [{ roleId: 'ghost', functionId: 'list_users', expected: 'deny' }] },
    ],
    [
      'a cell function that is not declared',
      { cells: [{ roleId: 'admin', functionId: 'nope', expected: 'allow' }] },
    ],
    [
      'a cell object that is not declared',
      {
        cells: [
          {
            roleId: 'customer',
            functionId: 'view_basket',
            objectId: 'basket_99',
            expected: 'allow',
          },
        ],
      },
    ],
    [
      'a duplicate (role, function, object) cell',
      {
        cells: [
          { roleId: 'admin', functionId: 'list_users', expected: 'allow' },
          { roleId: 'admin', functionId: 'list_users', expected: 'deny' },
        ],
      },
    ],
    [
      'a conditional expectation (not asserted)',
      { cells: [{ roleId: 'admin', functionId: 'list_users', expected: 'conditional' }] },
    ],
    ['a duplicate role', { roles: ['admin', 'admin'] }],
    [
      'a duplicate function',
      {
        functions: [
          { id: 'list_users', method: 'GET', pathTemplate: '/a' },
          { id: 'list_users', method: 'GET', pathTemplate: '/b' },
        ],
      },
    ],
    [
      'an object owned by an undeclared role',
      { objects: [{ id: 'basket_7', ownerRoleId: 'ghost' }] },
    ],
    ['a version below 1', { version: 0 }],
    ['an empty role list', { roles: [] }],
    ['an uppercase role id', { roles: ['Admin'] }],
    ['an extra top-level key (a credential smuggled in)', { credentials: { admin: 'hunter2' } }],
    [
      'an extra function key',
      { functions: [{ id: 'list_users', method: 'GET', pathTemplate: '/a', password: 'x' }] },
    ],
  ])('refuses %s', (_label, overrides) => {
    expect(AuthorisationMatrixSchema.safeParse(rawMatrix(overrides)).success).toBe(false);
  });

  it.each([
    ['a full URL', 'https://target.example/api/users'],
    ['a host-relative path', '//target.example/api'],
    ['a query string', '/api/users?id=1'],
    ['a fragment', '/api/users#x'],
    ['a dot segment', '/api/../admin'],
    ['no leading slash', 'api/users'],
    ['a control character', '/api/\u0007users'],
  ])('refuses a path template that is %s', (_label, pathTemplate) => {
    const raw = rawMatrix({
      functions: [{ id: 'list_users', method: 'GET', pathTemplate }],
      cells: [],
    });
    expect(AuthorisationMatrixSchema.safeParse(raw).success).toBe(false);
  });

  it('throws AuthzMatrixError with the first violation', () => {
    const raw = rawMatrix({
      cells: [{ roleId: 'ghost', functionId: 'list_users', expected: 'deny' }],
    });
    expect(() => parseAuthorisationMatrix(raw)).toThrow(AuthzMatrixError);
  });
});

describe('deriveAuthorisationMatrix', () => {
  it('derives roles, functions and cells from a role_matrices row', () => {
    const matrix = deriveAuthorisationMatrix({ version: 3, matrix: storedPayload() });
    expect(matrix.version).toBe(3);
    expect(matrix.roles).toEqual(['anonymous', 'customer', 'admin']);
    expect(matrix.functions).toEqual([
      { id: 'view_own_basket', method: 'GET', pathTemplate: '/rest/basket/{id}' },
      { id: 'list_users', method: 'GET', pathTemplate: '/api/Users' },
    ]);
    expect(matrix.cells).toHaveLength(6);
    expect(resolveExpectedAccess(matrix, 'customer', 'list_users')).toBe('deny');
    expect(resolveExpectedAccess(matrix, 'admin', 'list_users')).toBe('allow');
  });

  it('leaves a conditional cell undeclared, so it reads as unknown', () => {
    const payload = storedPayload({
      functions: [
        {
          function: 'list_users',
          method: 'GET',
          path: '/api/Users',
          expected: { anonymous: 'conditional', customer: 'deny', admin: 'allow' },
        },
      ],
    });
    const matrix = deriveAuthorisationMatrix({ version: 1, matrix: payload });
    expect(resolveExpectedAccess(matrix, 'anonymous', 'list_users')).toBe('unknown');
  });

  it('leaves a role absent from a function expectation undeclared', () => {
    const payload = storedPayload({
      functions: [
        { function: 'list_users', method: 'GET', path: '/api/Users', expected: { admin: 'allow' } },
      ],
    });
    const matrix = deriveAuthorisationMatrix({ version: 1, matrix: payload });
    expect(matrix.cells).toEqual([
      { roleId: 'admin', functionId: 'list_users', expected: 'allow' },
    ]);
    expect(resolveExpectedAccess(matrix, 'customer', 'list_users')).toBe('unknown');
  });

  it('refuses an expectation for a role the payload does not declare', () => {
    const payload = storedPayload({
      functions: [
        { function: 'list_users', method: 'GET', path: '/api/Users', expected: { root: 'allow' } },
      ],
    });
    expect(() => deriveAuthorisationMatrix({ version: 1, matrix: payload })).toThrow(
      /undeclared role root/,
    );
  });

  it('refuses a payload with an extra key, so credentials cannot ride along', () => {
    const payload = storedPayload({ credentials: { customer: { password: 'hunter2' } } });
    expect(() => deriveAuthorisationMatrix({ version: 1, matrix: payload })).toThrow(
      AuthzMatrixError,
    );
  });

  it('refuses a payload that is not an object or has the wrong shape', () => {
    expect(() => deriveAuthorisationMatrix({ version: 1, matrix: null })).toThrow(AuthzMatrixError);
    expect(() =>
      deriveAuthorisationMatrix({ version: 1, matrix: { roles: 'admin', functions: [] } }),
    ).toThrow(AuthzMatrixError);
  });

  it('refuses a version below 1', () => {
    expect(() => deriveAuthorisationMatrix({ version: 0, matrix: storedPayload() })).toThrow(
      AuthzMatrixError,
    );
  });

  it('keeps credential values out of the model entirely', () => {
    const canary = 'CANARY-s3cret-value-7f3a';
    const matrix = deriveAuthorisationMatrix({ version: 1, matrix: storedPayload() });
    expect(JSON.stringify(matrix)).not.toContain(canary);
    expect(JSON.stringify(matrix)).not.toMatch(/password|secret|token|cookie/i);
  });
});

describe('projectMatrix', () => {
  it('projects roles × functions × objects, marking undeclared cells unknown', () => {
    // Objects are a grid dimension for every function: 3 roles × 3 functions × 1 object.
    const projection = projectMatrix(sampleMatrix());
    expect(projection).toHaveLength(9);
    const cell = projection.find(
      (candidate) =>
        candidate.roleId === 'customer' &&
        candidate.functionId === 'view_basket' &&
        candidate.objectId === 'basket_7',
    );
    expect(cell?.expected).toBe('allow');
    const declaredDeny = projection.find(
      (candidate) => candidate.roleId === 'anonymous' && candidate.functionId === 'list_users',
    );
    expect(declaredDeny?.expected).toBe('deny');
    const undeclared = projection.find(
      (candidate) => candidate.roleId === 'anonymous' && candidate.functionId === 'view_basket',
    );
    expect(undeclared?.expected).toBe('unknown');
  });

  it('marks a cell unknown when the matrix does not declare it', () => {
    const matrix = sampleMatrix({ cells: [] });
    expect(projectMatrix(matrix).every((cell) => cell.expected === 'unknown')).toBe(true);
    expect(resolveExpectedAccess(matrix, 'admin', 'list_users')).toBe('unknown');
  });

  it('projects a function-level grid when no objects are declared', () => {
    const matrix = sampleMatrix({ objects: undefined, cells: [] });
    expect(projectMatrix(matrix)).toHaveLength(9);
    expect(projectMatrix(matrix).every((cell) => cell.objectId === undefined)).toBe(true);
  });
});

describe('authzMatrixCellSamples', () => {
  it('counts declared cells per expected access, for the load-time metric', () => {
    expect(AUTHZ_MATRIX_CELLS_METRIC).toBe('authz_matrix_cells_total');
    expect(AUTHZ_MATRIX_CELLS_METRIC_LABELS).toEqual(['expected']);
    expect(authzMatrixCellSamples(sampleMatrix())).toEqual([
      { labels: { expected: 'allow' }, value: 5 },
      { labels: { expected: 'deny' }, value: 3 },
    ]);
  });
});

describe('access-matrix oracle binding', () => {
  const check = {
    functionId: 'view_basket',
    objectId: 'basket_7',
    actingRole: 'admin',
    comparisonRoles: ['customer'],
    expected: 'deny',
  } as const;

  it('declares one PLAN access_matrix binding that validates against the shared oracle schema', () => {
    const binding = accessMatrixBinding(sampleMatrix(), check, DECLARED_AT);
    expect(binding).toEqual({
      type: 'access_matrix',
      declaredAt: DECLARED_AT,
      params: {
        functionId: 'view_basket',
        objectId: 'basket_7',
        actingRole: 'admin',
        comparisonRoles: ['customer'],
        expected: 'deny',
      },
    });
    expect(OracleBindingSchema.safeParse(binding).success).toBe(true);
  });

  it('declares a function-level binding without an object', () => {
    const functionLevel = {
      functionId: check.functionId,
      actingRole: check.actingRole,
      comparisonRoles: check.comparisonRoles,
      expected: check.expected,
    };
    const binding = accessMatrixBinding(sampleMatrix(), functionLevel, DECLARED_AT);
    expect(binding.type === 'access_matrix' && 'objectId' in binding.params).toBe(false);
  });

  it('refuses an acting role among its own comparison roles', () => {
    expect(() =>
      accessMatrixBinding(sampleMatrix(), { ...check, comparisonRoles: ['admin'] }, DECLARED_AT),
    ).toThrow(AuthzMatrixError);
  });

  it('refuses an empty, a repeated or an oversized comparison set', () => {
    const manyRoles = Array.from({ length: 9 }, (_, i) => `role_${i}`);
    const wide = sampleMatrix({ roles: ['anonymous', 'admin', 'customer', ...manyRoles] });
    expect(() => accessMatrixBinding(wide, { ...check, comparisonRoles: [] }, DECLARED_AT)).toThrow(
      AuthzMatrixError,
    );
    expect(() =>
      accessMatrixBinding(
        wide,
        { ...check, comparisonRoles: ['customer', 'customer'] },
        DECLARED_AT,
      ),
    ).toThrow(AuthzMatrixError);
    expect(() =>
      accessMatrixBinding(wide, { ...check, comparisonRoles: manyRoles }, DECLARED_AT),
    ).toThrow(AuthzMatrixError);
  });

  it('refuses an id the matrix does not declare, so an oracle names only real cells', () => {
    const matrix = sampleMatrix();
    expect(() =>
      accessMatrixBinding(matrix, { ...check, functionId: 'nope' }, DECLARED_AT),
    ).toThrow(/undeclared function/);
    expect(() =>
      accessMatrixBinding(matrix, { ...check, objectId: 'basket_99' }, DECLARED_AT),
    ).toThrow(/undeclared object/);
    expect(() =>
      accessMatrixBinding(matrix, { ...check, actingRole: 'ghost' }, DECLARED_AT),
    ).toThrow(/undeclared role/);
  });

  it('refuses a bad declaration time and an expectation other than allow or deny', () => {
    expect(() => accessMatrixBinding(sampleMatrix(), check, 'yesterday')).toThrow(AuthzMatrixError);
    const ambiguous: Record<string, unknown> = { ...check, expected: 'ambiguous' };
    expect(() =>
      accessMatrixBinding(sampleMatrix(), ambiguous as unknown as typeof check, DECLARED_AT),
    ).toThrow(AuthzMatrixError);
  });
});

describe('negative-control templates', () => {
  it('defines a template for each of the four access-control classes', () => {
    expect(Object.keys(NEGATIVE_CONTROL_TEMPLATES).sort()).toEqual(
      [...ACCESS_CONTROL_CLASSES].sort(),
    );
    for (const cls of ACCESS_CONTROL_CLASSES) {
      const template = NEGATIVE_CONTROL_TEMPLATES[cls];
      expect(template.class).toBe(cls);
      expect(template.strategy).toBe('compliant_variant');
      expect(template.controlExpected).toBe('allow');
    }
  });

  it('picks a peer that the matrix allows on the same function, never the acting role', () => {
    const matrix = sampleMatrix();
    const control = selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.function_access, {
      functionId: 'search_products',
      actingRole: 'anonymous',
    });
    expect(control).toBe('customer');
    expect(
      selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.function_access, {
        functionId: 'list_users',
        actingRole: 'customer',
      }),
    ).toBe('admin');
  });

  it('offers no control when no other role is allowed on the function', () => {
    expect(
      selectControlRole(sampleMatrix(), NEGATIVE_CONTROL_TEMPLATES.privilege_escalation, {
        functionId: 'list_users',
        actingRole: 'admin',
      }),
    ).toBeUndefined();
  });

  it('picks the object owner for an object-level class, when the owner is allowed on the object', () => {
    expect(
      selectControlRole(sampleMatrix(), NEGATIVE_CONTROL_TEMPLATES.object_access, {
        functionId: 'view_basket',
        objectId: 'basket_7',
        actingRole: 'admin',
      }),
    ).toBe('customer');
  });

  it('offers no owner control for the owner itself, an undeclared owner, or an owner the matrix denies', () => {
    const matrix = sampleMatrix();
    expect(
      selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.object_access, {
        functionId: 'view_basket',
        objectId: 'basket_7',
        actingRole: 'customer',
      }),
    ).toBeUndefined();
    expect(
      selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.object_access, {
        functionId: 'view_basket',
        objectId: 'basket_404',
        actingRole: 'admin',
      }),
    ).toBeUndefined();
    const denied = sampleMatrix({
      cells: [
        { roleId: 'customer', functionId: 'view_basket', objectId: 'basket_7', expected: 'deny' },
      ],
    });
    expect(
      selectControlRole(denied, NEGATIVE_CONTROL_TEMPLATES.object_access, {
        functionId: 'view_basket',
        objectId: 'basket_7',
        actingRole: 'admin',
      }),
    ).toBeUndefined();
  });
});
