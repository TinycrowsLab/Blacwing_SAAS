import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createCursorCodec } from './cursor.js';
import { filterValue, type ListSpec } from './spec.js';

export const SECRET = 'unit-test-cursor-secret-0123456789abcdef';
export const codec = createCursorCodec(SECRET);

export const items = pgTable('pg_items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  name: text('name').notNull(),
  rank: integer('rank').notNull(),
  status: text('status').notNull(),
});

export interface ItemRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly name: string;
  readonly rank: number;
  readonly status: string;
}

export const itemSpec: ListSpec<ItemRow> = {
  sorts: {
    created_at: { column: items.createdAt, kind: 'date', read: (row) => row.createdAt },
    name: { column: items.name, kind: 'string', read: (row) => row.name },
    rank: { column: items.rank, kind: 'number', read: (row) => row.rank },
    id: { column: items.id, kind: 'uuid', read: (row) => row.id },
  },
  defaultSort: { field: 'created_at', direction: 'desc' },
  id: { column: items.id, read: (row) => row.id },
  filters: {
    status: {
      column: items.status,
      ops: ['eq', 'ne', 'in'],
      value: filterValue.enum(['open', 'closed', 'draft']),
    },
    name: { column: items.name, ops: ['prefix'], value: filterValue.string() },
    rank: { column: items.rank, ops: ['gte', 'lte', 'eq'], value: filterValue.number() },
  },
};
