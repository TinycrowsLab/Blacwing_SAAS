import { describe, expect, it } from 'vitest';

import {
  INJECTABLE_STORED_SESSION_STATUSES,
  STORED_SESSION_KINDS,
  STORED_SESSION_STATUSES,
  storedSessionKeySchema,
  storedSessionKindSchema,
  storedSessionRoleNameSchema,
  storedSessionStatusSchema,
} from './stored-session.js';

// Version 7 UUIDs (the contract accepts only v7); fixed so the test needs no id generator.
const key = {
  tenantId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  runId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
  assetId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
  roleName: 'admin.user-1',
};

describe('role session contracts (SESSION-004)', () => {
  it('lists the four lifecycle statuses and injects only active or refreshing material', () => {
    expect(STORED_SESSION_STATUSES).toEqual(['active', 'expired', 'revoked', 'refreshing']);
    expect(INJECTABLE_STORED_SESSION_STATUSES).toEqual(['active', 'refreshing']);
    expect(storedSessionStatusSchema.safeParse('expired').success).toBe(true);
    expect(storedSessionStatusSchema.safeParse('deleted').success).toBe(false);
  });

  it('accepts the four kinds and refuses anything else', () => {
    expect(STORED_SESSION_KINDS).toEqual(['cookie', 'bearer', 'header', 'storage']);
    expect(storedSessionKindSchema.safeParse('cookie').success).toBe(true);
    expect(storedSessionKindSchema.safeParse('password').success).toBe(false);
  });

  it('accepts a well-formed key', () => {
    expect(storedSessionKeySchema.parse(key)).toEqual(key);
  });

  it.each([
    ['a colon (would break the Valkey key)', 'role:admin'],
    ['an empty name', ''],
    ['a name over 64 characters', 'a'.repeat(65)],
    ['whitespace', 'admin user'],
    ['a path separator', '../admin'],
  ])('refuses a role name with %s', (_label, roleName) => {
    expect(storedSessionRoleNameSchema.safeParse(roleName).success).toBe(false);
    expect(storedSessionKeySchema.safeParse({ ...key, roleName }).success).toBe(false);
  });

  it('refuses a non-UUIDv7 tenant, run or asset and any extra field', () => {
    expect(storedSessionKeySchema.safeParse({ ...key, tenantId: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(
      storedSessionKeySchema.safeParse({ ...key, runId: '00000000-0000-4000-8000-000000000000' })
        .success,
    ).toBe(false);
    expect(
      storedSessionKeySchema.safeParse({ ...key, assetId: key.assetId, extra: 1 }).success,
    ).toBe(false);
  });
});
