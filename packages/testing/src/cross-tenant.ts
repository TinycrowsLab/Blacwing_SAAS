/**
 * The standard §8.6 cross-tenant test: "tenant B cannot see tenant A's data, and tenant A can".
 *
 * Asserting only the denial is a classic false negative: a broken query, a missing fixture or a wrong
 * connection also returns nothing. So the helper first proves the same-tenant read succeeds and
 * returns data, then proves the other tenant gets nothing (or a denial error).
 */

/** Raised when a cross-tenant check fails or is set up wrong. */
export class CrossTenantAssertionError extends Error {
  /** Which side failed: the setup, the same-tenant read, or the cross-tenant denial. */
  readonly reason:
    | 'misconfigured'
    | 'owner_read_failed'
    | 'owner_read_empty'
    | 'cross_tenant_leak'
    | 'unexpected_error';

  constructor(
    reason: CrossTenantAssertionError['reason'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CrossTenantAssertionError';
    this.reason = reason;
  }
}

/** Options for {@link crossTenantDenied}. */
export interface CrossTenantDeniedOptions {
  /** Tenant that owns the data: its read must succeed and return something. */
  readonly ownerTenantId: string;
  /** Any other tenant: its read must return nothing or throw a denial. */
  readonly otherTenantId: string;
  /** Describes what was read, for failure messages (e.g. `"rls_probe row"`). */
  readonly subject?: string;
  /** Which thrown errors count as a denial. Defaults to {@link isDenialError}. */
  readonly isDenial?: (error: unknown) => boolean;
}

/** Result of a passing check. */
export interface CrossTenantDeniedResult<T> {
  /** What the owner's read returned (non-empty). */
  readonly ownerResult: T;
  /** How the other tenant was denied. */
  readonly denial: 'empty' | 'error';
}

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const DENIAL_CODES = new Set([
  // Postgres insufficient_privilege: RLS WITH CHECK violations and missing grants.
  '42501',
  // AppError codes used by repositories and the API for "not yours" (problem+json, §9).
  'NOT_FOUND',
  'FORBIDDEN',
  'TENANT_ACCESS_DENIED',
]);

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Default denial classifier: a Postgres `insufficient_privilege` error (`42501`), or an error whose
 * `code` is `NOT_FOUND` / `FORBIDDEN` / `TENANT_ACCESS_DENIED`, or whose `httpStatus`/`status` is 403
 * or 404. Anything else (syntax errors, connection failures) is *not* a denial.
 */
export function isDenialError(error: unknown): boolean {
  const code = field(error, 'code');
  if (typeof code === 'string' && DENIAL_CODES.has(code)) return true;
  const status = field(error, 'httpStatus') ?? field(error, 'status');
  return status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND;
}

/**
 * True when a read result means "nothing visible": `null`/`undefined`, `false`, `0`, an empty array,
 * Map or Set, a pg `QueryResult` with no rows, or a Neo4j result with no records.
 */
export function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  const rows = field(value, 'rows');
  if (Array.isArray(rows)) return rows.length === 0;
  const records = field(value, 'records');
  if (Array.isArray(records)) return records.length === 0;
  return false;
}

/**
 * Runs `read` as the owner and as another tenant and asserts isolation in both directions:
 *
 * 1. the owner's read must not throw and must return data (otherwise the denial proves nothing);
 * 2. the other tenant's read must return an empty result or throw a denial error.
 *
 * Throws {@link CrossTenantAssertionError} otherwise. Works for any data-access path (SQL via
 * `withTenant`, a repository, a Neo4j guard, an HTTP call) because `read` decides how to use the id.
 */
export async function crossTenantDenied<T>(
  read: (tenantId: string) => Promise<T>,
  options: CrossTenantDeniedOptions,
): Promise<CrossTenantDeniedResult<T>> {
  const { ownerTenantId, otherTenantId } = options;
  const subject = options.subject ?? 'tenant data';
  const isDenial = options.isDenial ?? isDenialError;
  if (ownerTenantId.length === 0 || otherTenantId.length === 0 || ownerTenantId === otherTenantId) {
    throw new CrossTenantAssertionError(
      'misconfigured',
      'crossTenantDenied needs two distinct, non-empty tenant ids',
    );
  }

  let ownerResult: T;
  try {
    ownerResult = await read(ownerTenantId);
  } catch (error) {
    throw new CrossTenantAssertionError(
      'owner_read_failed',
      `the owning tenant could not read its own ${subject}; a denial for the other tenant would prove nothing`,
      { cause: error },
    );
  }
  if (isEmptyResult(ownerResult)) {
    throw new CrossTenantAssertionError(
      'owner_read_empty',
      `the owning tenant's read of its own ${subject} returned nothing; seed the data first, or the denial is a false negative`,
    );
  }

  let otherResult: T;
  try {
    otherResult = await read(otherTenantId);
  } catch (error) {
    if (isDenial(error)) return { ownerResult, denial: 'error' };
    throw new CrossTenantAssertionError(
      'unexpected_error',
      `the other tenant's read of ${subject} failed with an error that is not a tenant denial`,
      { cause: error },
    );
  }
  if (!isEmptyResult(otherResult)) {
    throw new CrossTenantAssertionError(
      'cross_tenant_leak',
      `another tenant could read ${subject} (§8.6 violation)`,
    );
  }
  return { ownerResult, denial: 'empty' };
}
