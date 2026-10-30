// Notification channel persistence (NOTIFY-001, CONTEXT_PACK §7, §8.6, §8.7, §8.8). Every method runs
// through `withTenant`, so RLS confines it and a missing tenant context fails closed. A write locks the
// channel row, applies the change, rotates the credential it names, and writes its audit event in
// the same transaction: a change that cannot be audited does not happen. The credential is sealed by the
// caller (envelope encryption, SECRETS-002) before it arrives here; this module only stores ciphertext and
// the opaque `secret_ref`, never a plaintext value.

import { and, asc, eq } from 'drizzle-orm';

import { type NotificationChannelKind, parseSecretRef } from '@blackwing/contracts';
import { AppError, NotFoundError } from '@blackwing/errors';

import { unwrapQueryError } from './query-errors.js';
import {
  NOTIFICATION_CHANNELS_NAME_INDEX,
  notificationChannels,
  type NotificationChannelRow,
} from './schema/notifications.js';
import { secrets, secretVersions } from './schema/secrets.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** Longest channel list one call returns. A tenant with more channels pages through the console, not here. */
export const NOTIFICATION_CHANNEL_LIST_LIMIT = 200;

/** A credential sealed by the caller: the new `secrets` row (`create`) or the next version of one (`update`). */
export interface SealedChannelSecret {
  /** The secret record's id, the `{secretId}` of its `secret_ref`. */
  readonly secretId: string;
  /** The `bw-secret://` URI the channel stores. */
  readonly ref: string;
  /** SECRETS-002 ciphertext envelope; never plaintext. */
  readonly envelope: Record<string, unknown>;
  /** Credential type of the `secrets` row (`webhook_secret` or `api_key`). */
  readonly type: 'webhook_secret' | 'api_key';
  /** Envelope purpose: part of the AAD, so the ciphertext only opens for this use. */
  readonly purpose: string;
}

/** What a create commits. `secret` is absent for kinds that deliver without a credential (email). */
export interface NewChannelWrite {
  readonly id: string;
  readonly kind: NotificationChannelKind;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly status: 'active' | 'disabled';
  readonly createdBy: string;
  readonly secret?: SealedChannelSecret;
}

/** What an update commits. Absent fields keep their stored value. */
export interface ChannelUpdateWrite {
  readonly name?: string;
  readonly config?: Record<string, unknown>;
  readonly status?: 'active' | 'disabled';
  /** Rotates the channel's credential to a new version of the same secret record. */
  readonly rotateSecret?: SealedChannelSecret;
  /** Field names that changed, for the audit event. Never values: a value may be a credential. */
  readonly changedFields: readonly string[];
  readonly op: NotificationChannelOp;
  readonly actorId: string;
}

export type NotificationChannelOp =
  'created' | 'updated' | 'disabled' | 'enabled' | 'secret_rotated';

/** The audit event of a committed channel change (`notification.channel_changed`), in the write's transaction. */
export interface NotificationChannelAuditEvent {
  readonly action: 'notification.channel_changed';
  readonly tenantId: string;
  readonly actorId: string;
  readonly channelId: string;
  readonly kind: NotificationChannelKind;
  readonly op: NotificationChannelOp;
  readonly changedFields: readonly string[];
}

