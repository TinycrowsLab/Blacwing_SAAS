// The service-account use cases (RBAC-005): authorisation, role policy, error mapping and logs. The
// data path and the audit event live in the repository (one transaction per change). Every method runs
// for one resolved tenant: the caller's tenant is never taken from a request body (§8.6).

import {
  isServiceAccountRoleAssignable,
  type AuditActor,
  type Permission,
  ROLE_PERMISSIONS,
  type Role,
  type ServiceAccount,
  isServiceAccountRole,
} from '@blackwing/contracts';
import { ForeignKeyError, type RepositoryPage, type ServiceAccountRow } from '@blackwing/db';
import { hashTenantId } from '@blackwing/db/tenant-context';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '@blackwing/errors';

import type {
  ServiceAccountAuditContext,
  ServiceAccountCreateValue,
  ServiceAccountUpdateValue,
} from './repository.js';
import type { ServiceAccountMetrics } from './service-account-metrics.js';

/** Who is asking, inside one resolved tenant. */
export interface ServiceAccountCaller {
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly traceId?: string;
}

/**
 * Resolves the caller's roles in the tenant (IAM membership, RBAC-002). An unresolved caller returns no
 * roles, which denies everything (fail closed).
 */
export type RoleResolver = (caller: ServiceAccountCaller) => Promise<readonly Role[]>;

