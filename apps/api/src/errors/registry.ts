import { ERROR_CODE_LIST, ERROR_CODES, type ErrorCode, PROBLEM_TYPE_BASE } from '@blackwing/errors';

/** What the API records for one wire code (API-004, §9). */
export interface ProblemRegistryEntry {
  /** HTTP status of every response with this code. */
  readonly status: number;
  /** Constant, human-readable title (English, v1). */
  readonly title: string;
  /** Appended to `https://errors.blackwing.dev/` to form the problem `type`. */
  readonly typeSuffix: string;
}

/** Definition passed to {@link ProblemRegistry.register}; `typeSuffix` defaults to the code. */
export interface ProblemRegistration {
  readonly status: number;
  readonly title: string;
  readonly typeSuffix?: string;
}

/** Wire codes are stable snake_case keys: they appear in bodies, metrics and client code. */
const WIRE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MIN_ERROR_STATUS = 400;
const MAX_ERROR_STATUS = 599;

/**
 * Base wire codes (CONTEXT_PACK §9). Statuses are the contract; a unit test pins each. Includes the
 * codes that exist only at the HTTP layer (`precondition_required`, `idempotency_conflict`, and the
 * generic transport errors Nest/Fastify raise before any handler runs).
 */
export const BASE_PROBLEM_CODES = {
  validation_failed: { status: 422, title: 'Validation failed' },
  unauthenticated: { status: 401, title: 'Authentication required' },
  permission_denied: { status: 403, title: 'Permission denied' },
  not_found: { status: 404, title: 'Resource not found' },
  conflict: { status: 409, title: 'Conflict' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  precondition_required: { status: 428, title: 'Precondition required' },
  rate_limited: { status: 429, title: 'Too many requests' },
  idempotency_conflict: { status: 409, title: 'Idempotency key conflict' },
  // List endpoints (API-005): a forged, stale or mismatched cursor; a filter/sort outside the allowlist.
  invalid_cursor: { status: 400, title: 'Invalid cursor' },
  invalid_filter: { status: 400, title: 'Invalid filter' },
  // Fail closed (§8.6): a tenant-scoped path ran without tenant context.
  tenant_context_missing: { status: 500, title: 'Tenant context missing' },
  internal_error: { status: 500, title: 'Internal server error' },
  // Transport-level errors raised by Nest/Fastify (malformed JSON, unknown route, oversized body...).
  bad_request: { status: 400, title: 'Bad request' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, ProblemRegistration>;

export type BaseProblemCode = keyof typeof BASE_PROBLEM_CODES;

/** FOUND codes whose wire name differs from the lower-cased key. */
const FOUND_WIRE_OVERRIDES: Readonly<Partial<Record<ErrorCode, string>>> = {
  FORBIDDEN: 'permission_denied',
  INTERNAL: 'internal_error',
};

/** The wire code of a FOUND `AppError` code: `NOT_FOUND` -> `not_found`, `FORBIDDEN` -> `permission_denied`. */
export function wireCodeFor(code: ErrorCode): string {
  return FOUND_WIRE_OVERRIDES[code] ?? code.toLowerCase();
}

/** The code -> {status, title, typeSuffix} registry. Extensible by modules via `register`. */
export class ProblemRegistry {
  readonly #entries = new Map<string, ProblemRegistryEntry>();

  #internal(): ProblemRegistryEntry {
    const entry = this.#entries.get('internal_error');
    if (entry === undefined)
      throw new Error('internal_error must be seeded in the problem registry');
    return entry;
  }

  /**
   * Adds a code. Re-registering an identical entry is a no-op; a conflicting one throws (codes are
   * public API and are never redefined). Invalid wire codes, statuses and titles throw at startup.
   */
  register(code: string, entry: ProblemRegistration): void {
    if (!WIRE_CODE.test(code)) throw new RangeError(`invalid problem code "${code}"`);
    if (
      !Number.isInteger(entry.status) ||
      entry.status < MIN_ERROR_STATUS ||
      entry.status > MAX_ERROR_STATUS
    )
      throw new RangeError(`invalid status for problem code "${code}"`);
    if (entry.title.trim() === '') throw new RangeError(`empty title for problem code "${code}"`);
    const full: ProblemRegistryEntry = Object.freeze({
      status: entry.status,
      title: entry.title,
      typeSuffix: entry.typeSuffix ?? code,
    });
    const existing = this.#entries.get(code);
    if (existing !== undefined) {
      if (
        existing.status === full.status &&
        existing.title === full.title &&
        existing.typeSuffix === full.typeSuffix
      )
        return;
      throw new Error(`problem code "${code}" is already registered with a different definition`);
    }
    this.#entries.set(code, full);
  }

  has(code: string): boolean {
    return this.#entries.has(code);
  }

  /** The entry for `code`, or `undefined` when unregistered. */
  get(code: string): ProblemRegistryEntry | undefined {
    return this.#entries.get(code);
  }

  /** The entry for `code`, falling back to `internal_error`. Never throws. */
  resolve(code: string): { readonly code: string; readonly entry: ProblemRegistryEntry } {
    const entry = this.#entries.get(code);
    if (entry !== undefined) return { code, entry };
    return {
      code: 'internal_error',
      entry: this.#internal(),
    };
  }

  codes(): readonly string[] {
    return [...this.#entries.keys()];
  }

  /** `https://errors.blackwing.dev/<typeSuffix>`. */
  typeFor(entry: ProblemRegistryEntry): string {
    return `${PROBLEM_TYPE_BASE}${entry.typeSuffix}`;
  }
}

/** A registry seeded with the base codes and every FOUND `AppError` code. */
export function createProblemRegistry(): ProblemRegistry {
  const registry = new ProblemRegistry();
  for (const [code, entry] of Object.entries(BASE_PROBLEM_CODES)) registry.register(code, entry);
  for (const found of ERROR_CODE_LIST) {
    const wire = wireCodeFor(found);
    if (registry.has(wire)) continue;
    const spec = ERROR_CODES[found];
    registry.register(wire, { status: spec.status, title: spec.title });
  }
  return registry;
}

/** The process-wide registry feature modules extend at import/bootstrap time. */
export const problemRegistry: ProblemRegistry = createProblemRegistry();
