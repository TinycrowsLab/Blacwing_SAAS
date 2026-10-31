import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from '../columns.js';
import { bytea, TENANT_PREDICATE } from './columns.js';

/**
 * Per-session virtual model keys (GATEWAY-002, #405, CONTEXT_PACK §4.1, §7, §8.6, §8.7). One row per `bwk_`
 * key a sandbox presents to the model gateway. Only the SHA-256 of the key and its short, non-secret prefix
 * are stored; the raw key is shown once, in the mint response, and never persisted or logged.
 *
 * Two RLS policies apply. The tenant policy is the canonical one. The `virtual_keys_resolve_by_hash` policy
 * lets the gateway resolve a presented key before it knows the tenant: it reveals a row only when the caller
 * sets `app.virtual_key_sha256` to that row's exact hash (see `VirtualKeysRepository.resolve`). Knowing the
 * hash is knowing the key, so the policy opens no enumeration path, and it is the only cross-tenant read.
 * The forward-only migration is generated from this file and then reviewed; FORCE ROW LEVEL SECURITY, the
 * grants and the `updated_at` trigger are appended by hand.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** The session setting the resolve policy reads. Set with `set_config(..., true)` inside one transaction. */
export const VIRTUAL_KEY_RESOLVE_SETTING = 'app.virtual_key_sha256';

export const virtualKeys = pgTable(
  'virtual_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** Non-secret lookup prefix (`bwk_` plus 8 characters). Indexed for operators; never a credential alone. */
    keyPrefix: text('key_prefix').notNull(),
    /** SHA-256 of the full key text. Unique: a collision is rejected, never merged. */
    keySha256: bytea('key_sha256').notNull(),
    /** `{ tenantId, runId, sessionId, persona }` as minted (scope claims). */
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    /** Budget context carried for GATEWAY-011 (F38). Not enforced here. */
    budgetContext: jsonb('budget_context').$type<Record<string, unknown>>().notNull().default({}),
    persona: text('persona').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('virtual_keys_key_sha256_key').on(t.keySha256),
    index('virtual_keys_tenant_id_idx').on(t.tenantId),
    index('virtual_keys_tenant_run_idx').on(t.tenantId, t.runId),
    index('virtual_keys_key_prefix_idx').on(t.keyPrefix),
    check('virtual_keys_sha256_length_check', sql`octet_length(${t.keySha256}) = 32`),
    check('virtual_keys_prefix_check', sql`${t.keyPrefix} ~ '^bwk_[0-9A-Za-z]{8}$'`),
    check('virtual_keys_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check('virtual_keys_persona_check', sql`${t.persona} ~ '^[a-z][a-z0-9-]{0,63}$'`),
    pgPolicy('virtual_keys_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
    pgPolicy('virtual_keys_resolve_by_hash', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`${t.keySha256} = decode(current_setting('${sql.raw(VIRTUAL_KEY_RESOLVE_SETTING)}', true), 'hex')`,
    }),
  ],
);

export type VirtualKeyRow = typeof virtualKeys.$inferSelect;
export type NewVirtualKeyRow = typeof virtualKeys.$inferInsert;
