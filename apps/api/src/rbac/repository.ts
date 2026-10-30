// The service-account repository (RBAC-005). Built on the DB-007 BaseRepository so every statement runs
// inside `withTenant` (RLS, fail closed without a tenant). Each mutation appends its audit event inside the
// same transaction (§8.8): if the audit write fails the change rolls back, so a change never happens unaudited.

import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  type AuditActor,
  type AuditMetadata,
  serviceAccountCreateSchema,
  serviceAccountUpdateSchema,
} from '@blackwing/contracts';
import {
  BaseRepository,
  ConcurrencyError,
  type Database,
  serviceAccounts,
  type ServiceAccountRow,
  type RepositoryConfig,
  type TenantTx,
  toAuditSqlTx,
} from '@blackwing/db';
import { InternalError, NotFoundError } from '@blackwing/errors';

import type { AuditEmitter, AuditEventInput } from '@blackwing/audit';
import type { z } from 'zod';

export type ServiceAccountCreateValue = z.output<typeof serviceAccountCreateSchema>;
export type ServiceAccountUpdateValue = z.output<typeof serviceAccountUpdateSchema>;

type RepositoryConfigOf = RepositoryConfig<
  typeof serviceAccounts,
  ServiceAccountCreateValue,
  ServiceAccountUpdateValue
>;

/** Who made the change, for the audit event. The tenant is never taken from here: it is the ambient one. */
export interface ServiceAccountAuditContext {
  readonly actor: AuditActor;
  readonly traceId?: string;
}

export interface ServiceAccountRepositoryOptions {
  readonly db: Database;
  readonly audit: AuditEmitter;
  readonly logger?: RepositoryConfigOf['logger'];
  readonly tenant?: RepositoryConfigOf['tenant'];
}

function auditEvent(
  tenantId: string,
  action: AuditEventInput['action'],
  row: ServiceAccountRow,
  context: ServiceAccountAuditContext,
  metadata: AuditMetadata,
): AuditEventInput {
  return {
    tenantId,
    action,
    actor: context.actor,
    target: { type: 'service_account', id: row.id },
    outcome: 'success',
    metadata,
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
  };
}

export class ServiceAccountRepository extends BaseRepository<
  typeof serviceAccounts,
  ServiceAccountCreateValue,
  ServiceAccountUpdateValue
> {
  private readonly audit: AuditEmitter;

  constructor(options: ServiceAccountRepositoryOptions) {
    super({
      db: options.db,
      entity: 'service_account',
      table: serviceAccounts,
      createSchema: serviceAccountCreateSchema,
      updateSchema: serviceAccountUpdateSchema,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    });
    this.audit = options.audit;
  }

  /** Inserts a service account for the ambient tenant and audits `service_account.created`. */
  async insert(
    input: ServiceAccountCreateValue,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow> {
    return this.run('insert', async (tx, tenantId) => {
      const rows = await tx
        .insert(serviceAccounts)
        .values({ ...input, description: input.description ?? null, tenantId })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new InternalError('service account insert returned no row');
      await this.audit.emitAuditInTx(
        toAuditSqlTx(tx),
        auditEvent(tenantId, 'service_account.created', row, context, {
          roles: [...row.roles],
          status: row.status,
        }),
      );
      return { result: row, rowCount: 1 };
    });
  }

  /**
   * Applies `changes` only while the row is at `expectedVersion` (If-Match), bumps `state_version` and
   * audits `service_account.updated` with the changed field names (never their values). A missing or
   * foreign row is `NotFoundError`; a stale version is `ConcurrencyError` (412).
   */
  async patch(
    id: string,
    expectedVersion: number,
    changes: ServiceAccountUpdateValue,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow> {
    return this.run('patch', async (tx, tenantId) => {
      await this.loadAtVersion(tx, tenantId, id, expectedVersion);
      const rows = await tx
        .update(serviceAccounts)
        .set({ ...changes, stateVersion: sql`${serviceAccounts.stateVersion} + 1` })
        .where(
          and(
            eq(serviceAccounts.id, id),
            eq(serviceAccounts.tenantId, tenantId),
            eq(serviceAccounts.stateVersion, expectedVersion),
          ),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) throw new ConcurrencyError('service_account');
      await this.audit.emitAuditInTx(
        toAuditSqlTx(tx),
        auditEvent(tenantId, 'service_account.updated', row, context, {
          changedFields: Object.keys(changes).sort(),
        }),
      );
      return { result: row, rowCount: 1 };
    });
  }

  /**
   * Soft disable (`DELETE`): sets `status = disabled`. Nothing is removed, so the audit trail and token
   * history keep their referent. Disabling an already disabled account returns it unchanged and writes no
   * event (no state change to record). A version mismatch is `ConcurrencyError`.
   */
  async disable(
    id: string,
    expectedVersion: number,
    context: ServiceAccountAuditContext,
  ): Promise<ServiceAccountRow> {
    return this.run('disable', async (tx, tenantId) => {
      const current = await this.loadAtVersion(tx, tenantId, id, expectedVersion);
      if (current.status === 'disabled') return { result: current, rowCount: 1 };
      const rows = await tx
        .update(serviceAccounts)
        .set({ status: 'disabled', stateVersion: sql`${serviceAccounts.stateVersion} + 1` })
        .where(
          and(
            eq(serviceAccounts.id, id),
            eq(serviceAccounts.tenantId, tenantId),
            eq(serviceAccounts.stateVersion, expectedVersion),
          ),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) throw new ConcurrencyError('service_account');
      await this.audit.emitAuditInTx(
        toAuditSqlTx(tx),
        auditEvent(tenantId, 'service_account.disabled', row, context, {
          previousStatus: current.status,
        }),
      );
      return { result: row, rowCount: 1 };
    });
  }

  /** The live row, version-checked. Missing, deleted or foreign rows are not found; a stale version is a conflict. */
  private async loadAtVersion(
    tx: TenantTx,
    tenantId: string,
    id: string,
    expectedVersion: number,
  ): Promise<ServiceAccountRow> {
    const rows = await tx
      .select()
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.id, id),
          eq(serviceAccounts.tenantId, tenantId),
          isNull(serviceAccounts.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('service account not found');
    if (row.stateVersion !== expectedVersion) throw new ConcurrencyError('service_account');
    return row;
  }
}
