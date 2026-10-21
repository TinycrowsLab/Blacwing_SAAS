import { column, pgTable, tenantIdColumn } from './drizzle-lite.js';

/** Tagged through the DB-004 mixin. */
export const widgets = pgTable('widgets', { id: column('id'), tenantId: tenantIdColumn() });
/** Tagged through a literal tenant_id column. */
export const gadgets = pgTable('gadgets', { id: column('id'), tenantId: column('tenant_id') });
/** Global table: no tenant_id, so raw access is allowed. */
export const users = pgTable('users', { id: column('id'), email: column('email') });
