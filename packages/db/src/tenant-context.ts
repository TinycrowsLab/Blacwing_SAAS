// The ambient tenant context (TENANT-003, CONTEXT_PACK §7, §8.6, §8.8): one `AsyncLocalStorage` that the
// API, the Temporal worker and the Run Broker all fill at their entry point, and that repositories read
// through `getTenantContextOrThrow()`. This module is deliberately free of `pg` and Drizzle so every
// deployable can import it (`@blackwing/db/tenant-context`).
//
// Rules this file enforces:
//   - the tenant is derived from a validated principal only (`resolveTenantContext`); a request body or
//     an unvalidated claim never reaches it;
//   - a missing, malformed or ambiguous tenant fails closed (`TenantContextMissingError`);
//   - a resource of another tenant is denied and audited (`CrossTenantAccessError`).

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { CrossTenantAccessError, TenantContextMissingError } from '@blackwing/errors';

/** Who acts: a console/IAM user, a service identity (PAT / CI token) or a run (worker, broker). */
export type TenantActorType = 'user' | 'service' | 'run';

export interface TenantActor {
  readonly type: TenantActorType;
  readonly id: string;
}

/** What every tenant-scoped code path runs under. Immutable. */
export interface TenantContext {
  /** Lower-case canonical UUID. */
  readonly tenantId: string;
  readonly actor: TenantActor;
}

const TENANT_HASH_LENGTH = 12;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES: readonly string[] = ['user', 'service', 'run'];

/** A short, non-reversible tenant label for logs, spans and metrics (§8.7). */
export function hashTenantId(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, TENANT_HASH_LENGTH);
}

/**
 * The validated principal an entry point hands over (IAM validates sessions and tokens; this module
 * never does). Each tenant field is one independent, already-validated source: the session JWT's
 * `tenant_id` claim, the tenant a `bw_pat_`/`bw_ci_` token is bound to, the tenant of a run. When more
 * than one is present they must agree.
 */
export interface TenantPrincipal {
  readonly actor: TenantActor;
  readonly sessionTenantId?: string | null | undefined;
  readonly tokenTenantId?: string | null | undefined;
  readonly runTenantId?: string | null | undefined;
}

/** Counters (the entry points wire these to Prometheus; the default is a no-op). */
export interface TenantContextMetrics {
  /** `bw_tenant_context_missing_total`. */
  contextMissing(): void;
  /** `bw_cross_tenant_denied_total`. */
  crossTenantDenied(): void;
}

const NOOP_METRICS: TenantContextMetrics = {
  contextMissing: () => undefined,
  crossTenantDenied: () => undefined,
};

function missing(
  metrics: TenantContextMetrics,
  reason: 'missing' | 'invalid_uuid' | 'ambiguous',
): never {
  metrics.contextMissing();
  throw new TenantContextMissingError(`tenant context could not be resolved (${reason})`, {
    reason,
  });
}

