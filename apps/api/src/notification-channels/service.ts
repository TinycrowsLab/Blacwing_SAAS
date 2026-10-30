import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { type ZodError, z } from 'zod';

import {
  channelKindNeedsSecret,
  createNotificationChannelSchema,
  deleteNotificationChannelQuerySchema,
  formatSecretRef,
  type NotificationChannelKind,
  type NotificationChannelStatus,
  type NotificationChannelView,
  parseNotificationChannelConfig,
  parseSecretRef,
  updateNotificationChannelSchema,
} from '@blackwing/contracts';
import { hasPermission, permissionsForRoles } from '@blackwing/domain';
import { AppError, ForbiddenError, NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { createCedarChannelPolicy, type ChannelPolicyEngine } from './policy.js';

import type { NotificationChannelMetrics } from './metrics.js';
import type {
  ChannelMemberships,
  ChannelReferences,
  ChannelSecretSealer,
  NotificationChannelStore,
} from './ports.js';
import type { ChannelUpdateWrite, NewChannelWrite, NotificationChannelRow } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/notification-channels';
const SPAN_PREFIX = 'notification_channel.';

/** The permission every channel operation requires (RBAC). Granted to org_admin and appsec_engineer. */
export const CHANNEL_MANAGE_PERMISSION = 'notifications:manage';

/** Purpose of every channel credential's envelope: part of the AAD, so it opens only for channel delivery. */
export const CHANNEL_SECRET_PURPOSE = 'notification_channel';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface NotificationChannelPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface NotificationChannelServiceDeps {
  readonly store: NotificationChannelStore;
  readonly memberships: ChannelMemberships;
  readonly secrets: ChannelSecretSealer;
  readonly references: ChannelReferences;
  readonly metrics: NotificationChannelMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly policy?: ChannelPolicyEngine;
  readonly tracer?: Tracer;
}

/** Secret type per kind: a webhook URL or HMAC key, or an API/integration key. */
const SECRET_TYPE: Readonly<Record<NotificationChannelKind, 'webhook_secret' | 'api_key'>> = {
  email: 'api_key',
  slack: 'webhook_secret',
  teams: 'webhook_secret',
  webhook: 'webhook_secret',
  pagerduty: 'api_key',
  opsgenie: 'api_key',
};

const uuidSchema = z.uuid();

/** Field paths only: issue messages can echo submitted values, and a value may be a credential. */
function invalidChannel(error: ZodError, prefix = ''): AppError {
  const fields = error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? '(body)' : `${prefix}${path}`;
  });
  return new AppError('NOTIFICATION_CHANNEL_INVALID', 'invalid notification channel', {
    detail: `Invalid fields: ${[...new Set(fields)].join(', ')}.`,
  });
}

/** The public view of a stored channel. It carries the opaque `secret_ref` only, never secret material. */
export function toNotificationChannelView(row: NotificationChannelRow): NotificationChannelView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: row.config,
    secretRef: row.secretRef,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Notification channels (NOTIFY-001): the tenant's delivery channels and the credentials they reference.
 * Every call is authorised first: RBAC grants `notifications:manage`, and Cedar confirms the principal and the
 * tenant match. A credential is sealed before the write and stored by reference; the write and its audit event
 * commit together. Request bodies are parsed here with the contracts' strict schemas.
 */
export class NotificationChannelService {
  private readonly tracer: Tracer;
  private readonly policy: ChannelPolicyEngine;

  constructor(private readonly deps: NotificationChannelServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.policy = deps.policy ?? createCedarChannelPolicy();
  }

  async list(principal: NotificationChannelPrincipal): Promise<readonly NotificationChannelView[]> {
    return this.inSpan('list', async () => {
      await this.authorise(principal);
      return (await this.deps.store.list(principal.tenantId)).map((row) => toNotificationChannelView(row));
    });
  }

  async get(
    principal: NotificationChannelPrincipal,
    channelId: string,
  ): Promise<NotificationChannelView> {
    return this.inSpan('get', async () => {
      await this.authorise(principal);
      return toNotificationChannelView(await this.liveChannel(principal.tenantId, channelId));
    });
  }

