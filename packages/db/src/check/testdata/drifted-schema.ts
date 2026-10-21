// Drift-check fixture (DB-002): the real schema plus a table no committed migration creates, as an
// author who edited src/schema/** but forgot `pnpm db:generate` would leave it.
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export * from '../../schema/index.js';

export const driftProbe = pgTable('drift_probe', {
  id: uuid('id').primaryKey(),
  note: text('note').notNull(),
});