function isPresent(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

function validActor(actor: unknown): actor is TenantActor {
  if (typeof actor !== 'object' || actor === null) return false;
  const { type, id } = actor as { type?: unknown; id?: unknown };
  return (
    typeof type === 'string' && ACTOR_TYPES.includes(type) && typeof id === 'string' && id !== ''
  );
}

/**
 * The single resolution point: validated principal in, `TenantContext` out. No tenant, a tenant that is
 * not a UUID, or two sources that disagree all throw `TenantContextMissingError` and count as missing.
 */
export function resolveTenantContext(
  principal: TenantPrincipal,
  metrics: TenantContextMetrics = NOOP_METRICS,
): TenantContext {
  if (!validActor(principal.actor)) return missing(metrics, 'missing');
  const candidates = [principal.sessionTenantId, principal.tokenTenantId, principal.runTenantId];
  const present = candidates.filter(isPresent);
  const [first] = present;
  if (first === undefined) return missing(metrics, 'missing');
  if (present.some((value) => !CANONICAL_UUID.test(value))) return missing(metrics, 'invalid_uuid');
  const tenantId = first.toLowerCase();
  if (present.some((value) => value.toLowerCase() !== tenantId)) {
    return missing(metrics, 'ambiguous');
  }
  return Object.freeze({
    tenantId,
    actor: Object.freeze({ type: principal.actor.type, id: principal.actor.id }),
  });
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` (and every continuation it starts) with `context` as the ambient tenant. The context is
 * re-validated, so a hand-built one cannot smuggle in a bad tenant. Nested calls shadow the outer
 * context only for the same tenant: re-scoping to another tenant inside a request is refused.
 */
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  const resolved = resolveTenantContext({
    actor: context.actor,
    sessionTenantId: context.tenantId,
  });
  const outer = storage.getStore();
  if (outer !== undefined && outer.tenantId !== resolved.tenantId) {
    throw new TenantContextMissingError('refusing to re-scope an active tenant context', {
      reason: 'ambiguous',
    });
  }
  return storage.run(resolved, fn);
}

/** The ambient context, or `undefined` outside `runWithTenantContext`. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** The ambient context or `TenantContextMissingError`: what a repository calls (fail closed). */
export function getTenantContextOrThrow(
  metrics: TenantContextMetrics = NOOP_METRICS,
): TenantContext {
  const context = storage.getStore();
  if (context === undefined) return missing(metrics, 'missing');
  return context;
}

/** The ambient tenant id, or `undefined`: the default `tenant` source of `BaseRepository`. */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * Memoises one instance per tenant context, for per-request state such as GraphQL DataLoaders: two
 * requests (two contexts) never share an instance, so a batch can never mix tenants. Outside a context
 * it throws, like {@link getTenantContextOrThrow}.
 */
export function perTenantContext<T extends object>(create: (context: TenantContext) => T): () => T {
  const instances = new WeakMap<TenantContext, T>();
  return () => {
    const context = getTenantContextOrThrow();
    let instance = instances.get(context);
    if (instance === undefined) {
      instance = create(context);
      instances.set(context, instance);
    }
    return instance;
  };
}

/** The audit event for a denied cross-tenant access (§8.8). Carries ids, never tokens or content. */
export interface CrossTenantDeniedEvent {
  readonly action: 'tenant.cross_tenant_denied';
  readonly contextTenantId: string;
  readonly resourceTenantId: string;
  readonly actor: TenantActor;
  /** Where it happened: a route, an activity type, a broker endpoint. */
  readonly surface: string;
  /** What was touched, e.g. `run:<id>`; optional. */
  readonly resource?: string;
}

export type CrossTenantAuditEmitter = (event: CrossTenantDeniedEvent) => void | Promise<void>;

/** The logger surface the guard needs (satisfied by `@blackwing/logger`). */
export interface CrossTenantLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface CrossTenantGuardOptions {
  readonly audit: CrossTenantAuditEmitter;
  readonly metrics?: TenantContextMetrics;
  readonly logger?: CrossTenantLogger;
}

export interface CrossTenantGuard {
  /**
   * Passes when `resourceTenantId` equals the ambient tenant; otherwise audits, counts and throws
   * `CrossTenantAccessError`. A failing audit emitter never turns the denial into success: the access
   * is still denied and the audit failure is logged.
   */
  assertSameTenant(
    resourceTenantId: string | null | undefined,
    where: { readonly surface: string; readonly resource?: string },
  ): Promise<void>;
}

/** Builds the explicit tenant cross-check of requirement 6. Audit is mandatory (§8.8). */
export function createCrossTenantGuard(options: CrossTenantGuardOptions): CrossTenantGuard {
  const metrics = options.metrics ?? NOOP_METRICS;
  return {
    async assertSameTenant(resourceTenantId, where) {
      const context = getTenantContextOrThrow(metrics);
      if (
        typeof resourceTenantId === 'string' &&
        resourceTenantId.toLowerCase() === context.tenantId
      ) {
        return;
      }
      metrics.crossTenantDenied();
      const event: CrossTenantDeniedEvent = {
        action: 'tenant.cross_tenant_denied',
        contextTenantId: context.tenantId,
        // A missing resource tenant cannot be proven to be ours: it is denied like any other mismatch.
        resourceTenantId: typeof resourceTenantId === 'string' ? resourceTenantId : '',
        actor: context.actor,
        surface: where.surface,
        ...(where.resource === undefined ? {} : { resource: where.resource }),
      };
      options.logger?.warn(
        {
          event: 'tenant.cross_tenant_denied',
          tenantId: hashTenantId(context.tenantId),
          actorType: context.actor.type,
          route: where.surface,
        },
        'cross-tenant access denied',
      );
      try {
        await options.audit(event);
      } catch (error) {
        options.logger?.error(
          {
            event: 'tenant.cross_tenant_denied.audit_failed',
            errorType: error instanceof Error ? error.name : typeof error,
          },
          'cross-tenant audit event could not be recorded',
        );
      }
      throw new CrossTenantAccessError();
    },
  };
}
