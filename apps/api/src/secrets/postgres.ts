import { and, asc, eq, gt, or, sql } from 'drizzle-orm';

import { type AuditEventInput, createAuditEmitter } from '@blackwing/audit';
import { formatSecretRef, type SecretStatus } from '@blackwing/contracts';
import {
  auditExportSubscriptions,
  type Database,
  notificationChannels,
  SECRETS_IDEMPOTENCY_INDEX,
  SECRETS_NAME_INDEX,
  type SecretRow,
  secrets,
  secretVersions,
  toAuditSqlTx,
  type TenantTx,
  UniqueViolationError,
  withTenant,
} from '@blackwing/db';

import type {
  AddVersionResult,
  CreateSecretResult,
  DisableResult,
  DisableSecret,
  NewSecret,
  NewSecretVersion,
  SecretAuditRecord,
  SecretAuditSink,
  SecretMetadata,
  SecretStore,
  SecretUsageReader,
} from './ports.js';
import type { Envelope } from '@blackwing/secrets';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

const emitter = createAuditEmitter();

/** The record's `traceId` is nullable; the audit writer takes it as absent, never null. */
function toAuditEventInput(record: SecretAuditRecord): AuditEventInput {
  const { traceId, ...rest } = record;
  return traceId === null ? rest : { ...rest, traceId };
}

/** The `secret_ref` prefix every secret reference in the database starts with (`bw-secret://{tenant}/{id}`). */
const refBase = (tenantId: string, secretId: string): string =>
  formatSecretRef({ tenantId, secretId });

/** A column value that is not `null`: the JSON envelope is stored as an object, typed loosely by Drizzle. */
const asJson = (envelope: Envelope): Record<string, unknown> =>
  envelope as unknown as Record<string, unknown>;

function toMetadata(row: SecretRow): SecretMetadata {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    type: row.type ?? null,
    purpose: row.purpose,
    backend: row.backend,
    status: row.status,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One secret row by id. `lock` takes the row lock (`FOR UPDATE`) before a version or status is compared. */
async function rowOf(
  tx: TenantTx,
  tenantId: string,
  secretId: string,
  lock = false,
): Promise<SecretRow | undefined> {
  const query = tx
    .select()
    .from(secrets)
    .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId)))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * The `SecretStore` over the SECRETS-003 tables (`secrets`, `secret_versions`). Every method runs under
 * `withTenant`, so RLS (FORCEd) scopes it. Each write is one transaction that includes its audit event:
 * `create` relies on the unique indexes for the name and the idempotency key, `addVersion` and `disable`
 * take the row lock before comparing versions or status.
 */
export class PostgresSecretStore implements SecretStore {
  constructor(private readonly db: Database) {}

  findByIdempotencyKey(
    tenantId: string,
    keyHash: string,
  ): Promise<{ readonly secret: SecretMetadata; readonly fingerprint: string } | null> {
    return withTenant(this.db, tenantId, (tx) => this.findBoundTx(tx, tenantId, keyHash));
  }

