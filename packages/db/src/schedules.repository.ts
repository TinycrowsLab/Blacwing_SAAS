// Tenant-scoped persistence of recurring-run schedules (SCHED-001, CONTEXT_PACK §7, §8.6). Every statement runs through
// `withTenant`, so RLS confines it and a missing tenant fails closed. The schedule's standing authorisation is checked
// explicitly before the insert, so a schedule can never bind another tenant's SA; the tenant-scoped foreign key backs
// that check up in the database.

import { eq } from 'drizzle-orm';

import {
  type Schedule,
  scheduleCreateSchema,
  type ScheduleCreate,
  scheduleRowSchema,
} from '@blackwing/contracts';
import { NotFoundError, ScheduleNoAssetsError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { createLogger, type Logger } from '@blackwing/logger';

import { publicId } from './columns.js';
import { schedules, type ScheduleRow, standingAuthorisations } from './schema/index.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

export interface ScheduleRepositoryOptions {
  readonly logger?: Pick<Logger, 'info'>;
}

/** Maps a stored row to the contract shape (UTC ISO-8601 instants) and validates it against the contract on the way out. */
function toSchedule(row: ScheduleRow): Schedule {
  return scheduleRowSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    publicId: row.publicId,
    name: row.name,
    assetIds: row.assetIds,
    saId: row.saId,
    mode: row.mode,
    objective: row.objective,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    overlapPolicy: row.overlapPolicy,
    catchUpPolicy: row.catchUpPolicy,
    catchUpWindowMinutes: row.catchUpWindowMinutes,
    budgets: row.budgets,
    enabled: row.enabled,
    temporalScheduleId: row.temporalScheduleId,
    lastFireAt: row.lastFireAt?.toISOString() ?? null,
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export interface ScheduleRepository {
  /** Creates a schedule in `tenantId`. Throws `SCHEDULE_NO_ASSETS` for an empty asset list and `NotFoundError` for an SA outside the tenant. */
  create(tenantId: string, createdBy: string, input: ScheduleCreate): Promise<Schedule>;
  /** The schedule with this uuid in `tenantId`, or `null` (another tenant's schedule looks the same as a missing one). */
  find(tenantId: string, id: string): Promise<Schedule | null>;
}

export function createScheduleRepository(
  db: Database,
  options: ScheduleRepositoryOptions = {},
): ScheduleRepository {
  const logger = options.logger ?? createLogger('@blackwing/db');
  return {
    async create(tenantId, createdBy, input) {
      const parsed = scheduleCreateSchema.parse(input);
      if (parsed.assetIds.length === 0) throw new ScheduleNoAssetsError();
      const id = newId();
      const row = await withTenant(db, tenantId, async (tx) => {
        const [sa] = await tx
          .select({ id: standingAuthorisations.id })
          .from(standingAuthorisations)
          .where(eq(standingAuthorisations.id, parsed.saId))
          .limit(1);
        if (sa === undefined) throw new NotFoundError('standing authorisation not found');
        const [inserted] = await tx
          .insert(schedules)
          .values({
            id,
            tenantId,
            publicId: publicId('sched', id),
            name: parsed.name,
            assetIds: parsed.assetIds,
            saId: parsed.saId,
            mode: parsed.mode,
            objective: parsed.objective,
            cronExpr: parsed.cronExpr,
            timezone: parsed.timezone,
            overlapPolicy: parsed.overlapPolicy,
            catchUpPolicy: parsed.catchUpPolicy,
            catchUpWindowMinutes: parsed.catchUpWindowMinutes,
            budgets: parsed.budgets,
            enabled: parsed.enabled,
            createdBy,
          })
          .returning();
        if (inserted === undefined) throw new Error('schedule insert returned no row');
        return inserted;
      });
      logger.info(
        { component: 'schedules-db', tenantId, scheduleId: row.publicId },
        'schedule created',
      );
      return toSchedule(row);
    },

    async find(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx.select().from(schedules).where(eq(schedules.id, id)).limit(1);
        return row === undefined ? null : toSchedule(row);
      });
    },
  };
}
