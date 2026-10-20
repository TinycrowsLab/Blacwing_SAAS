// Kill-switch contracts (KILL-001): sample rows round-trip and every refinement mirrors a database
// check constraint in @blackwing/db migration 0001_kill_switch.

import { describe, expect, it } from 'vitest';

import {
  KILL_EVENTS_TOTAL_METRIC,
  KILL_SCOPES,
  killEventSchema,
  type KillEvent,
  socContactSchema,
  type SocContact,
  socKillTokenSchema,
  type SocKillToken,
} from './index.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.250Z';
const stamps = { createdAt: T0, updatedAt: T1 };

const killEvent: KillEvent = {
  id: ID(1),
  tenantId: ID(2),
  scope: 'run',
  scopeRefId: ID(3),
  source: 'soc_link',
  actorType: 'soc_contact',
  actorRef: ID(4),
  reason: 'unexpected load on the payments API',
  status: 'halted',
  triggeredAt: T0,
  egressBlockedAt: '2026-01-01T00:00:00.400Z',
  sandboxesTerminatedAt: '2026-01-01T00:00:01.100Z',
  keysRevokedAt: '2026-01-01T00:00:01.150Z',
  workflowsCancelledAt: '2026-01-01T00:00:01.200Z',
  completedAt: T1,
  haltMs: 1250,
  affected: { runs: 1, sessions: 3, sandboxes: 3, keys: 3 },
  reenabledAt: null,
  reenabledBy: null,
  ...stamps,
};

const socContact: SocContact = {
  id: ID(4),
  tenantId: ID(2),
  assetId: null,
  name: 'Acme SOC desk',
  email: 'soc@example.test',
  phone: '+44 20 7946 0000',
  notifyPrewindow: true,
  notifyStart: true,
  notifyEnd: false,
  locale: 'en-GB',
  status: 'active',
  ...stamps,
};

const socKillToken: SocKillToken = {
  id: ID(5),
  tenantId: ID(2),
  scope: 'asset',
  scopeRefId: ID(6),
  tokenSha256: 'a'.repeat(64),
  contactId: ID(4),
  expiresAt: '2026-01-08T00:00:00.000Z',
  maxUses: 1,
  useCount: 0,
  lastUsedAt: null,
  revokedAt: null,
  ...stamps,
};

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('kill contracts round-trip', () => {
  it.each([
    ['KillEvent', killEventSchema, killEvent],
    ['SocContact', socContactSchema, socContact],
    ['SocKillToken', socKillTokenSchema, socKillToken],
  ] as const)(
    '%s parses a sample row unchanged, also from a deep copy',
    (_name, schema, sample) => {
      expect(schema.parse(sample)).toEqual(sample);
      expect(schema.parse(structuredClone(sample))).toEqual(sample);
    },
  );

  it('rejects unknown keys (strict objects)', () => {
    expect(killEventSchema.safeParse({ ...killEvent, rawToken: 'x' }).success).toBe(false);
    expect(socKillTokenSchema.safeParse({ ...socKillToken, token: 'raw' }).success).toBe(false);
  });
});

