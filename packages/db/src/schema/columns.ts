import { sql, type SQL } from 'drizzle-orm';
import { customType, timestamp } from 'drizzle-orm/pg-core';

/** `citext` (case-insensitive text). The extension is enabled by migration `0000_extensions`. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** `bytea` read and written as a Node `Buffer`. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** `created_at` / `updated_at` (§7 rules), server-generated with `now()`. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

/** The §7 RLS predicate. `current_setting` without `missing_ok` errors when no tenant context is set. */
export const TENANT_PREDICATE: SQL = sql`tenant_id = current_setting('app.tenant_id')::uuid`;
