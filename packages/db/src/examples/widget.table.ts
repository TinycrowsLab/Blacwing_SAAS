// The canonical example table (DB-007): every base mixin, the tenant index and the tenant policy.
// It is NOT part of the product schema (not exported from `schema/index.ts`, no migration): tests
// create it with `widgetMigrationSql`. Copy this shape for a real domain table.

import { foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import {
  idColumn,
  retention,
  softDelete,
  stateVersion,
  tenantIdColumn,
  tenantIdIndex,
  timestamps,
} from '../columns.js';

export const widgets = pgTable(
  'widgets',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull().default(0),
    parentId: uuid('parent_id'),
    ...timestamps(),
    ...stateVersion(),
    ...softDelete(),
    ...retention(),
  },
  (t) => [
    tenantIdIndex('widgets', t.tenantId),
    // A composite FK keeps the parent in the same tenant: plain FK checks bypass RLS, so a
    // single-column `parent_id -> id` would let a row point at another tenant's widget.
    unique('widgets_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'widgets_parent_fk',
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }),
  ],
);
