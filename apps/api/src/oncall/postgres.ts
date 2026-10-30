import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';

import { createAuditEmitter, type AuditEventInput } from '@blackwing/audit';
import {
  type Database,
  memberships,
  oncallMembers,
  oncallRosters,
  oncallSchedules,
  type OncallMemberRow,
  type OncallRosterRow,
  type OncallScheduleRow,
  toAuditSqlTx,
  UniqueViolationError,
  withTenant,
  type TenantTx,
} from '@blackwing/db';

import type {
  OncallAuditSink,
  OncallConflictReason,
  OncallInsertResult,
  OncallMemberships,
  OncallStore,
  OncallUpdateResult,
} from './ports.js';
import type { OncallMember, OncallRoster, OncallSchedule } from '@blackwing/contracts';

/** Constraint names of the on-call tables, mapped to the reason the API reports (`db/schema/oncall.ts`). */
const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, OncallConflictReason>> = {
  oncall_rosters_tenant_name_key: 'name_taken',
  oncall_rosters_one_active_idx: 'active_roster_exists',
};

const emitter = createAuditEmitter();

/** Runs `fn` and maps the unique violations of the roster tables to a conflict; other errors pass. */
async function conflictOr<T extends { kind: string }>(
  attempt: () => Promise<T>,
): Promise<T | { kind: 'conflict'; reason: OncallConflictReason }> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof UniqueViolationError && error.constraint !== undefined) {
      const reason = CONFLICT_BY_CONSTRAINT[error.constraint];
      if (reason !== undefined) return { kind: 'conflict', reason };
    }
    throw error;
  }
}

const iso = (value: Date): string => value.toISOString();

function toMember(row: OncallMemberRow): OncallMember {
  return {
    id: row.id,
    userId: row.userId,
    level: row.level as OncallMember['level'],
    orderIndex: row.orderIndex,
    channelRefs: [...row.channelRefs],
  };
}

function toSchedule(row: OncallScheduleRow): OncallSchedule {
  return { id: row.id, userId: row.userId, startsAt: iso(row.startsAt), endsAt: iso(row.endsAt) };
}

