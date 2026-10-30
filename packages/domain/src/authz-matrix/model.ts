import { z } from 'zod';

import {
  authzIdSchema,
  LIMITS,
  type OracleBinding,
  OracleBindingSchema,
  roleIdSchema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

/**
 * The multi-role authorisation matrix (F9; AUTHLOGIC-002, CONTEXT_PACK §7). It declares, per role, function and
 * optional object, the access the asset is expected to grant. The execution engine (AUTHLOGIC-003) replays each
 * declared cell with real role sessions and compares the observed access with the expectation.
 *
 * The model holds identifiers and expectations only. Roles reference a session by id, never a credential, and
 * every object is strict, so a secret field cannot be smuggled in (CONTEXT_PACK §8.7). Matrices are tenant-scoped
 * through the `role_matrices` row they come from (§8.6), and `version` pins the matrix a run used (§8.9).
 */

/** Size budgets for one matrix. A larger role matrix is refused rather than truncated. */
export const AUTHZ_MATRIX_LIMITS = Object.freeze({
  roles: 32,
  functions: 256,
  objects: 1024,
  cells: 8192,
});

/** HTTP methods a matrix function may name. An allow-list: no free-form verbs. */
export const AUTHZ_HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
export type AuthzHttpMethod = (typeof AUTHZ_HTTP_METHODS)[number];

/** A declared expectation. A cell that is not declared is never stored: it reads back as `unknown`. */
export const EXPECTED_ACCESS = ['allow', 'deny'] as const;
export type ExpectedAccess = (typeof EXPECTED_ACCESS)[number];

/** Stable error code for a matrix or oracle that fails the schema or its referential checks. */
export class AuthzMatrixError extends AppError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, { detail: message });
    this.name = 'AuthzMatrixError';
  }
}

const methodSchema = z.enum(AUTHZ_HTTP_METHODS);
const expectationSchema = z.enum(EXPECTED_ACCESS);

/** A path template such as `/rest/basket/{id}`: a path only, with no query, fragment, scheme or dot segments. */
const urlTemplateSchema = z
  .string()
  .min(1)
  .max(LIMITS.urlMax)
  .regex(/^\/[A-Za-z0-9._~\-/{}:@!$&'()*+,;=%]*$/, 'must be a path template')
  .refine((value) => !value.startsWith('//'), 'must not be host-relative')
  .refine((value) => !value.split('/').includes('..'), 'must not contain dot segments');

const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/, 'must be an operation id');

/** A function is either a method plus path template, or an operation id from an imported specification. */
export const functionRefSchema = z.union([
  z.strictObject({ id: authzIdSchema, method: methodSchema, pathTemplate: urlTemplateSchema }),
  z.strictObject({ id: authzIdSchema, operationId: operationIdSchema }),
]);
export type FunctionRef = z.output<typeof functionRefSchema>;

/** An object-level resource. `ownerRoleId` names the role that legitimately owns it (the negative control for BOLA). */
export const objectRefSchema = z.strictObject({
  id: authzIdSchema,
  ownerRoleId: roleIdSchema.optional(),
});
export type ObjectRef = z.output<typeof objectRefSchema>;

/** One declared cell. `objectId` is set only for object-level expectations (BOLA, IDOR). */
export const matrixCellSchema = z.strictObject({
  roleId: roleIdSchema,
  functionId: authzIdSchema,
  objectId: authzIdSchema.optional(),
  expected: expectationSchema,
});
export type MatrixCell = z.output<typeof matrixCellSchema>;

const cellKey = (cell: MatrixCell): string =>
  JSON.stringify([cell.roleId, cell.functionId, cell.objectId ?? null]);

/** Rejects duplicate ids and any reference to an undeclared role, function or object. */
function checkReferences(
  matrix: {
    roles: readonly string[];
    functions: readonly { id: string }[];
    objects?: readonly ObjectRef[] | undefined;
    cells: readonly MatrixCell[];
  },
  ctx: z.RefinementCtx,
): void {
  const duplicates = (path: 'roles' | 'functions' | 'objects', ids: readonly string[]) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: [path], message: 'must not repeat ids' });
    }
  };
  duplicates('roles', matrix.roles);
  duplicates(
    'functions',
    matrix.functions.map((fn) => fn.id),
  );
  const objects = matrix.objects ?? [];
  duplicates(
    'objects',
    objects.map((object) => object.id),
  );

  const roles = new Set(matrix.roles);
  const functions = new Set(matrix.functions.map((fn) => fn.id));
  const objectIds = new Set(objects.map((object) => object.id));
  objects.forEach((object, index) => {
    if (object.ownerRoleId !== undefined && !roles.has(object.ownerRoleId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['objects', index, 'ownerRoleId'],
        message: `undeclared role ${object.ownerRoleId}`,
      });
    }
  });

  const keys = new Set<string>();
  matrix.cells.forEach((cell, index) => {
    if (!roles.has(cell.roleId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells', index, 'roleId'],
        message: `undeclared role ${cell.roleId}`,
      });
    }
    if (!functions.has(cell.functionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells', index, 'functionId'],
        message: `undeclared function ${cell.functionId}`,
      });
    }
    if (cell.objectId !== undefined && !objectIds.has(cell.objectId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells', index, 'objectId'],
        message: `undeclared object ${cell.objectId}`,
      });
    }
    const key = cellKey(cell);
    if (keys.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['cells', index], message: 'duplicate cell' });
    }
    keys.add(key);
  });
}

