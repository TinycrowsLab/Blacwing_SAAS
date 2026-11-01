import { and, eq } from 'drizzle-orm';

import { createAuditEmitter } from '@blackwing/audit';
import {
  schedules,
  toAuditSqlTx,
  toSchedule,
  withTenant,
  type Database,
  type TenantTx,
} from '@blackwing/db';
import { AppError, NotFoundError, ScheduleNoAssetsError } from '@blackwing/errors';

import type {
  ScheduleAudit,
  ScheduleDefinitionChange,
  ScheduleStateChange,
  ScheduleStore,
} from './ports.js';
import type { Schedule } from '@blackwing/contracts';

/**
 * The Postgres store of the ScheduleManager, on the app-role connection. Each call is one `withTenant` transaction, so
 * RLS confines it. A write that carries an audit event appends it to the tenant's chain in the same transaction, so a
 * change and its audit trail commit together or not at all.
 */

const audit = createAuditEmitter();

/** Maps the definition fields of a change to their columns. Only the keys present are written. */
function definitionColumns(
  definition: ScheduleDefinitionChange,
): Partial<typeof schedules.$inferInsert> {
  const columns: Partial<typeof schedules.$inferInsert> = {};
  if (definition.name !== undefined) columns.name = definition.name;
  if (definition.assetIds !== undefined) {
    if (definition.assetIds.length === 0) throw new ScheduleNoAssetsError();
    columns.assetIds = definition.assetIds;
  }
  if (definition.mode !== undefined) columns.mode = definition.mode;
  if (definition.objective !== undefined) columns.objective = definition.objective;
  if (definition.cronExpr !== undefined) columns.cronExpr = definition.cronExpr;
  if (definition.timezone !== undefined) columns.timezone = definition.timezone;
  if (definition.overlapPolicy !== undefined) columns.overlapPolicy = definition.overlapPolicy;
  if (definition.catchUpPolicy !== undefined) columns.catchUpPolicy = definition.catchUpPolicy;
  if (definition.catchUpWindowMinutes !== undefined) {
    columns.catchUpWindowMinutes = definition.catchUpWindowMinutes;
  }
  if (definition.budgets !== undefined) columns.budgets = definition.budgets;
  return columns;
}

function stateColumns(change: ScheduleStateChange): Partial<typeof schedules.$inferInsert> {
  const columns: Partial<typeof schedules.$inferInsert> = definitionColumns(
    change.definition ?? {},
  );
  if (change.enabled !== undefined) columns.enabled = change.enabled;
  if (change.temporalScheduleId !== undefined)
    columns.temporalScheduleId = change.temporalScheduleId;
  if (change.nextFireAt !== undefined) columns.nextFireAt = change.nextFireAt;
  return columns;
}

async function emitAudit(
  tx: TenantTx,
  tenantId: string,
  scheduleId: string,
  publicId: string,
  event: ScheduleAudit,
): Promise<void> {
  await audit.emitAuditInTx(toAuditSqlTx(tx), {
    tenantId,
    action: event.action,
    actor:
      event.actor.type === 'user'
        ? { type: 'user', id: event.actor.id }
        : { type: 'system', id: event.actor.id },
    target: { type: 'schedule', id: scheduleId, publicId },
    outcome: 'success',
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  });
}

export function createPgScheduleStore(db: Database): ScheduleStore {
  return {
    get(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
          .limit(1);
        return row === undefined ? null : toSchedule(row);
      });
    },

    list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx.select().from(schedules).where(eq(schedules.tenantId, tenantId));
        return rows.map((row) => toSchedule(row));
      });
    },

    write(tenantId, id, change, options) {
      return withTenant(db, tenantId, async (tx): Promise<Schedule> => {
        // The row lock serialises concurrent writers; the ETag check then decides on the locked row.
        const [current] = await tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
          .limit(1)
          .for('update');
        if (current === undefined) throw new NotFoundError('schedule not found');
        if (
          options.expectedUpdatedAt !== undefined &&
          current.updatedAt.toISOString() !== options.expectedUpdatedAt
        ) {
          throw new AppError('SCHEDULE_CONFLICT', 'schedule was changed by another request');
        }
        const [updated] = await tx
          .update(schedules)
          .set(stateColumns(change))
          .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
          .returning();
        if (updated === undefined) throw new AppError('INTERNAL', 'schedule update lost its row');
        if (options.audit !== undefined) {
          await emitAudit(tx, tenantId, id, updated.publicId, options.audit);
        }
        return toSchedule(updated);
      });
    },

    delete(tenantId, id, event) {
      return withTenant(db, tenantId, async (tx) => {
        const [deleted] = await tx
          .delete(schedules)
          .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
          .returning();
        if (deleted === undefined) throw new NotFoundError('schedule not found');
        await emitAudit(tx, tenantId, id, deleted.publicId, event);
      });
    },
  };
}
