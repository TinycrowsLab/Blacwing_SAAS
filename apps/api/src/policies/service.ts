// Tenant policy sets (POLICY-001, CONTEXT_PACK §8.6, §8.8, §8.11). The service composes the tenant's policy
// versions into the effective set the engine (POLICY-006) reads: the platform baseline first, then the tenant's
// active version. It never touches another tenant: every call is scoped to the principal's own tenant, and
// every write needs both the RBAC permission and the Cedar resource check. Activation and rollback refuse any
// version that does not validate, and a tenant with no active version stays on the baseline alone.

import { LIMITS } from '@blackwing/contracts';
import {
  PolicyVersionNotFoundError,
  type ActivationResult,
  type PolicyVersion,
  type PolicyVersionSummary,
  type TenantPolicyRepository,
} from '@blackwing/db';
import { hasPermission, permissionsForRoles } from '@blackwing/domain';
import { AppError, ForbiddenError, ValidationError } from '@blackwing/errors';
import {
  assembleEffectivePolicySet,
  canonicalPolicySource,
  type EffectivePolicySet,
  policySourceSha256,
  validatePolicies,
  type ValidationResult,
} from '@blackwing/policy';

import {
  createTenantPolicyEngine,
  type PolicyAction,
  type TenantPolicyEngine,
} from './policy-engine.js';

import type { TenantPolicyMetrics } from './metrics.js';
import type { Logger } from '@blackwing/logger';

/** The store the service needs: the tenant-scoped repository of `@blackwing/db`. */
export type TenantPolicyStore = Pick<
  TenantPolicyRepository,
  'getActive' | 'getVersion' | 'listVersions' | 'createVersion' | 'activate' | 'rollback'
>;

/** The authenticated caller. `tenantId` is the tenant the caller acts in; absent means fail closed. */
export interface TenantPolicyPrincipal {
  readonly id: string;
  readonly tenantId: string | null;
  readonly roles: readonly string[];
}

export interface TenantPolicyServiceDeps {
  readonly store: TenantPolicyStore;
  readonly metrics: TenantPolicyMetrics;
  readonly logger: Pick<Logger, 'info'>;
  /** Cedar resource check; defaults to the shipped tenant policy engine. */
  readonly engine?: TenantPolicyEngine;
  /** Validation of a tenant source before it can become active; defaults to Cedar strict validation. */
  readonly validate?: (source: string) => ValidationResult;
}

export interface CreatePolicyVersionInput {
  readonly source: string;
  readonly note?: string | null;
}

/** The stable detail of a refused activation: the first validator messages, never the whole source. */
const MAX_REPORTED_VALIDATION_ERRORS = 5;