function toRoster(
  row: OncallRosterRow,
  members: readonly OncallMemberRow[],
  schedules: readonly OncallScheduleRow[],
): OncallRoster {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    timezone: row.timezone,
    active: row.active,
    stateVersion: row.stateVersion,
    members: members.map((m) => toMember(m)),
    schedules: schedules.map((s) => toSchedule(s)),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Writes the member and schedule rows of one roster inside the transaction. */
async function writeLists(tx: TenantTx, roster: OncallRoster): Promise<void> {
  if (roster.members.length > 0) {
    await tx.insert(oncallMembers).values(
      roster.members.map((m) => ({
        id: m.id,
        tenantId: roster.tenantId,
        rosterId: roster.id,
        userId: m.userId,
        level: m.level,
        orderIndex: m.orderIndex,
        channelRefs: [...m.channelRefs],
      })),
    );
  }
  if (roster.schedules.length > 0) {
    await tx.insert(oncallSchedules).values(
      roster.schedules.map((s) => ({
        id: s.id,
        tenantId: roster.tenantId,
        rosterId: roster.id,
        userId: s.userId,
        startsAt: new Date(s.startsAt),
        endsAt: new Date(s.endsAt),
      })),
    );
  }
}

/** Loads the rosters (with their lists) selected by `where`, in creation order. */
async function loadRosters(
  tx: TenantTx,
  tenantId: string,
  where: SQL | undefined,
  limit?: number,
): Promise<OncallRoster[]> {
  const rows = await tx
    .select()
    .from(oncallRosters)
    .where(where)
    .orderBy(asc(oncallRosters.createdAt), asc(oncallRosters.id))
    .limit(limit ?? Number.MAX_SAFE_INTEGER);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const memberRows = await tx
    .select()
    .from(oncallMembers)
    .where(and(eq(oncallMembers.tenantId, tenantId), inArray(oncallMembers.rosterId, ids)))
    .orderBy(asc(oncallMembers.level), asc(oncallMembers.orderIndex), asc(oncallMembers.id));
  const scheduleRows = await tx
    .select()
    .from(oncallSchedules)
    .where(and(eq(oncallSchedules.tenantId, tenantId), inArray(oncallSchedules.rosterId, ids)))
    .orderBy(asc(oncallSchedules.startsAt), asc(oncallSchedules.id));
  return rows.map((row) =>
    toRoster(
      row,
      memberRows.filter((m) => m.rosterId === row.id),
      scheduleRows.filter((s) => s.rosterId === row.id),
    ),
  );
}

/**
 * The on-call roster store on Postgres (GATE2-003). Every query runs under `withTenant`, so RLS and the
 * explicit tenant predicate both apply, and a missing tenant context fails closed. A write, its lists
 * and its audit event share one transaction: a change is never stored without its audit event (§8.8).
 */
export class PostgresOncallStore implements OncallStore {
  constructor(private readonly db: Database) {}

  list(tenantId: string): Promise<readonly OncallRoster[]> {
    return withTenant(this.db, tenantId, (tx) =>
      loadRosters(tx, tenantId, eq(oncallRosters.tenantId, tenantId)),
    );
  }

  get(tenantId: string, rosterId: string): Promise<OncallRoster | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [roster] = await loadRosters(
        tx,
        tenantId,
        and(eq(oncallRosters.tenantId, tenantId), eq(oncallRosters.id, rosterId)),
        1,
      );
      return roster ?? null;
    });
  }

  getActive(tenantId: string): Promise<OncallRoster | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [roster] = await loadRosters(
        tx,
        tenantId,
        and(eq(oncallRosters.tenantId, tenantId), eq(oncallRosters.active, true)),
        1,
      );
      return roster ?? null;
    });
  }

  async insert(roster: OncallRoster, audit: AuditEventInput): Promise<OncallInsertResult> {
    const result = await conflictOr(() =>
      withTenant(this.db, roster.tenantId, async (tx) => {
        await tx.insert(oncallRosters).values({
          id: roster.id,
          tenantId: roster.tenantId,
          name: roster.name,
          timezone: roster.timezone,
          active: roster.active,
          stateVersion: roster.stateVersion,
          createdAt: new Date(roster.createdAt),
          updatedAt: new Date(roster.updatedAt),
        });
        await writeLists(tx, roster);
        await emitter.emitAuditInTx(toAuditSqlTx(tx), audit);
        return { kind: 'created' as const, roster };
      }),
    );
    return result;
  }

  async update(
    roster: OncallRoster,
    expectedVersion: number,
    audit: AuditEventInput,
  ): Promise<OncallUpdateResult> {
    const result = await conflictOr(() =>
      withTenant(this.db, roster.tenantId, async (tx): Promise<OncallUpdateResult> => {
        const updated = await tx
          .update(oncallRosters)
          .set({
            name: roster.name,
            timezone: roster.timezone,
            active: roster.active,
            stateVersion: expectedVersion + 1,
            updatedAt: new Date(roster.updatedAt),
          })
          .where(
            and(
              eq(oncallRosters.tenantId, roster.tenantId),
              eq(oncallRosters.id, roster.id),
              eq(oncallRosters.stateVersion, expectedVersion),
            ),
          )
          .returning({ id: oncallRosters.id });
        if (updated.length === 0) return { kind: 'stale' };
        await tx
          .delete(oncallSchedules)
          .where(
            and(
              eq(oncallSchedules.tenantId, roster.tenantId),
              eq(oncallSchedules.rosterId, roster.id),
            ),
          );
        await tx
          .delete(oncallMembers)
          .where(
            and(eq(oncallMembers.tenantId, roster.tenantId), eq(oncallMembers.rosterId, roster.id)),
          );
        await writeLists(tx, roster);
        await emitter.emitAuditInTx(toAuditSqlTx(tx), audit);
        return {
          kind: 'updated',
          roster: { ...roster, stateVersion: expectedVersion + 1 },
        };
      }),
    );
    return result;
  }
}

/** Reads a user's roles in a tenant from `memberships` (RBAC-001), under `withTenant`. */
export class PostgresOncallMemberships implements OncallMemberships {
  constructor(private readonly db: Database) {}

  rolesOf(tenantId: string, userId: string): Promise<readonly string[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ roles: memberships.roles })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .limit(1);
      return rows[0]?.roles ?? [];
    });
  }
}

/** The audit sink of events outside a roster write (`oncall.sod_skipped`), one transaction each. */
export class PostgresOncallAuditSink implements OncallAuditSink {
  constructor(private readonly db: Database) {}

  async append(record: AuditEventInput): Promise<void> {
    await withTenant(this.db, record.tenantId, (tx) =>
      emitter.emitAuditInTx(toAuditSqlTx(tx), record),
    );
  }
}
