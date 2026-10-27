// Base column mixins (DB-004, CONTEXT_PACK §5, §7, §8.6). Every table is built from these so ids,
// tenant scoping, audit timestamps, optimistic concurrency, soft delete and retention never drift.
//
// Time: all instants are stored as `timestamptz` (UTC instants) and serialised as ISO-8601 UTC
// (`Date#toISOString`) at the API boundary; never store local time or text dates.

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  type IndexBuilder,
  integer,
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { type IdPrefix, newId, type PublicId, toPublicId, toUuid, type Uuid } from '@blackwing/ids';

/**
 * Anything that can run an update: the app `Database`, a tenant-scoped `Tx` or `drizzle({ client })`.
 * Typed against Drizzle's driver-neutral base so this module never imports `client.ts` (which imports
 * the schema, which imports this module).
 */
export type UpdateExecutor = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'update'>;

/**
 * `id uuid primary key`. UUIDv7 is generated app-side by the monotonic `@blackwing/ids` generator
 * (time-ordered, stable under rapid generation). The DB default (`gen_random_uuid()`, core in
 * PostgreSQL 13+) is a fallback so raw SQL inserts still get an id; only the app path yields v7.
 */
export function idColumn(name = 'id') {
  return uuid(name)
    .primaryKey()
    .$defaultFn(() => newId())
    .default(sql`gen_random_uuid()`);
}

/**
 * The prefixed public id (`run_<base32>`) of a stored uuid. Stable and reversible with
 * {@link fromPublicId}; carries no PII (it is a re-encoding of the uuid).
 */
export function publicId<P extends IdPrefix>(prefix: P, uuidValue: string): PublicId<P> {
  return toPublicId(uuidValue, prefix);
}

/** The uuid behind a public id; throws `IdValidationError` for a wrong prefix or malformed value. */
export function fromPublicId(value: unknown, expected?: IdPrefix): Uuid {
  return toUuid(value, expected);
}

export interface TenantIdColumnOptions {
  /** The column of `tenants(id)`, e.g. `() => tenants.id`. Adds the foreign key. */
  references?: () => AnyPgColumn;
}

/** `tenant_id uuid not null` (the §8.6 anchor), optionally an FK to `tenants(id)`. Pair with {@link tenantIdIndex}. */
export function tenantIdColumn(options: TenantIdColumnOptions = {}) {
  const column = uuid('tenant_id').notNull();
  const { references } = options;
  return references ? column.references(references) : column;
}

/** The mandatory `tenant_id` index for a table: `(t) => [tenantIdIndex('runs', t.tenantId)]`. */
export function tenantIdIndex(tableName: string, tenantId: AnyPgColumn): IndexBuilder {
  return index(`${tableName}_tenant_id_idx`).on(tenantId);
}

/** `created_at` / `updated_at`, both `timestamptz not null default now()`. Attach {@link updatedAtTriggerSql}. */
export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  };
}

/** Name of the shared trigger function created by migration `0002_column_mixins`. */
export const UPDATED_AT_FUNCTION = 'bw_set_updated_at';

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertIdentifier(value: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new TypeError(`invalid SQL identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * DDL for the `updated_at` trigger of a table. Put it in the migration that creates the table. The
 * trigger runs inside the database, so `updated_at` is bumped for raw SQL updates and any ORM path.
 */
export function updatedAtTriggerSql(tableName: string): string {
  const table = assertIdentifier(tableName);
  return `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${UPDATED_AT_FUNCTION}();`;
}

/**
 * `state_version integer not null default 0`: optimistic concurrency (API ETag / If-Match). Use
 * {@link updateWithVersion} to bump it. An int wraps at 2^31 - 1 updates of one row, which is
 * unrealistic for a state machine and accepted.
 */
export function stateVersion() {
  return { stateVersion: integer('state_version').notNull().default(0) };
}

/** `deleted_at timestamptz null`. Use only where an epic declares soft delete; see {@link activeViewSql}. */
export function softDelete() {
  return { deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }) };
}

/** Drizzle filter for live rows of a soft-deletable table: `where(isActive(table))`. */
export function isActive(table: { deletedAt: AnyPgColumn }): SQL {
  return isNull(table.deletedAt);
}

/**
 * The "active rows" view pattern: every read path uses `<table>_active`, never the base table.
 * `security_invoker` makes the view evaluate with the caller's privileges, so RLS on the base table
 * still applies (a plain view would run as its owner and bypass tenant isolation, violating §8.6).
 * Put it in the migration that creates the table.
 */
export function activeViewSql(tableName: string, viewName = `${tableName}_active`): string {
  const table = assertIdentifier(tableName);
  const view = assertIdentifier(viewName);
  return `CREATE VIEW ${view} WITH (security_invoker = true) AS SELECT * FROM ${table} WHERE deleted_at IS NULL;`;
}

/** `retention_until timestamptz null`, `legal_hold boolean not null default false` (F39). */
export function retention() {
  return {
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }),
    legalHold: boolean('legal_hold').notNull().default(false),
  };
}

type VersionedTable = PgTable & { id: AnyPgColumn; stateVersion: AnyPgColumn };

/**
 * The repository helper for optimistic concurrency: updates the row only if its `state_version`
 * still equals `expectedVersion`, and increments it atomically. Returns the updated row, or
 * `undefined` when the row is missing or was changed concurrently (the caller maps that to a 409 /
 * 412). Pass a tenant-scoped `Tx` so RLS applies.
 */
export async function updateWithVersion<T extends VersionedTable>(
  db: UpdateExecutor,
  table: T,
  key: { id: string; expectedVersion: number },
  values: Partial<Omit<T['$inferInsert'], 'id' | 'stateVersion'>>,
): Promise<T['$inferSelect'] | undefined> {
  const rows = (await db
    .update(table)
    .set({ ...values, stateVersion: sql`${table.stateVersion} + 1` })
    .where(and(eq(table.id, key.id), eq(table.stateVersion, key.expectedVersion)))
    .returning()) as unknown as T['$inferSelect'][];
  return rows[0];
}
