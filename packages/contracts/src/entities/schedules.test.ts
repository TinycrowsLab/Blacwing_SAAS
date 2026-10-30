import { describe, expect, it } from 'vitest';

import {
  BLACKOUT_SCOPES,
  blackoutWindowRowSchema,
  SCHEDULE_CATCH_UP_POLICIES,
  SCHEDULE_MODES,
  SCHEDULE_OVERLAP_POLICIES,
  scheduleCreateSchema,
  scheduleRowSchema,
} from './schedules.js';

const ID = '018f6b1e-7c2a-7d3e-8f4a-5b6c7d8e9f01';
const ID2 = '018f6b1e-7c2a-7d3e-8f4a-5b6c7d8e9f02';
const PUBLIC_ID = 'sched_0123456789abcdefghjkmnpqrs';
const NOW = '2026-10-30T08:00:00.000Z';
const LATER = '2026-10-30T09:00:00.000Z';

const validCreate = {
  name: 'Nightly passive sweep',
  assetIds: [ID],
  saId: ID2,
  mode: 'grey',
  cronExpr: '0 2 * * *',
  timezone: 'Europe/London',
};

const validRow = {
  id: ID,
  tenantId: ID2,
  publicId: PUBLIC_ID,
  name: 'Nightly passive sweep',
  assetIds: [ID],
  saId: ID2,
  mode: 'grey',
  objective: null,
  cronExpr: '0 2 * * *',
  timezone: 'Europe/London',
  overlapPolicy: 'skip',
  catchUpPolicy: 'skip',
  catchUpWindowMinutes: 60,
  budgets: { requests: 500 },
  enabled: true,
  temporalScheduleId: null,
  lastFireAt: null,
  nextFireAt: null,
  createdBy: ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const validWindow = {
  id: ID,
  tenantId: ID2,
  scope: 'tenant',
  assetIds: null,
  startsAt: NOW,
  endsAt: LATER,
  reason: 'change freeze',
  createdBy: ID,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('schedule enums', () => {
  it('match the check constraints of the migration', () => {
    expect([...SCHEDULE_MODES]).toEqual(['black', 'grey', 'white']);
    expect([...SCHEDULE_OVERLAP_POLICIES]).toEqual(['skip', 'buffer_one', 'cancel_other', 'allow']);
    expect([...SCHEDULE_CATCH_UP_POLICIES]).toEqual(['skip', 'fire_once']);
    expect([...BLACKOUT_SCOPES]).toEqual(['tenant', 'asset']);
  });
});

describe('scheduleCreateSchema', () => {
  it('accepts a minimal create and applies the defaults', () => {
    const parsed = scheduleCreateSchema.parse(validCreate);
    expect(parsed).toMatchObject({
      overlapPolicy: 'skip',
      catchUpPolicy: 'skip',
      catchUpWindowMinutes: 60,
      budgets: {},
      enabled: true,
      objective: null,
    });
  });

  it('keeps a Unicode name as given (UTF-8 text, up to 200 characters)', () => {
    const name = 'Sémaine öffentlich 夜間スキャン';
    expect(scheduleCreateSchema.parse({ ...validCreate, name }).name).toBe(name);
    expect(scheduleCreateSchema.safeParse({ ...validCreate, name: 'x'.repeat(200) }).success).toBe(
      true,
    );
    expect(scheduleCreateSchema.safeParse({ ...validCreate, name: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('rejects an empty or padded name', () => {
    expect(scheduleCreateSchema.safeParse({ ...validCreate, name: '' }).success).toBe(false);
    expect(scheduleCreateSchema.safeParse({ ...validCreate, name: '  padded ' }).success).toBe(
      false,
    );
  });

  it('accepts an empty asset list at the schema, so the repository can refuse it as SCHEDULE_NO_ASSETS', () => {
    expect(scheduleCreateSchema.safeParse({ ...validCreate, assetIds: [] }).success).toBe(true);
  });

  it('rejects a malformed or non-v7 asset or SA id', () => {
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, assetIds: ['not-a-uuid'] }).success,
    ).toBe(false);
    expect(
      scheduleCreateSchema.safeParse({
        ...validCreate,
        saId: '4b2f1c3e-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown mode or policy, and the destructive class as a mode', () => {
    expect(scheduleCreateSchema.safeParse({ ...validCreate, mode: 'destructive' }).success).toBe(
      false,
    );
    expect(scheduleCreateSchema.safeParse({ ...validCreate, overlapPolicy: 'queue' }).success).toBe(
      false,
    );
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, catchUpPolicy: 'replay_all' }).success,
    ).toBe(false);
  });

  it('bounds the catch-up window to 0..10080 minutes', () => {
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, catchUpWindowMinutes: 0 }).success,
    ).toBe(true);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, catchUpWindowMinutes: 10080 }).success,
    ).toBe(true);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, catchUpWindowMinutes: 10081 }).success,
    ).toBe(false);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, catchUpWindowMinutes: -1 }).success,
    ).toBe(false);
  });

  it('keeps budgets to finite non-negative numbers (never strings or secrets)', () => {
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, budgets: { requests: 10 } }).success,
    ).toBe(true);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, budgets: { token: 'bw-secret://x' } })
        .success,
    ).toBe(false);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, budgets: { requests: -1 } }).success,
    ).toBe(false);
  });

  it('stores the cron expression as opaque text but bounds its length', () => {
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, cronExpr: 'not a cron, stored as text' })
        .success,
    ).toBe(true);
    expect(scheduleCreateSchema.safeParse({ ...validCreate, cronExpr: '' }).success).toBe(false);
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, cronExpr: 'x'.repeat(257) }).success,
    ).toBe(false);
  });

  it('refuses unknown keys (a client cannot set tenant, state or fire times)', () => {
    expect(
      scheduleCreateSchema.safeParse({ ...validCreate, tenantId: ID, nextFireAt: NOW }).success,
    ).toBe(false);
  });
});

