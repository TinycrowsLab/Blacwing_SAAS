import { describe, expect, it } from 'vitest';

import {
  ianaTimezoneSchema,
  oncallRosterCreateSchema,
  oncallRosterPatchSchema,
  oncallRosterSchema,
  oncallScheduleInputSchema,
} from './index.js';

const USER_A = '01890a5d-ac96-774b-bcce-b302099a8057';
const USER_B = '01890a5d-ac96-774b-bcce-b302099a8058';
const CHANNEL = '01890a5d-ac96-774b-bcce-b302099a8059';
const AT = '2026-10-20T10:00:00.000Z';

const member = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_A,
  level: 0,
  orderIndex: 0,
  channelRefs: [CHANNEL],
  ...overrides,
});

describe('ianaTimezoneSchema', () => {
  it.each(['UTC', 'Europe/Berlin', 'America/New_York', 'America/Argentina/Buenos_Aires'])(
    'accepts %s',
    (zone) => {
      expect(ianaTimezoneSchema.safeParse(zone).success).toBe(true);
    },
  );

  it.each(['', '+02:00', 'Mars/Olympus', 'Europe/', '../etc', 'x'.repeat(80)])(
    'refuses %j',
    (zone) => {
      expect(ianaTimezoneSchema.safeParse(zone).success).toBe(false);
    },
  );
});

describe('oncallRosterCreateSchema', () => {
  it('defaults active, members, schedules and channelRefs', () => {
    const parsed = oncallRosterCreateSchema.parse({
      name: 'Primary',
      timezone: 'UTC',
      members: [{ userId: USER_A, level: 0, orderIndex: 0 }],
    });
    expect(parsed.active).toBe(true);
    expect(parsed.schedules).toEqual([]);
    expect(parsed.members[0]?.channelRefs).toEqual([]);
  });

  it('refuses a level outside the ladder and a duplicate position or seat', () => {
    const base = { name: 'Primary', timezone: 'UTC' };
    expect(
      oncallRosterCreateSchema.safeParse({ ...base, members: [member({ level: 3 })] }).success,
    ).toBe(false);
    expect(
      oncallRosterCreateSchema.safeParse({
        ...base,
        members: [member(), member({ userId: USER_B })],
      }).success,
    ).toBe(false);
    expect(
      oncallRosterCreateSchema.safeParse({
        ...base,
        members: [member(), member({ orderIndex: 1 })],
      }).success,
    ).toBe(false);
    expect(
      oncallRosterCreateSchema.safeParse({
        ...base,
        members: [member(), member({ level: 1 }), member({ userId: USER_B, orderIndex: 1 })],
      }).success,
    ).toBe(true);
  });

  it('refuses unknown fields (no tenantId smuggling) and non-uuid channel refs', () => {
    const base = { name: 'Primary', timezone: 'UTC' };
    expect(oncallRosterCreateSchema.safeParse({ ...base, tenantId: USER_A }).success).toBe(false);
    expect(
      oncallRosterCreateSchema.safeParse({ ...base, members: [member({ channelRefs: ['x'] })] })
        .success,
    ).toBe(false);
  });
});

describe('oncallRosterPatchSchema', () => {
  it('needs at least one field and checks replaced members', () => {
    expect(oncallRosterPatchSchema.safeParse({}).success).toBe(false);
    expect(oncallRosterPatchSchema.safeParse({ active: false }).success).toBe(true);
    expect(
      oncallRosterPatchSchema.safeParse({ members: [member(), member({ userId: USER_B })] })
        .success,
    ).toBe(false);
  });
});

describe('oncallScheduleInputSchema', () => {
  it('accepts an instant, an offset and a wall-clock time', () => {
    for (const startsAt of [
      '2026-03-08T09:00:00Z',
      '2026-03-08T09:00:00+05:30',
      '2026-03-08T09:00',
    ]) {
      expect(
        oncallScheduleInputSchema.safeParse({
          userId: USER_A,
          startsAt,
          endsAt: '2026-03-09T09:00',
        }).success,
      ).toBe(true);
    }
  });

  it('refuses a date without a time', () => {
    expect(
      oncallScheduleInputSchema.safeParse({ userId: USER_A, startsAt: '2026-03-08', endsAt: AT })
        .success,
    ).toBe(false);
  });
});

describe('oncallRosterSchema', () => {
  const roster = {
    id: USER_A,
    tenantId: USER_B,
    name: 'Primary',
    timezone: 'UTC',
    active: true,
    stateVersion: 0,
    members: [{ id: CHANNEL, userId: USER_A, level: 0, orderIndex: 0, channelRefs: [] }],
    schedules: [{ id: CHANNEL, userId: USER_A, startsAt: AT, endsAt: '2026-10-21T10:00:00.000Z' }],
    createdAt: AT,
    updatedAt: AT,
  };

  it('accepts a stored roster', () => {
    expect(oncallRosterSchema.safeParse(roster).success).toBe(true);
  });

  it('refuses a window that ends before it starts', () => {
    const bad = { ...roster, schedules: [{ ...roster.schedules[0], endsAt: AT }] };
    expect(oncallRosterSchema.safeParse(bad).success).toBe(false);
  });
});