  /**
   * Creates a channel. Order: authorise, validate, seal the credential (a KEK or OpenBao failure refuses here,
   * so nothing is persisted), then commit the secret reference, the channel and the audit event together.
   */
  async create(
    principal: NotificationChannelPrincipal,
    body: unknown,
  ): Promise<NotificationChannelView> {
    return this.inSpan('create', async () => {
      await this.authorise(principal);
      const parsed = createNotificationChannelSchema.safeParse(body);
      if (!parsed.success) throw invalidChannel(parsed.error);
      const input = parsed.data;
      const id = newId();
      const plaintext = 'secret' in input ? input.secret : undefined;
      const secret = await this.sealNew(principal.tenantId, input.kind, plaintext);
      const write: NewChannelWrite = {
        id,
        kind: input.kind,
        name: input.name,
        config: input.config,
        status: 'active',
        createdBy: principal.actorId,
        ...(secret === undefined ? {} : { secret }),
      };
      const row = await this.deps.store.create(principal.tenantId, write);
      this.record(principal, row, 'created');
      return toNotificationChannelView(row);
    });
  }

  /**
   * Changes a channel. `config` is re-validated against the channel's kind, `secret` is valid only for a kind
   * that has one and rotates it, and a `status` change enables or disables delivery. An unchanged body is a
   * no-op: nothing is written and nothing is audited.
   */
  async update(
    principal: NotificationChannelPrincipal,
    channelId: string,
    body: unknown,
  ): Promise<NotificationChannelView> {
    return this.inSpan('update', async () => {
      await this.authorise(principal);
      const parsed = updateNotificationChannelSchema.safeParse(body);
      if (!parsed.success) throw invalidChannel(parsed.error);
      const patch = parsed.data;
      const current = await this.liveChannel(principal.tenantId, channelId);
      if (patch.secret !== undefined && !channelKindNeedsSecret(current.kind)) {
        throw new AppError('NOTIFICATION_CHANNEL_INVALID', 'invalid notification channel', {
          detail: `Invalid fields: secret (a ${current.kind} channel has no credential).`,
        });
      }
      const config =
        patch.config === undefined ? undefined : this.configOf(current.kind, patch.config);
      const rotateSecret =
        patch.secret === undefined || current.secretRef === null
          ? undefined
          : await this.sealRotation(principal.tenantId, current, patch.secret);
      const outcome: { op?: ChannelOp } = {};
      const { record, changed } = await this.deps.store.update(
        principal.tenantId,
        channelId,
        (locked): ChannelUpdateWrite | undefined => {
          const changedFields = [
            ...(patch.name !== undefined && patch.name !== locked.name ? ['name'] : []),
            ...(config !== undefined ? ['config'] : []),
            ...(patch.status !== undefined && patch.status !== locked.status ? ['status'] : []),
            ...(rotateSecret !== undefined ? ['secret'] : []),
          ];
          if (changedFields.length === 0) return undefined;
          const op = opOf(changedFields, patch.status);
          outcome.op = op;
          return {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(config === undefined ? {} : { config }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(rotateSecret === undefined ? {} : { rotateSecret }),
            changedFields,
            op,
            actorId: principal.actorId,
          };
        },
      );
      if (changed && outcome.op !== undefined) this.record(principal, record, outcome.op);
      return toNotificationChannelView(record);
    });
  }

  /**
   * Soft-disables a channel (`DELETE` never removes a row: audit and rotation history depend on it). A channel
   * that active routing rules reference is refused unless `force` is set, and the refusal names those rules.
   * Disabling an already-disabled channel is a no-op.
   */
  async remove(
    principal: NotificationChannelPrincipal,
    channelId: string,
    query: unknown,
  ): Promise<NotificationChannelView> {
    return this.inSpan('delete', async () => {
      await this.authorise(principal);
      const parsed = deleteNotificationChannelQuerySchema.safeParse(query ?? {});
      if (!parsed.success) throw invalidChannel(parsed.error);
      const current = await this.liveChannel(principal.tenantId, channelId);
      const rules = await this.deps.references.activeRuleIds(principal.tenantId, channelId);
      if (rules.length > 0 && !parsed.data.force) {
        throw new AppError(
          'CHANNEL_REFERENCED',
          'the channel is referenced by active routing rules',
          {
            detail: `Referencing rules: ${rules.join(', ')}. Send force=true to disable it anyway.`,
          },
        );
      }
      if (current.status === 'disabled') return toNotificationChannelView(current);
      const { record, changed } = await this.deps.store.update(
        principal.tenantId,
        channelId,
        () => ({
          status: 'disabled',
          changedFields: ['status'],
          op: 'disabled',
          actorId: principal.actorId,
        }),
      );
      if (changed) this.record(principal, record, 'disabled');
      return toNotificationChannelView(record);
    });
  }

  /** RBAC first (the grant), then Cedar (the tenant and the grant again, on the resource). Deny by default. */
  private async authorise(principal: NotificationChannelPrincipal): Promise<void> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, CHANNEL_MANAGE_PERMISSION)) {
      throw new ForbiddenError('the caller may not manage notification channels', {
        detail: `Missing permission ${CHANNEL_MANAGE_PERMISSION} in this tenant.`,
      });
    }
    const decision = this.policy.authorize(
      {
        userId: principal.actorId,
        tenantId: principal.tenantId,
        roles,
        permissions: [...permissionsForRoles(roles)],
      },
      principal.tenantId,
    );
    if (decision.decision !== 'allow') {
      throw new ForbiddenError('the caller may not manage notification channels', {
        detail: 'Cedar denied the channel operation in this tenant.',
      });
    }
  }

  /** Fails closed: a non-UUID user id has no membership to read, so it holds no roles. */
  private async rolesOf(principal: NotificationChannelPrincipal): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    return userId.success ? this.deps.memberships.rolesOf(principal.tenantId, userId.data) : [];
  }

  private async liveChannel(tenantId: string, channelId: string): Promise<NotificationChannelRow> {
    const parsed = uuidSchema.safeParse(channelId);
    const row = parsed.success ? await this.deps.store.find(tenantId, parsed.data) : undefined;
    if (row === undefined) throw new NotFoundError('notification channel not found');
    return row;
  }

  /** Validates `config` against the kind's strict schema; a credential-bearing key is refused here. */
  private configOf(
    kind: NotificationChannelKind,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      return parseNotificationChannelConfig(kind, config);
    } catch (error) {
      if (error instanceof z.ZodError) throw invalidChannel(error, 'config.');
      throw error;
    }
  }

  /** Seals a new credential under a fresh secret id, or returns `undefined` for a kind without one. */
  private async sealNew(
    tenantId: string,
    kind: NotificationChannelKind,
    plaintext: string | undefined,
  ): Promise<NewChannelWrite['secret']> {
    if (plaintext === undefined) return undefined;
    const secretId = newId();
    const envelope = await this.deps.secrets.encryptSecret({
      tenantId,
      plaintext,
      context: { secretId, purpose: CHANNEL_SECRET_PURPOSE },
    });
    return {
      secretId,
      ref: formatSecretRef({ tenantId, secretId }),
      envelope: { ...envelope },
      type: SECRET_TYPE[kind],
      purpose: CHANNEL_SECRET_PURPOSE,
    };
  }

  /** Seals the next version of a channel's existing credential, under the same secret id the ref names. */
  private async sealRotation(
    tenantId: string,
    channel: NotificationChannelRow,
    plaintext: string,
  ): Promise<NonNullable<ChannelUpdateWrite['rotateSecret']>> {
    if (channel.secretRef === null)
      throw new AppError('INTERNAL', 'channel has no credential to rotate');
    const { secretId } = parseSecretRef(channel.secretRef);
    const envelope = await this.deps.secrets.encryptSecret({
      tenantId,
      plaintext,
      context: { secretId, purpose: CHANNEL_SECRET_PURPOSE },
    });
    return {
      secretId,
      ref: channel.secretRef,
      envelope: { ...envelope },
      type: SECRET_TYPE[channel.kind],
      purpose: CHANNEL_SECRET_PURPOSE,
    };
  }

  /** Metrics and the structured log line. Only ids, the kind and the op: never a name, config or secret. */
  private record(
    principal: NotificationChannelPrincipal,
    row: NotificationChannelRow,
    op: string,
  ): void {
    this.deps.metrics.changed(row.kind, op);
    this.deps.logger.info(
      { tenantId: principal.tenantId, channelId: row.id, kind: row.kind, op },
      'notification_channel.changed',
    );
  }

  private async inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(`${SPAN_PREFIX}${name}`, async (span: Span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

type ChannelOp = ChannelUpdateWrite['op'];

/** The op of an update: a status change names the enable or disable, a credential-only change is a rotation. */
function opOf(
  changedFields: readonly string[],
  status: NotificationChannelStatus | undefined,
): ChannelOp {
  if (status === 'disabled') return 'disabled';
  if (status === 'active') return 'enabled';
  if (changedFields.length === 1 && changedFields[0] === 'secret') return 'secret_rotated';
  return 'updated';
}