  async create(input: NewSecret): Promise<CreateSecretResult> {
    const { secret, idempotency } = input;
    try {
      return await withTenant(this.db, secret.tenantId, async (tx): Promise<CreateSecretResult> => {
        const bound = await this.findBoundTx(tx, secret.tenantId, idempotency.keyHash);
        if (bound !== null) return { kind: 'idempotent_replay', ...bound };
        await tx.insert(secrets).values({
          id: secret.id,
          tenantId: secret.tenantId,
          name: secret.name,
          type: secret.type,
          purpose: secret.purpose,
          backend: secret.backend,
          envelope: asJson(input.envelope),
          currentVersion: secret.currentVersion,
          status: secret.status,
          idempotencyKeyHash: idempotency.keyHash,
          idempotencyFingerprint: idempotency.fingerprint,
          createdAt: new Date(secret.createdAt),
          updatedAt: new Date(secret.updatedAt),
        });
        await tx.insert(secretVersions).values({
          tenantId: secret.tenantId,
          secretId: secret.id,
          version: 1,
          envelope: asJson(input.envelope),
          createdAt: new Date(secret.createdAt),
        });
        await emitter.emitAuditInTx(toAuditSqlTx(tx), toAuditEventInput(input.audit));
        return { kind: 'created', secret };
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        if (error.constraint === SECRETS_NAME_INDEX) return { kind: 'name_conflict' };
        // A concurrent request with the same key won the race: answer it as that request's replay.
        if (error.constraint === SECRETS_IDEMPOTENCY_INDEX) {
          const bound = await this.findByIdempotencyKey(secret.tenantId, idempotency.keyHash);
          if (bound !== null) return { kind: 'idempotent_replay', ...bound };
        }
      }
      throw error;
    }
  }

  get(tenantId: string, secretId: string): Promise<SecretMetadata | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await rowOf(tx, tenantId, secretId);
      return row === undefined ? null : toMetadata(row);
    });
  }

  list(
    tenantId: string,
    page: { readonly afterId?: string; readonly limit: number },
  ): Promise<readonly SecretMetadata[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.tenantId, tenantId),
            page.afterId === undefined ? undefined : gt(secrets.id, page.afterId),
          ),
        )
        .orderBy(asc(secrets.id))
        .limit(page.limit);
      return rows.map((row) => toMetadata(row));
    });
  }

  addVersion(input: NewSecretVersion): Promise<AddVersionResult> {
    return withTenant(this.db, input.tenantId, async (tx): Promise<AddVersionResult> => {
      const row = await rowOf(tx, input.tenantId, input.secretId, true);
      if (row === undefined) return { kind: 'not_found' };
      if (row.status !== 'active') {
        return { kind: 'inactive', status: row.status as SecretStatus };
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== row.currentVersion) {
        return { kind: 'stale' };
      }
      const version = row.currentVersion + 1;
      await tx.insert(secretVersions).values({
        tenantId: input.tenantId,
        secretId: input.secretId,
        version,
        envelope: asJson(input.envelope),
        createdAt: new Date(input.now),
      });
      const [updated] = await tx
        .update(secrets)
        .set({
          envelope: asJson(input.envelope),
          currentVersion: version,
          updatedAt: new Date(input.now),
        })
        .where(and(eq(secrets.tenantId, input.tenantId), eq(secrets.id, input.secretId)))
        .returning();
      if (updated === undefined) throw new Error('secret row vanished during a version write');
      const secret = toMetadata(updated);
      await emitter.emitAuditInTx(toAuditSqlTx(tx), toAuditEventInput(input.audit(secret)));
      return { kind: 'updated', secret };
    });
  }

  disable(input: DisableSecret): Promise<DisableResult> {
    return withTenant(this.db, input.tenantId, async (tx): Promise<DisableResult> => {
      const row = await rowOf(tx, input.tenantId, input.secretId, true);
      if (row === undefined) return { kind: 'not_found' };
      if (row.status === 'disabled' || row.status === 'shredded') {
        return { kind: 'unchanged', secret: toMetadata(row) };
      }
      const [updated] = await tx
        .update(secrets)
        .set({ status: 'disabled', updatedAt: new Date(input.now) })
        .where(and(eq(secrets.tenantId, input.tenantId), eq(secrets.id, input.secretId)))
        .returning();
      if (updated === undefined) throw new Error('secret row vanished during a disable');
      const secret = toMetadata(updated);
      await emitter.emitAuditInTx(toAuditSqlTx(tx), toAuditEventInput(input.audit(secret)));
      return { kind: 'disabled', secret };
    });
  }

  private async findBoundTx(
    tx: TenantTx,
    tenantId: string,
    keyHash: string,
  ): Promise<{ readonly secret: SecretMetadata; readonly fingerprint: string } | null> {
    const [row] = await tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.idempotencyKeyHash, keyHash)))
      .limit(1);
    if (row?.idempotencyFingerprint === null || row === undefined) return null;
    return { secret: toMetadata(row), fingerprint: row.idempotencyFingerprint };
  }
}

/**
 * Which resources still hold a `secret_ref` to a secret. Only the tables that store `bw-secret://` refs are
 * read (notification channels, audit export subscriptions); each read is tenant-scoped.
 */
export class PostgresSecretUsage implements SecretUsageReader {
  constructor(private readonly db: Database) {}

  referencingTypes(tenantId: string, secretId: string): Promise<readonly string[]> {
    const base = refBase(tenantId, secretId);
    // A ref is the bare URI or the same URI pinned to a version (`?v=`); a prefix match on `base + "?"` covers both.
    const matches = (column: AnyPgColumn) =>
      or(eq(column, base), sql`starts_with(${column}, ${`${base}?`})`);
    return withTenant(this.db, tenantId, async (tx) => {
      const channel = await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(
          and(eq(notificationChannels.tenantId, tenantId), matches(notificationChannels.secretRef)),
        )
        .limit(1);
      const subscription = await tx
        .select({ id: auditExportSubscriptions.id })
        .from(auditExportSubscriptions)
        .where(
          and(
            eq(auditExportSubscriptions.tenantId, tenantId),
            matches(auditExportSubscriptions.secretRef),
          ),
        )
        .limit(1);
      return [
        ...(channel.length > 0 ? ['notification_channel'] : []),
        ...(subscription.length > 0 ? ['audit_export_subscription'] : []),
      ];
    });
  }
}

/** Audit writer for events with no state change to ride with (denials), in its own transaction. */
export class PostgresSecretAuditSink implements SecretAuditSink {
  constructor(private readonly db: Database) {}

  async append(record: SecretAuditRecord): Promise<void> {
    await withTenant(this.db, record.tenantId, (tx) =>
      emitter.emitAuditInTx(toAuditSqlTx(tx), toAuditEventInput(record)),
    );
  }
}
