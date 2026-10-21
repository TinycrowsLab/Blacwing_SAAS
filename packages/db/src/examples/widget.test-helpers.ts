// Shared test setup for the widget example: turns the Drizzle table into DDL and applies the
// production pieces a real migration would (updated_at trigger, tenant RLS policy).

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

import { updatedAtTriggerSql } from '../columns.js';
import { rlsPolicySql } from '../rls.js';
import { widgets } from './widget.table.js';

import type pg from 'pg';

/** Creates the `widgets` table with trigger, RLS and `bw_app` grants (run as the owner). */
export async function createWidgetTable(owner: pg.Pool): Promise<void> {
  const ddl = (
    await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ widgets }))
  ).join('\n');
  await owner.query(ddl);
  await owner.query(updatedAtTriggerSql('widgets'));
  await owner.query(rlsPolicySql(widgets));
}