/** The matrix: roles × functions (× objects) → expected access, pinned to one `role_matrices` version. */
export const AuthorisationMatrixSchema = z
  .strictObject({
    version: z.int().min(1).max(LIMITS.int32Max),
    roles: z.array(roleIdSchema).min(1).max(AUTHZ_MATRIX_LIMITS.roles),
    functions: z.array(functionRefSchema).min(1).max(AUTHZ_MATRIX_LIMITS.functions),
    objects: z.array(objectRefSchema).max(AUTHZ_MATRIX_LIMITS.objects).optional(),
    cells: z.array(matrixCellSchema).max(AUTHZ_MATRIX_LIMITS.cells),
  })
  .superRefine(checkReferences);
export type AuthorisationMatrix = z.output<typeof AuthorisationMatrixSchema>;

/** Parses an untrusted matrix (from the database, an import or a test). Fails closed with a stable code. */
export function parseAuthorisationMatrix(json: unknown): AuthorisationMatrix {
  const result = AuthorisationMatrixSchema.safeParse(json);
  if (!result.success) {
    throw new AuthzMatrixError(
      `authorisation matrix is invalid: ${result.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return result.data;
}

/**
 * The matrix as stored in `role_matrices.matrix` (roles × functions → `allow | deny | conditional`, written by the
 * ASSET and PLAN seeds). Strict, so an unknown key fails. A `conditional` entry is not a decision the engine can
 * assert, so it yields no cell and reads back as `unknown`.
 */
const storedRoleMatrixSchema = z.strictObject({
  roles: z.array(roleIdSchema).min(1),
  functions: z.array(
    z.strictObject({
      function: authzIdSchema,
      method: methodSchema,
      path: urlTemplateSchema,
      expected: z.record(roleIdSchema, z.enum(['allow', 'deny', 'conditional'])),
    }),
  ),
});

/** Derives the matrix model from a stored `role_matrices` row. Malformed rows fail closed. */
export function deriveAuthorisationMatrix(row: {
  version: number;
  matrix: unknown;
}): AuthorisationMatrix {
  const parsed = storedRoleMatrixSchema.safeParse(row.matrix);
  if (!parsed.success) {
    throw new AuthzMatrixError('stored role matrix has an unexpected shape');
  }
  const { roles, functions } = parsed.data;
  const cells: MatrixCell[] = [];
  for (const fn of functions) {
    for (const [roleId, access] of Object.entries(fn.expected)) {
      if (access === 'conditional') continue;
      cells.push({ roleId, functionId: fn.function, expected: access });
    }
  }
  return parseAuthorisationMatrix({
    version: row.version,
    roles,
    functions: functions.map((fn) => ({
      id: fn.function,
      method: fn.method,
      pathTemplate: fn.path,
    })),
    cells,
  });
}

function findCell(
  matrix: AuthorisationMatrix,
  roleId: string,
  functionId: string,
  objectId: string | undefined,
): MatrixCell | undefined {
  return matrix.cells.find(
    (cell) =>
      cell.roleId === roleId && cell.functionId === functionId && cell.objectId === objectId,
  );
}

/**
 * The expectation for one cell. An object-level lookup falls back to the function-level cell, so a function-level
 * expectation applies to every object of that function unless an object cell overrides it. A cell with no
 * declaration at all reads back as `unknown`: the engine then reports the observed access without asserting pass
 * or fail, so an incomplete role matrix never produces a verdict.
 */
export function resolveExpectedAccess(
  matrix: AuthorisationMatrix,
  roleId: string,
  functionId: string,
  objectId?: string,
): ExpectedAccess | 'unknown' {
  const exact = findCell(matrix, roleId, functionId, objectId);
  if (exact) return exact.expected;
  if (objectId !== undefined) {
    const functionLevel = findCell(matrix, roleId, functionId, undefined);
    if (functionLevel) return functionLevel.expected;
  }
  return 'unknown';
}

/** One point of the role × function (× object) grid, with its declared expectation or `unknown`. */
export interface ProjectedCell {
  readonly roleId: string;
  readonly functionId: string;
  readonly objectId?: string;
  readonly expected: ExpectedAccess | 'unknown';
}

/**
 * The full grid the engine walks. With objects declared, each function is projected once per object (the object
 * is the grid dimension); with none, once per function.
 */
export function projectMatrix(matrix: AuthorisationMatrix): ProjectedCell[] {
  const objectIds: (string | undefined)[] =
    matrix.objects !== undefined && matrix.objects.length > 0
      ? matrix.objects.map((object) => object.id)
      : [undefined];
  const grid: ProjectedCell[] = [];
  for (const roleId of matrix.roles) {
    for (const fn of matrix.functions) {
      for (const objectId of objectIds) {
        grid.push({
          roleId,
          functionId: fn.id,
          ...(objectId === undefined ? {} : { objectId }),
          expected: resolveExpectedAccess(matrix, roleId, fn.id, objectId),
        });
      }
    }
  }
  return grid;
}

/** The metric the matrix loader reports at load time: declared cells per expectation. */
export const AUTHZ_MATRIX_CELLS_METRIC = 'authz_matrix_cells_total';
export const AUTHZ_MATRIX_CELLS_METRIC_LABELS = ['expected'] as const;

/** Samples for `authz_matrix_cells_total`, one per expectation, so both series exist even when one is zero. */
export function authzMatrixCellSamples(
  matrix: AuthorisationMatrix,
): { labels: { expected: ExpectedAccess }; value: number }[] {
  return EXPECTED_ACCESS.map((expected) => ({
    labels: { expected },
    value: matrix.cells.filter((cell) => cell.expected === expected).length,
  }));
}

/** The four access-control classes the auth-logic specialist tests (BOLA/IDOR, BFLA, privilege escalation, flows). */
export const ACCESS_CONTROL_CLASSES = [
  'function_access',
  'object_access',
  'privilege_escalation',
  'business_flow',
] as const;
export type AccessControlClass = (typeof ACCESS_CONTROL_CLASSES)[number];

/**
 * A negative-control template (F16). The control is a request the matrix says a *correctly* authorised identity
 * may make: a peer role allowed on the same function, or the owner of the object. If the acting role gets the same
 * access and the control is also allowed, the differential is real; a single-role 200 is never a finding.
 */
export interface NegativeControlTemplate {
  readonly class: AccessControlClass;
  readonly strategy: 'compliant_variant';
  readonly controlExpected: 'allow';
  readonly selector: 'object_owner' | 'allowed_peer';
}

export const NEGATIVE_CONTROL_TEMPLATES: Readonly<
  Record<AccessControlClass, NegativeControlTemplate>
> = Object.freeze({
  function_access: {
    class: 'function_access',
    strategy: 'compliant_variant',
    controlExpected: 'allow',
    selector: 'allowed_peer',
  },
  object_access: {
    class: 'object_access',
    strategy: 'compliant_variant',
    controlExpected: 'allow',
    selector: 'object_owner',
  },
  privilege_escalation: {
    class: 'privilege_escalation',
    strategy: 'compliant_variant',
    controlExpected: 'allow',
    selector: 'allowed_peer',
  },
  business_flow: {
    class: 'business_flow',
    strategy: 'compliant_variant',
    controlExpected: 'allow',
    selector: 'allowed_peer',
  },
});

export interface ControlSelector {
  readonly functionId: string;
  readonly objectId?: string;
  readonly actingRole: string;
}

/**
 * The role that serves as the negative control for one cell, or `undefined` when the matrix offers none. The
 * control must be a role the matrix expects to be allowed, and never the acting role itself.
 */
export function selectControlRole(
  matrix: AuthorisationMatrix,
  template: NegativeControlTemplate,
  selector: ControlSelector,
): string | undefined {
  if (template.selector === 'object_owner') {
    if (selector.objectId === undefined) return undefined;
    const owner = matrix.objects?.find((object) => object.id === selector.objectId)?.ownerRoleId;
    if (owner === undefined || owner === selector.actingRole) return undefined;
    return resolveExpectedAccess(matrix, owner, selector.functionId, selector.objectId) === 'allow'
      ? owner
      : undefined;
  }
  return matrix.roles.find(
    (roleId) =>
      roleId !== selector.actingRole &&
      resolveExpectedAccess(matrix, roleId, selector.functionId, selector.objectId) === 'allow',
  );
}

/** One declared access-matrix check, before it is turned into an oracle binding. Ids only. */
export interface AccessMatrixCheck {
  readonly functionId: string;
  readonly objectId?: string;
  readonly actingRole: string;
  readonly comparisonRoles: readonly string[];
  readonly expected: ExpectedAccess;
}

/**
 * Declares the PLAN `access_matrix` oracle for one cell. Every id must exist in the matrix, so an oracle can only
 * name real cells, and the shape must pass the shared oracle schema, so a bad check fails before the test runs.
 */
export function accessMatrixBinding(
  matrix: AuthorisationMatrix,
  check: AccessMatrixCheck,
  declaredAt: string,
): OracleBinding {
  const roles = new Set(matrix.roles);
  const functions = new Set(matrix.functions.map((fn) => fn.id));
  const objects = new Set((matrix.objects ?? []).map((object) => object.id));
  if (!functions.has(check.functionId))
    throw new AuthzMatrixError(`undeclared function ${check.functionId}`);
  if (check.objectId !== undefined && !objects.has(check.objectId)) {
    throw new AuthzMatrixError(`undeclared object ${check.objectId}`);
  }
  for (const roleId of [check.actingRole, ...check.comparisonRoles]) {
    if (!roles.has(roleId)) throw new AuthzMatrixError(`undeclared role ${roleId}`);
  }
  const params = {
    functionId: check.functionId,
    ...(check.objectId === undefined ? {} : { objectId: check.objectId }),
    actingRole: check.actingRole,
    comparisonRoles: [...check.comparisonRoles],
    expected: check.expected,
  };
  const binding = OracleBindingSchema.safeParse({ type: 'access_matrix', declaredAt, params });
  if (!binding.success) {
    throw new AuthzMatrixError(
      `access-matrix oracle is invalid: ${binding.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return binding.data;
}
