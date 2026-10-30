import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { STORED_SESSION_KINDS, STORED_SESSION_STATUSES } from '@blackwing/contracts';

import { idColumn, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { assets } from './assets.js';
import { bytea, TENANT_PREDICATE } from './columns.js';
import { runs } from './runs.js';

/**
 * Encrypted per-role session store (SESSION-004, CONTEXT_PACK §3.1, §8.1, §8.6, §8.7). One row per
 * `(tenant, run, asset, role)`. `enc_material` is the self-describing envelope of the session artifact (AES-256-GCM
 * ciphertext plus the DEK wrapped by the tenant KEK). No plaintext session material is ever stored here. A revoked
 * or expired row keeps its metadata for the audit trail, but its material is scrubbed (empty bytes, empty key ref).
 *
 * Tenant table: the §7 policy comes from `TENANT_PREDICATE`. Composite `(tenant_id, …)` foreign keys stop a session
 * naming another tenant's run or asset (plain FK checks bypass RLS). The migration is generated from this file and
 * then reviewed. FORCE ROW LEVEL SECURITY and the grants are appended by hand, since Drizzle models neither.
 */

/** SQL `IN (...)` list from a constant tuple (values are compile-time constants, never input). */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Cap on the stored envelope: 64 KiB of material base64-encoded plus the envelope's own fields. */
const MATERIAL_MAX_BYTES = sql.raw('131072');

export const roleSessions = pgTable(
  'role_sessions',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    runId: uuid('run_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    roleName: text('role_name').notNull(),
    kind: text('kind', { enum: STORED_SESSION_KINDS }).notNull(),
    /** The JSON envelope of the session material: ciphertext, IV, tag, wrapped DEK. Never plaintext. */
    encMaterial: bytea('enc_material').notNull(),
    /** Handle of the wrapping key, `<kekKey>@v<kekVersion>`. Empty once the material is scrubbed. */
    encKeyRef: text('enc_key_ref').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status', { enum: STORED_SESSION_STATUSES }).notNull().default('active'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantIdIndex('role_sessions', t.tenantId),
    index('role_sessions_tenant_run_idx').on(t.tenantId, t.runId),
    index('role_sessions_status_expires_idx').on(t.status, t.expiresAt),
    unique('role_sessions_scope_key').on(t.tenantId, t.runId, t.assetId, t.roleName),
    // Composite foreign keys: a session can never name another tenant's run or asset.
    foreignKey({
      name: 'role_sessions_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'role_sessions_asset_fk',
      columns: [t.tenantId, t.assetId],
      foreignColumns: [assets.tenantId, assets.id],
    }),
    check('role_sessions_role_name_check', sql`${t.roleName} ~ '^[A-Za-z0-9_.-]{1,64}$'`),
    check('role_sessions_kind_check', sql`${t.kind} IN (${inList(STORED_SESSION_KINDS)})`),
    check('role_sessions_status_check', sql`${t.status} IN (${inList(STORED_SESSION_STATUSES)})`),
    // Material is present only while the session can still be injected.
    check(
      'role_sessions_material_check',
      sql`(${t.status} IN ('expired', 'revoked')) OR octet_length(${t.encMaterial}) > 0`,
    ),
    check(
      'role_sessions_material_max_check',
      sql`octet_length(${t.encMaterial}) <= ${MATERIAL_MAX_BYTES}`,
    ),
    pgPolicy('role_sessions_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

export type RoleSessionRow = typeof roleSessions.$inferSelect;
export type NewRoleSessionRow = typeof roleSessions.$inferInsert;
