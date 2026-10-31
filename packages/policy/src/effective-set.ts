import { BASELINE_VERSION, compilePolicySet, type CompiledPolicySet } from './baseline.js';

/**
 * One tenant's active policy version: the tenant-authored Cedar policies (id → text). The baseline
 * is never part of it; `getEffectivePolicySet` always prepends the platform baseline.
 */
export interface TenantPolicyVersion {
  readonly tenantId: string;
  readonly version: number;
  readonly policies: Readonly<Record<string, string>>;
}

/**
 * Port for the tenant's active policy version (the POLICY-003 table). It is synchronous on purpose:
 * the engine reads a snapshot and never awaits inside a decision, so the same inputs always give the
 * same answer (§8.11). Implementations return `undefined` when the tenant has no active version.
 */
export interface TenantPolicyVersionSource {
  activeVersion(tenantId: string): TenantPolicyVersion | undefined;
}

/** Cache key of a compiled effective set: `(tenantId, baselineVersion, tenantVersion)` (POLICY-010). */
export interface EffectivePolicySetKey {
  readonly tenantId: string;
  readonly baselineVersion: string;
  /** Null when the tenant has no active version and only the baseline applies. */
  readonly tenantVersion: number | null;
}

/**
 * Compiled-set cache behind an interface (POLICY-010 slots in here without touching callers). A
 * miss means the caller recompiles; a cache can never make a deny into an allow.
 */
export interface PolicySetCache {
  get(key: EffectivePolicySetKey): CompiledPolicySet | undefined;
  set(key: EffectivePolicySetKey, value: CompiledPolicySet): void;
}

/** Stable string form of a cache key. The NUL separator cannot occur in a tenant id. */
export function effectivePolicySetKeyString(key: EffectivePolicySetKey): string {
  return [key.tenantId, key.baselineVersion, key.tenantVersion ?? 'baseline-only'].join('\u0000');
}

/** In-process LRU cache. `maxEntries` bounds memory; the least recently used entry is evicted first. */
export function createMemoryPolicySetCache(maxEntries = 256): PolicySetCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive integer');
  }
  const entries = new Map<string, CompiledPolicySet>();
  return {
    get(key) {
      const id = effectivePolicySetKeyString(key);
      const hit = entries.get(id);
      if (hit !== undefined) {
        // Re-insert to mark as most recently used.
        entries.delete(id);
        entries.set(id, hit);
      }
      return hit;
    },
    set(key, value) {
      const id = effectivePolicySetKeyString(key);
      entries.delete(id);
      entries.set(id, value);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.value !== undefined) entries.delete(oldest.value);
      }
    },
  };
}

/** The effective set for one tenant decision, or the reason it could not be built (fail closed). */
export type EffectivePolicySetResult =
  | {
      readonly ok: true;
      readonly set: CompiledPolicySet;
      readonly tenantVersion: number | null;
      readonly cacheHit: boolean;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Assembles the effective policy set for `tenantId`: the platform baseline first, then the tenant's
 * active version (if any). With no active version the result is baseline-only, never empty.
 *
 * Fails closed: a version that belongs to another tenant, a source that throws, or a set that does
 * not compile (corrupt or tampered stored source) all return `ok: false`. The engine turns that into
 * a `deny` with `errored: true`.
 */
export function getEffectivePolicySet(
  tenantId: string,
  source: TenantPolicyVersionSource,
  cache: PolicySetCache,
): EffectivePolicySetResult {
  let version: TenantPolicyVersion | undefined;
  try {
    version = source.activeVersion(tenantId);
  } catch (err) {
    return { ok: false, errors: [`policy version lookup failed: ${describe(err)}`] };
  }
  if (version !== undefined && version.tenantId !== tenantId) {
    return { ok: false, errors: ['policy version belongs to another tenant'] };
  }
  const key: EffectivePolicySetKey = {
    tenantId,
    baselineVersion: BASELINE_VERSION,
    tenantVersion: version?.version ?? null,
  };
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { ok: true, set: cached, tenantVersion: key.tenantVersion, cacheHit: true };
  }
  const compiled = compilePolicySet(version?.policies ?? {});
  if (!compiled.ok) return { ok: false, errors: [...compiled.errors] };
  cache.set(key, compiled);
  return { ok: true, set: compiled, tenantVersion: key.tenantVersion, cacheHit: false };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