describe('KillEvent refinements (mirror the check constraints)', () => {
  it('run and asset scopes require scopeRefId', () => {
    for (const scope of ['run', 'asset'] as const) {
      const result = killEventSchema.safeParse({ ...killEvent, scope, scopeRefId: null });
      expect(issuePaths(result)).toContain('scopeRefId');
    }
  });

  it('tenant and global scopes carry no scopeRefId', () => {
    expect(issuePaths(killEventSchema.safeParse({ ...killEvent, scope: 'tenant' }))).toContain(
      'scopeRefId',
    );
    expect(
      killEventSchema.safeParse({ ...killEvent, scope: 'tenant', scopeRefId: null }).success,
    ).toBe(true);
  });

  it('only a global event may have a null tenant', () => {
    const global = { ...killEvent, scope: 'global', scopeRefId: null, tenantId: null } as const;
    expect(killEventSchema.safeParse({ ...global, source: 'operator' }).success).toBe(true);
    const tenantless = killEventSchema.safeParse({ ...global, scope: 'tenant' });
    expect(issuePaths(tenantless)).toContain('tenantId');
  });

  it('rejects unknown scope, source and status values', () => {
    expect(killEventSchema.safeParse({ ...killEvent, scope: 'planet' }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, source: 'email' }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, status: 'paused' }).success).toBe(false);
  });

  it('requires a non-blank reason, a non-negative halt time and a JSON object for affected', () => {
    expect(killEventSchema.safeParse({ ...killEvent, reason: '   ' }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, haltMs: -1 }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, haltMs: 1.5 }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, affected: { runs: -1 } }).success).toBe(false);
    expect(killEventSchema.safeParse({ ...killEvent, affected: [] }).success).toBe(false);
  });

  it('records re-enable time and actor together', () => {
    const half = killEventSchema.safeParse({ ...killEvent, reenabledAt: T1 });
    expect(issuePaths(half)).toContain('reenabledBy');
    expect(
      killEventSchema.safeParse({ ...killEvent, reenabledAt: T1, reenabledBy: ID(9) }).success,
    ).toBe(true);
  });

  it('accepts only UTC millisecond timestamps (server-generated times)', () => {
    expect(
      killEventSchema.safeParse({ ...killEvent, triggeredAt: '2026-01-01T00:00:00+02:00' }).success,
    ).toBe(false);
  });
});

describe('SocContact refinements', () => {
  it('rejects a malformed e-mail, phone or locale and an unknown status', () => {
    expect(socContactSchema.safeParse({ ...socContact, email: 'not-an-email' }).success).toBe(
      false,
    );
    expect(socContactSchema.safeParse({ ...socContact, phone: 'call me' }).success).toBe(false);
    expect(socContactSchema.safeParse({ ...socContact, locale: 'English' }).success).toBe(false);
    expect(socContactSchema.safeParse({ ...socContact, status: 'paused' }).success).toBe(false);
  });

  it('accepts a per-asset contact', () => {
    expect(socContactSchema.safeParse({ ...socContact, assetId: ID(6) }).success).toBe(true);
  });
});

describe('SocKillToken refinements', () => {
  it('stores a SHA-256 hex digest, never a raw token', () => {
    expect(
      socKillTokenSchema.safeParse({ ...socKillToken, tokenSha256: 'bw_kill_raw' }).success,
    ).toBe(false);
    expect(
      socKillTokenSchema.safeParse({ ...socKillToken, tokenSha256: 'A'.repeat(64) }).success,
    ).toBe(false);
  });

  it('never carries the global scope', () => {
    expect(
      socKillTokenSchema.safeParse({ ...socKillToken, scope: 'global', scopeRefId: null }).success,
    ).toBe(false);
  });

  it('keeps useCount within maxUses and records the last use', () => {
    expect(issuePaths(socKillTokenSchema.safeParse({ ...socKillToken, useCount: 2 }))).toContain(
      'useCount',
    );
    expect(issuePaths(socKillTokenSchema.safeParse({ ...socKillToken, useCount: 1 }))).toContain(
      'lastUsedAt',
    );
    expect(socKillTokenSchema.safeParse({ ...socKillToken, maxUses: 0 }).success).toBe(false);
    expect(
      socKillTokenSchema.safeParse({ ...socKillToken, useCount: 1, lastUsedAt: T1 }).success,
    ).toBe(true);
  });

  it('applies the scope reference rule', () => {
    expect(
      issuePaths(socKillTokenSchema.safeParse({ ...socKillToken, scopeRefId: null })),
    ).toContain('scopeRefId');
  });
});

describe('bw_kill_events_total metric contract', () => {
  it('is a counter labelled by scope, source and status', () => {
    expect(KILL_EVENTS_TOTAL_METRIC).toMatchObject({
      name: 'bw_kill_events_total',
      type: 'counter',
      labels: ['scope', 'source', 'status'],
    });
    expect(KILL_SCOPES).toEqual(['run', 'asset', 'tenant', 'global']);
  });
});