describe('scheduleRowSchema', () => {
  it('parses a stored row', () => {
    expect(scheduleRowSchema.parse(validRow).publicId).toBe(PUBLIC_ID);
  });

  it('rejects a public id without the sched_ prefix or of the wrong length', () => {
    expect(
      scheduleRowSchema.safeParse({ ...validRow, publicId: 'run_0123456789abcdefghjkmnpqrs' })
        .success,
    ).toBe(false);
    expect(scheduleRowSchema.safeParse({ ...validRow, publicId: 'sched_short' }).success).toBe(
      false,
    );
  });

  it('rejects empty asset ids, since the table never holds a schedule without assets', () => {
    expect(scheduleRowSchema.safeParse({ ...validRow, assetIds: [] }).success).toBe(false);
  });

  it('rejects an updatedAt before createdAt', () => {
    expect(
      scheduleRowSchema.safeParse({ ...validRow, createdAt: LATER, updatedAt: NOW }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO or local timestamp for the fire fields', () => {
    expect(
      scheduleRowSchema.safeParse({ ...validRow, nextFireAt: '2026-10-30 08:00:00' }).success,
    ).toBe(false);
  });
});

describe('blackoutWindowRowSchema', () => {
  it('accepts a tenant-wide window with no assets', () => {
    expect(blackoutWindowRowSchema.parse(validWindow).scope).toBe('tenant');
  });

  it('accepts an asset window that names assets', () => {
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, scope: 'asset', assetIds: [ID] }).success,
    ).toBe(true);
  });

  it('rejects an asset window with no assets', () => {
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, scope: 'asset', assetIds: null }).success,
    ).toBe(false);
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, scope: 'asset', assetIds: [] }).success,
    ).toBe(false);
  });

  it('rejects a tenant window that names assets', () => {
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, scope: 'tenant', assetIds: [ID] })
        .success,
    ).toBe(false);
  });

  it('rejects an end that is not after the start (half-open window)', () => {
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, startsAt: NOW, endsAt: NOW }).success,
    ).toBe(false);
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, startsAt: LATER, endsAt: NOW }).success,
    ).toBe(false);
  });

  it('rejects an unknown scope and an over-long reason', () => {
    expect(blackoutWindowRowSchema.safeParse({ ...validWindow, scope: 'global' }).success).toBe(
      false,
    );
    expect(
      blackoutWindowRowSchema.safeParse({ ...validWindow, reason: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});
