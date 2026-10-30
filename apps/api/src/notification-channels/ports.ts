import type { ChannelUpdateWrite, NewChannelWrite, NotificationChannelRow } from '@blackwing/db';
import type { Envelope } from '@blackwing/secrets';

/**
 * Channel persistence (the Postgres adapter is `NotificationChannelRepository` in @blackwing/db). `update` runs
 * `mutate` on the locked row; a stale precondition or a refused change throws from `mutate`, and nothing is
 * written. A write and its audit event commit together, or not at all.
 */
export interface NotificationChannelStore {
  list(tenantId: string): Promise<readonly NotificationChannelRow[]>;
  find(tenantId: string, channelId: string): Promise<NotificationChannelRow | undefined>;
  create(tenantId: string, write: NewChannelWrite): Promise<NotificationChannelRow>;
  update(
    tenantId: string,
    channelId: string,
    mutate: (current: NotificationChannelRow) => ChannelUpdateWrite | undefined,
  ): Promise<{ readonly record: NotificationChannelRow; readonly changed: boolean }>;
}

/**
 * Seals a channel credential with the tenant's KEK (SECRETS-002). The plaintext is only ever an argument; the
 * caller stores the envelope it returns. A KEK or OpenBao failure rejects, and nothing is persisted (fail closed).
 */
export interface ChannelSecretSealer {
  encryptSecret(input: {
    tenantId: string;
    plaintext: string;
    context: { readonly secretId: string; readonly purpose: string };
  }): Promise<Envelope>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface ChannelMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}

/**
 * Routing rules that reference a channel. A channel referenced by an active rule cannot be deleted unless the
 * caller forces it (NOTIFY-001). Routing rules are NOTIFY-011; until that table exists the composition root
 * passes `noRoutingRules`, which reports no references.
 */
export interface ChannelReferences {
  activeRuleIds(tenantId: string, channelId: string): Promise<readonly string[]>;
}