/** Audit hook (§8.8): runs inside the write's transaction, so a failure rolls the change back. */
export type NotificationChannelAuditHook = (
  event: NotificationChannelAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface NotificationChannelRepositoryOptions {
  readonly db: Database;
  readonly audit: NotificationChannelAuditHook;
}

/** Postgres SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = '23505';

/** True when `error` is the unique violation of the channel name (the one conflict a create can raise). */
function isNameConflict(error: unknown): boolean {
  const cause = unwrapQueryError(error) as { code?: unknown; constraint?: unknown } | null;
  return cause?.code === UNIQUE_VIOLATION && cause.constraint === NOTIFICATION_CHANNELS_NAME_INDEX;
}

/** The error of a name already used in the tenant. */
function nameConflict(): AppError {
  return new AppError('CHANNEL_NAME_CONFLICT', 'a notification channel with this name exists');
}

/** Tenant-scoped persistence of notification channels and the credentials they reference. */
export class NotificationChannelRepository {
  private readonly options: NotificationChannelRepositoryOptions;

  constructor(options: NotificationChannelRepositoryOptions) {
    this.options = options;
  }

  /** The channels of `tenantId`, oldest first. Empty when the tenant has none (or RLS hides them). */
  async list(tenantId: string): Promise<readonly NotificationChannelRow[]> {
    return withTenant(this.options.db, tenantId, (tx) =>
      tx
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.tenantId, tenantId))
        .orderBy(asc(notificationChannels.createdAt), asc(notificationChannels.id))
        .limit(NOTIFICATION_CHANNEL_LIST_LIMIT),
    );
  }

  /** One channel of `tenantId`, or `undefined` when it does not exist there (RLS and the filter). */
  async find(tenantId: string, channelId: string): Promise<NotificationChannelRow | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(notificationChannels)
        .where(
          and(eq(notificationChannels.tenantId, tenantId), eq(notificationChannels.id, channelId)),
        )
        .limit(1);
      return rows[0];
    });
  }

  /**
   * Commits a new channel: its sealed credential (a new `secrets` row), the channel and the audit event,
   * together. A name already used in the tenant throws `CHANNEL_NAME_CONFLICT`; nothing is written.
   */
  async create(tenantId: string, write: NewChannelWrite): Promise<NotificationChannelRow> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      if (write.secret !== undefined) {
        await tx.insert(secrets).values({
          id: write.secret.secretId,
          tenantId,
          name: `notification_channel:${write.id}`,
          type: write.secret.type,
          purpose: write.secret.purpose,
          backend: 'openbao',
          envelope: write.secret.envelope,
          currentVersion: 1,
          status: 'active',
        });
      }
      let row: NotificationChannelRow | undefined;
      try {
        [row] = await tx
          .insert(notificationChannels)
          .values({
            id: write.id,
            tenantId,
            kind: write.kind,
            name: write.name,
            config: write.config,
            secretRef: write.secret?.ref ?? null,
            status: write.status,
            createdBy: write.createdBy,
          })
          .returning();
      } catch (error) {
        if (isNameConflict(error)) throw nameConflict();
        throw error;
      }
      if (row === undefined) throw new AppError('INTERNAL', 'channel insert produced no row');
      await this.options.audit(
        {
          action: 'notification.channel_changed',
          tenantId,
          actorId: write.createdBy,
          channelId: row.id,
          kind: row.kind,
          op: 'created',
          changedFields: [
            'kind',
            'name',
            'config',
            ...(write.secret === undefined ? [] : ['secret']),
          ],
        },
        tx,
      );
      return row;
    });
  }

  /**
   * Runs `mutate` on the locked channel. It returns the write to commit, or `undefined` for a no-op (nothing
   * is written or audited). A rotation acts on the channel's own credential, and enabling a channel whose
   * credential is no longer live is refused (`CHANNEL_SECRET_UNAVAILABLE`), so a channel never reports
   * active while it cannot be delivered. A rename to a name in use is `CHANNEL_NAME_CONFLICT`.
   */
  async update(
    tenantId: string,
    channelId: string,
    mutate: (current: NotificationChannelRow) => ChannelUpdateWrite | undefined,
  ): Promise<{ readonly record: NotificationChannelRow; readonly changed: boolean }> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(notificationChannels)
        .where(
          and(eq(notificationChannels.tenantId, tenantId), eq(notificationChannels.id, channelId)),
        )
        .limit(1)
        .for('update');
      if (current === undefined) throw new NotFoundError('notification channel not found');
      const write = mutate(current);
      if (write === undefined) return { record: current, changed: false };

      if (write.rotateSecret !== undefined) {
        await this.rotate(tx, tenantId, current, write.rotateSecret);
      }
      if (write.status === 'active' && current.secretRef !== null) {
        await this.assertSecretLive(tx, tenantId, current.secretRef);
      }

      let updated: NotificationChannelRow | undefined;
      try {
        [updated] = await tx
          .update(notificationChannels)
          .set({
            ...(write.name === undefined ? {} : { name: write.name }),
            ...(write.config === undefined ? {} : { config: write.config }),
            ...(write.status === undefined ? {} : { status: write.status }),
            // A rotation alone changes no column here; the set must not be empty.
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(notificationChannels.tenantId, tenantId),
              eq(notificationChannels.id, channelId),
            ),
          )
          .returning();
      } catch (error) {
        if (isNameConflict(error)) throw nameConflict();
        throw error;
      }
      if (updated === undefined) throw new NotFoundError('notification channel not found');
      await this.options.audit(
        {
          action: 'notification.channel_changed',
          tenantId,
          actorId: write.actorId,
          channelId,
          kind: updated.kind,
          op: write.op,
          changedFields: write.changedFields,
        },
        tx,
      );
      return { record: updated, changed: true };
    });
  }

  /**
   * Rotates the channel's secret to its next version: the superseded ciphertext moves to `secret_versions`
   * (retired now, so a pinned ref keeps resolving for its grace period), and `secrets` takes the new one.
   */
  private async rotate(
    tx: TenantTx,
    tenantId: string,
    channel: NotificationChannelRow,
    next: SealedChannelSecret,
  ): Promise<void> {
    const secretId = this.secretIdOf(tenantId, channel);
    const [secret] = await tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId)))
      .limit(1)
      .for('update');
    if (secret === undefined || secret.status === 'shredded' || secret.envelope === null) {
      throw new AppError(
        'CHANNEL_SECRET_UNAVAILABLE',
        'the channel credential is no longer available',
      );
    }
    await tx.insert(secretVersions).values({
      tenantId,
      secretId,
      version: secret.currentVersion,
      envelope: secret.envelope,
      externalLocator: secret.externalLocator,
      retiredAt: new Date(),
    });
    await tx
      .update(secrets)
      .set({ envelope: next.envelope, currentVersion: secret.currentVersion + 1, status: 'active' })
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId)));
  }

  /** Refuses to activate a channel whose credential is gone (`shredded`, or missing). */
  private async assertSecretLive(tx: TenantTx, tenantId: string, ref: string): Promise<void> {
    const [secret] = await tx
      .select({ status: secrets.status })
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, parseSecretRef(ref).secretId)))
      .limit(1);
    if (secret === undefined || secret.status === 'shredded') {
      throw new AppError(
        'CHANNEL_SECRET_UNAVAILABLE',
        'the channel credential is no longer available',
      );
    }
  }

  /** The secret id a channel's `secret_ref` names, which must belong to `tenantId` (the row's check guarantees it). */
  private secretIdOf(tenantId: string, channel: NotificationChannelRow): string {
    if (channel.secretRef === null) {
      throw new AppError('INTERNAL', 'channel has no credential to act on');
    }
    const ref = parseSecretRef(channel.secretRef);
    if (ref.tenantId !== tenantId) {
      throw new AppError('INTERNAL', 'channel credential belongs to another tenant');
    }
    return ref.secretId;
  }
}