/** Strict Cedar validation of the tenant text, plus the reserved baseline id namespace (`baseline.`). */
function validateTenantPolicySource(source: string): ValidationResult {
  if (canonicalPolicySource(source) === '') return { ok: true, errors: [] };
  const errors: string[] = [];
  if (/@id\(\s*"baseline\./u.test(source)) {
    errors.push('the "baseline." id namespace is reserved for the platform');
  }
  const cedar = validatePolicies(source);
  if (!cedar.ok) errors.push(...cedar.errors);
  return { ok: errors.length === 0, errors };
}

/** Tenant policy versions and the effective set, behind RBAC and Cedar. */
export class TenantPolicyService {
  private readonly engine: TenantPolicyEngine;
  private readonly validate: (source: string) => ValidationResult;

  constructor(private readonly deps: TenantPolicyServiceDeps) {
    this.engine = deps.engine ?? createTenantPolicyEngine();
    this.validate = deps.validate ?? validateTenantPolicySource;
  }

  /** Appends a version. The source is stored in canonical form; the stored content is never changed afterwards. */
  async createVersion(
    principal: TenantPolicyPrincipal,
    input: CreatePolicyVersionInput,
  ): Promise<PolicyVersion> {
    const tenantId = this.writeTenant(principal, 'edit');
    if (Buffer.byteLength(input.source, 'utf8') > LIMITS.policySourceMaxBytes) {
      throw new AppError('POLICY_SOURCE_TOO_LARGE', 'policy source exceeds the size cap', {
        detail: `The policy source is larger than ${String(LIMITS.policySourceMaxBytes)} bytes.`,
      });
    }
    if ((input.note?.length ?? 0) > LIMITS.policyNoteMax) {
      throw new ValidationError('note too long', {
        detail: `The note is longer than ${String(LIMITS.policyNoteMax)} characters.`,
      });
    }
    const cedarSource = canonicalPolicySource(input.source);
    const sha256 = policySourceSha256(cedarSource);
    const record = await this.deps.store.createVersion({
      tenantId,
      cedarSource,
      sha256,
      note: input.note ?? null,
      actorId: principal.id,
    });
    this.deps.metrics.versions.inc();
    this.deps.logger.info({ tenantId, version: record.version, sha256 }, 'policy.version.created');
    return record;
  }

  /** Makes a validated version the active one. A version that fails validation is refused and never activated. */
  async activate(
    principal: TenantPolicyPrincipal,
    input: { readonly version: number; readonly expectedActiveVersion: number | null },
  ): Promise<ActivationResult> {
    const tenantId = this.writeTenant(principal, 'edit');
    const target = await this.requireValidVersion(tenantId, input.version);
    const result = await this.deps.store.activate({
      tenantId,
      version: target.version,
      expectedActiveVersion: input.expectedActiveVersion,
      actorId: principal.id,
    });
    if (result.changed) {
      this.deps.metrics.activations.inc({ kind: 'activated' });
      this.deps.logger.info(
        { tenantId, version: target.version, sha256: target.sha256 },
        'policy.activated',
      );
    }
    return result;
  }

  /** Moves the active pointer back to an earlier validated version. History is kept. */
  async rollback(
    principal: TenantPolicyPrincipal,
    input: { readonly toVersion: number },
  ): Promise<ActivationResult> {
    const tenantId = this.writeTenant(principal, 'edit');
    const active = await this.deps.store.getActive(tenantId);
    if (active === undefined) {
      throw new AppError('POLICY_NO_ACTIVE_VERSION', 'no active policy version to roll back from', {
        detail: 'The tenant has no active policy version; there is nothing to roll back from.',
      });
    }
    if (input.toVersion >= active.version) {
      throw new AppError(
        'POLICY_ROLLBACK_TARGET_NOT_EARLIER',
        'rollback target is not earlier than the active version',
        { detail: 'A rollback must name an earlier version than the active one.' },
      );
    }
    const target = await this.requireValidVersion(tenantId, input.toVersion);
    const result = await this.deps.store.rollback({
      tenantId,
      toVersion: target.version,
      expectedActiveVersion: active.version,
      actorId: principal.id,
    });
    if (result.changed) {
      this.deps.metrics.activations.inc({ kind: 'rolled_back' });
      this.deps.logger.info(
        { tenantId, version: target.version, sha256: target.sha256 },
        'policy.rolled_back',
      );
    }
    return result;
  }

  /** The active version of the caller's tenant, or `undefined` (baseline only). */
  async getActive(principal: TenantPolicyPrincipal): Promise<PolicyVersion | undefined> {
    return this.deps.store.getActive(this.readTenant(principal));
  }

  /** One version of the caller's tenant; another tenant's version is not found. */
  async getVersion(principal: TenantPolicyPrincipal, version: number): Promise<PolicyVersion> {
    const found = await this.deps.store.getVersion(this.readTenant(principal), version);
    if (found === undefined) throw new PolicyVersionNotFoundError(version);
    return found;
  }

  /** The caller's tenant history, newest first, without source text. */
  async listVersions(
    principal: TenantPolicyPrincipal,
    limit = 50,
  ): Promise<readonly PolicyVersionSummary[]> {
    return this.deps.store.listVersions(this.readTenant(principal), limit);
  }

  /**
   * The effective set the engine reads: the baseline first, then the tenant's active version. A tenant with no
   * active version gets the baseline alone, never an empty set.
   */
  async getEffectivePolicySet(principal: TenantPolicyPrincipal): Promise<EffectivePolicySet> {
    const active = await this.deps.store.getActive(this.readTenant(principal));
    return assembleEffectivePolicySet(
      active === undefined
        ? null
        : { version: active.version, sha256: active.sha256, cedarSource: active.cedarSource },
    );
  }

  private async requireValidVersion(tenantId: string, version: number): Promise<PolicyVersion> {
    const target = await this.deps.store.getVersion(tenantId, version);
    if (target === undefined) throw new PolicyVersionNotFoundError(version);
    const validation = this.validate(target.cedarSource);
    if (!validation.ok) {
      throw new AppError('POLICY_VALIDATION_FAILED', 'policy version failed validation', {
        detail: validation.errors.slice(0, MAX_REPORTED_VALIDATION_ERRORS).join('; '),
      });
    }
    return target;
  }

  /** Read path: a tenant is required, then RBAC `policy:read` and the Cedar check. */
  private readTenant(principal: TenantPolicyPrincipal): string {
    return this.authorise(principal, 'read', 'policy:read');
  }

  /** Write path: a tenant is required, then RBAC `policy:write` and the Cedar `edit` check. */
  private writeTenant(principal: TenantPolicyPrincipal, action: PolicyAction): string {
    return this.authorise(principal, action, 'policy:write');
  }

  private authorise(
    principal: TenantPolicyPrincipal,
    action: PolicyAction,
    permission: 'policy:read' | 'policy:write',
  ): string {
    if (principal.tenantId === null) {
      throw new AppError('TENANT_CONTEXT_MISSING', 'no tenant context', {
        detail: 'The request has no tenant context.',
      });
    }
    const permissions = permissionsForRoles(principal.roles);
    if (!hasPermission(principal.roles, permission)) {
      throw new ForbiddenError(`missing ${permission}`);
    }
    const decision = this.engine.authorize(
      { id: principal.id, tenantId: principal.tenantId, permissions: [...permissions] },
      action,
      principal.tenantId,
    );
    if (decision.decision !== 'allow') throw new ForbiddenError('tenant policy resource denied');
    return principal.tenantId;
  }
}
