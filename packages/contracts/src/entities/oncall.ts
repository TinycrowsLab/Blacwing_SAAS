import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isBefore,
  isoDateTimeSchema,
  labelSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/**
 * Gate 2 on-call roster contracts (GATE2-003, F13/F31, CONTEXT_PACK §7, §8.4, §8.6).
 *
 * A tenant has at most one active roster. Its members sit on an escalation ladder (level 0 primary,
 * 1 secondary, 2 manager), ordered inside a level by `orderIndex`. A member with schedule windows is
 * on call only inside them; a member without any is always on call. The value limits below mirror the
 * check constraints in the `@blackwing/db` migration.
 */

/** Escalation levels: 0 primary, 1 secondary, 2 manager. */
export const ONCALL_LEVELS = [0, 1, 2] as const;
export type OncallLevel = (typeof ONCALL_LEVELS)[number];
export const oncallLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/** Largest `orderIndex` and the caps that keep one roster small enough to resolve in a single page. */
export const ONCALL_ORDER_INDEX_MAX = 1000;
export const ONCALL_MEMBERS_MAX = 100;
export const ONCALL_SCHEDULES_MAX = 500;
export const ONCALL_CHANNEL_REFS_MAX = 10;

/** An IANA timezone name (`Europe/Berlin`, `UTC`). Offsets such as `+02:00` are not zones and are refused. */
export const ianaTimezoneSchema = z
  .string()
  .max(LIMITS.keyMax)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/, 'must be an IANA timezone name')
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'must be a known IANA timezone');

/** Notification channel ids (NOTIFY) the member is paged on. An empty list means "not pageable". */
const channelRefsSchema = z.array(uuidV7Schema).max(ONCALL_CHANNEL_REFS_MAX);

/** A member as a client sends it. */
export const oncallMemberInputSchema = z.strictObject({
  userId: uuidV7Schema,
  level: oncallLevelSchema,
  orderIndex: z.number().int().min(0).max(ONCALL_ORDER_INDEX_MAX),
  channelRefs: channelRefsSchema.default([]),
});
export type OncallMemberInput = z.infer<typeof oncallMemberInputSchema>;

/**
 * A schedule window as a client sends it. `startsAt`/`endsAt` are either an instant (`Z` or an
 * offset) or a wall-clock time without offset, which is read in the roster's timezone.
 */
const scheduleBoundarySchema = z.iso.datetime({ offset: true, local: true });
export const oncallScheduleInputSchema = z.strictObject({
  userId: uuidV7Schema,
  startsAt: scheduleBoundarySchema,
  endsAt: scheduleBoundarySchema,
});
export type OncallScheduleInput = z.infer<typeof oncallScheduleInputSchema>;

function checkMembers(
  members: readonly {
    readonly userId: string;
    readonly level: number;
    readonly orderIndex: number;
  }[],
  ctx: z.RefinementCtx,
): void {
  const positions = new Set<string>();
  const seats = new Set<string>();
  members.forEach((member, index) => {
    const position = `${String(member.level)}:${String(member.orderIndex)}`;
    if (positions.has(position)) {
      ctx.addIssue({
        code: 'custom',
        path: ['members', index, 'orderIndex'],
        message: 'orderIndex must be unique within a level (the order must be deterministic)',
      });
    }
    positions.add(position);
    const seat = `${String(member.level)}:${member.userId}`;
    if (seats.has(seat)) {
      ctx.addIssue({
        code: 'custom',
        path: ['members', index, 'userId'],
        message: 'a user may appear once per level',
      });
    }
    seats.add(seat);
  });
}

const rosterBody = {
  name: labelSchema,
  timezone: ianaTimezoneSchema,
  members: z.array(oncallMemberInputSchema).max(ONCALL_MEMBERS_MAX),
  schedules: z.array(oncallScheduleInputSchema).max(ONCALL_SCHEDULES_MAX),
};

/** `POST /v1/oncall/rosters`. */
export const oncallRosterCreateSchema = z
  .strictObject({
    name: rosterBody.name,
    timezone: rosterBody.timezone,
    active: z.boolean().default(true),
    members: rosterBody.members.default([]),
    schedules: rosterBody.schedules.default([]),
  })
  .superRefine((roster, ctx) => {
    checkMembers(roster.members, ctx);
  });
export type OncallRosterCreate = z.infer<typeof oncallRosterCreateSchema>;

/** `PATCH /v1/oncall/rosters/{id}`: every field optional; a list replaces the stored list. */
export const oncallRosterPatchSchema = z
  .strictObject({
    name: rosterBody.name.optional(),
    timezone: rosterBody.timezone.optional(),
    active: z.boolean().optional(),
    members: rosterBody.members.optional(),
    schedules: rosterBody.schedules.optional(),
  })
  .superRefine((patch, ctx) => {
    if (Object.keys(patch).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a patch must change at least one field' });
    }
    if (patch.members !== undefined) checkMembers(patch.members, ctx);
  });
export type OncallRosterPatch = z.infer<typeof oncallRosterPatchSchema>;

/** A stored member (`oncall_members`). */
export const oncallMemberSchema = z.strictObject({
  id: uuidV7Schema,
  userId: uuidV7Schema,
  level: oncallLevelSchema,
  orderIndex: z.number().int().min(0).max(ONCALL_ORDER_INDEX_MAX),
  channelRefs: channelRefsSchema,
});
export type OncallMember = z.infer<typeof oncallMemberSchema>;

/** A stored schedule window (`oncall_schedules`), always UTC instants at rest. */
export const oncallScheduleSchema = z
  .strictObject({
    id: uuidV7Schema,
    userId: uuidV7Schema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
  })
  .refine((window) => isBefore(window.startsAt, window.endsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  });
export type OncallSchedule = z.infer<typeof oncallScheduleSchema>;

/** A roster with its members and schedule, as the API returns it (`stateVersion` backs the ETag). */
export const oncallRosterSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    name: labelSchema,
    timezone: ianaTimezoneSchema,
    active: z.boolean(),
    stateVersion: z.number().int().min(0),
    members: z.array(oncallMemberSchema),
    schedules: z.array(oncallScheduleSchema),
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type OncallRoster = z.infer<typeof oncallRosterSchema>;