/** The persistence port: the repository, bound to the ambient tenant. */
export interface ServiceAccountStore {
  insert(
    value: ServiceAccountCreateValue,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow>;
  patch(
    id: string,
    expectedVersion: number,
    changes: ServiceAccountUpdateValue,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow>;
  disable(
    id: string,
    expectedVersion: number,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow>;
  list(options: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<RepositoryPage<ServiceAccountRow>>;
  findById(id: string): Promise<ServiceAccountRow | undefined>;
}

/** Structured-log port (`@blackwing/logger`). Only ids, hashed tenant and actor type are logged. */
export interface ServiceAccountLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface ServiceAccountServiceOptions {
  readonly store: ServiceAccountStore;
  readonly roles: RoleResolver;
  readonly logger?: ServiceAccountLogger;
  readonly metrics?: ServiceAccountMetrics;
}

/** The permission each operation needs. Reuses the RBAC catalogue, so no new permission is invented. */
const SERVICE_ACCOUNT_PERMISSIONS = {
  read: 'token:read',
  create: 'token:create',
  update: 'token:create',
  disable: 'token:revoke',
} as const satisfies Record<string, Permission>;

const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

/** SQLSTATE of a database error, read through the driver's `cause` chain. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const code = (current as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown } | null | undefined)?.cause;
    if (current === undefined || current === null) return undefined;
  }
  return undefined;
}

function toServiceAccount(row: ServiceAccountRow): ServiceAccount {
  if (!row.roles.every(isServiceAccountRole)) {
    // The database check makes this unreachable; a mismatch is a defect, never silently dropped.
    throw new InternalError('stored service account holds a role outside the assignable set');
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    roles: [...row.roles] as Role[],
    ownerUserId: row.ownerUserId,
    status: row.status,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Refuses any role a service account may not hold (defence in depth beside the schema and the DB check). */
function assertAssignableRoles(roles: readonly Role[] | undefined): void {
  if (roles === undefined) return;
  const refused = roles.filter((role) => !isServiceAccountRoleAssignable(role));
  if (refused.length > 0) {
    throw new ValidationError('role_not_assignable_to_service_account', {
      detail: 'Service accounts cannot hold approval or administrative roles.',
    });
  }
}

export class ServiceAccountService {
  private readonly store: ServiceAccountStore;
  private readonly roles: RoleResolver;
  private readonly logger: ServiceAccountLogger | undefined;
  private readonly metrics: ServiceAccountMetrics | undefined;

  constructor(options: ServiceAccountServiceOptions) {
    this.store = options.store;
    this.roles = options.roles;
    this.logger = options.logger;
    this.metrics = options.metrics;
  }

  async create(
    caller: ServiceAccountCaller,
    value: ServiceAccountCreateValue,
  ): Promise<ServiceAccount> {
    await this.authorise(caller, SERVICE_ACCOUNT_PERMISSIONS.create);
    assertAssignableRoles(value.roles);
    const row = await this.write(() => this.store.insert(value, this.context(caller)), {
      isCreate: true,
    });
    this.metrics?.activeChanged(1);
    this.log(caller, 'rbac.service_account.created', row.id);
    return toServiceAccount(row);
  }

  async list(
    caller: ServiceAccountCaller,
    options: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly items: readonly ServiceAccount[]; readonly nextCursor: string | null }> {
    await this.authorise(caller, SERVICE_ACCOUNT_PERMISSIONS.read);
    const page = await this.store.list(options);
    return { items: page.items.map((row) => toServiceAccount(row)), nextCursor: page.nextCursor };
  }

  async get(caller: ServiceAccountCaller, id: string): Promise<ServiceAccount> {
    await this.authorise(caller, SERVICE_ACCOUNT_PERMISSIONS.read);
    return toServiceAccount(await this.found(id));
  }

  async update(
    caller: ServiceAccountCaller,
    id: string,
    expectedVersion: number,
    changes: ServiceAccountUpdateValue,
  ): Promise<ServiceAccount> {
    await this.authorise(caller, SERVICE_ACCOUNT_PERMISSIONS.update);
    assertAssignableRoles(changes.roles);
    const before = changes.status === undefined ? undefined : await this.store.findById(id);
    const row = await this.write(
      () => this.store.patch(id, expectedVersion, changes, this.context(caller)),
      { isCreate: false },
    );
    if (before !== undefined && before.status !== row.status) {
      this.metrics?.activeChanged(row.status === 'active' ? 1 : -1);
    }
    this.log(caller, 'rbac.service_account.updated', row.id);
    return toServiceAccount(row);
  }

  async disable(
    caller: ServiceAccountCaller,
    id: string,
    expectedVersion: number,
  ): Promise<ServiceAccount> {
    await this.authorise(caller, SERVICE_ACCOUNT_PERMISSIONS.disable);
    const row = await this.store.disable(id, expectedVersion, this.context(caller));
    // An already disabled account comes back unchanged (same version): only a real transition moves the gauge.
    if (row.stateVersion !== expectedVersion) this.metrics?.activeChanged(-1);
    this.log(caller, 'rbac.service_account.disabled', row.id);
    return toServiceAccount(row);
  }

  /** Fails closed: no role in the tenant that grants `permission` is `FORBIDDEN`. */
  private async authorise(caller: ServiceAccountCaller, permission: Permission): Promise<void> {
    const roles = await this.roles(caller);
    const granted = roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
    if (!granted) {
      throw new ForbiddenError('permission denied', {
        detail: `The caller lacks ${permission} in this tenant.`,
      });
    }
  }

  private async found(id: string): Promise<ServiceAccountRow> {
    const row = await this.store.findById(id);
    if (row === undefined) {
      throw new NotFoundError('service account not found');
    }
    return row;
  }

  /** Maps database write failures to API errors: duplicate name is 409, a non-member owner is 422. */
  private async write(
    run: () => Promise<ServiceAccountRow>,
    options: { readonly isCreate: boolean },
  ): Promise<ServiceAccountRow> {
    try {
      return await run();
    } catch (error) {
      // Only an insert links a new owner; an update never changes the owner, so no FK can fail there.
      if (error instanceof ForeignKeyError && options.isCreate) {
        throw new ValidationError('owner_user_id_not_a_tenant_member', {
          detail: 'The owner must be a member of this tenant.',
          cause: error,
        });
      }
      if (sqlState(error) === UNIQUE_VIOLATION) {
        throw new ConflictError('service_account_name_taken', {
          detail: 'A service account with this name already exists in the tenant.',
          cause: error,
        });
      }
      throw error;
    }
  }

  private context(caller: ServiceAccountCaller): ServiceAccountAuditContext {
    return {
      actor: caller.actor,
      ...(caller.traceId === undefined ? {} : { traceId: caller.traceId }),
    };
  }

  private log(caller: ServiceAccountCaller, event: string, serviceAccountId: string): void {
    this.logger?.info(
      {
        event,
        serviceAccountId,
        tenantHash: hashTenantId(caller.tenantId),
        actorType: caller.actor.type,
      },
      event,
    );
  }
}
