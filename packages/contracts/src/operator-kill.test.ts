import { describe, expect, it } from 'vitest';

import {
  isKillOpen,
  KILL_SLA_GATEWAY_MS,
  KILL_SLA_SANDBOX_MS,
  killConfirmationPhrase,
  killFailedComponents,
  killSlaBreaches,
  matchesKillConfirmation,
  operatorBlastRadiusQuerySchema,
  operatorBlastRadiusSchema,
  operatorKillEventDetailSchema,
  operatorKillEventSummarySchema,
  operatorKillRequestSchema,
} from './index.js';

const TENANT = '01890a5d-ac96-774b-bcce-b302099a8057';
const EVENT = '01890a5d-ac96-774b-bcce-b302099a8058';
const FIRED = '2026-10-20T10:00:00.000Z';
const plus = (ms: number): string => new Date(Date.parse(FIRED) + ms).toISOString();

describe('operator kill request (unit)', () => {
  it('accepts a global kill without a tenant and a tenant kill with one', () => {
    expect(
      operatorKillRequestSchema.safeParse({ scope: 'global', reason: 'incident' }).success,
    ).toBe(true);
    expect(
      operatorKillRequestSchema.safeParse({ scope: 'tenant', tenantId: TENANT, reason: 'incident' })
        .success,
    ).toBe(true);
  });

  it('refuses a tenant kill with no tenant and a global kill that names one', () => {
    expect(
      operatorKillRequestSchema.safeParse({ scope: 'tenant', reason: 'incident' }).success,
    ).toBe(false);
    expect(
      operatorKillRequestSchema.safeParse({ scope: 'global', tenantId: TENANT, reason: 'incident' })
        .success,
    ).toBe(false);
  });

  it('refuses run and asset scopes, short or blank reasons, bad ids and unknown fields', () => {
    for (const body of [
      { scope: 'run', reason: 'incident' },
      { scope: 'asset', reason: 'incident' },
      { scope: 'global', reason: '  ab ' },
      { scope: 'global', reason: '   ' },
      { scope: 'tenant', tenantId: 'acme', reason: 'incident' },
      { scope: 'global', reason: 'incident', extra: true },
      { scope: 'global' },
    ]) {
      expect(operatorKillRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('applies the same scope and tenant rule to the blast-radius query', () => {
    expect(operatorBlastRadiusQuerySchema.safeParse({ scope: 'global' }).success).toBe(true);
    expect(operatorBlastRadiusQuerySchema.safeParse({ scope: 'tenant' }).success).toBe(false);
    expect(
      operatorBlastRadiusQuerySchema.safeParse({ scope: 'global', tenantId: TENANT }).success,
    ).toBe(false);
  });
});

describe('operator kill responses (unit)', () => {
  it('parses a blast radius with and without the tenant slug and rejects negatives', () => {
    const radius = {
      runsAffected: 3,
      sandboxesAffected: 5,
      tenantsAffected: 1,
      sessionsAffected: 4,
    };
    expect(operatorBlastRadiusSchema.parse(radius)).toEqual(radius);
    expect(operatorBlastRadiusSchema.parse({ ...radius, tenantSlug: 'acme' }).tenantSlug).toBe(
      'acme',
    );
    expect(operatorBlastRadiusSchema.safeParse({ ...radius, runsAffected: -1 }).success).toBe(
      false,
    );
    expect(
      operatorBlastRadiusSchema.safeParse({ ...radius, tenantSlug: 'Not A Slug' }).success,
    ).toBe(false);
  });

  it('parses a global event summary (null tenant) and the detail with phases', () => {
    const summary = {
      id: EVENT,
      scope: 'global',
      tenantId: null,
      actor: 'op-1',
      reason: 'incident',
      firedAt: FIRED,
      haltMs: null,
      status: 'propagating',
    };
    expect(operatorKillEventSummarySchema.parse(summary)).toEqual(summary);
    expect(
      operatorKillEventDetailSchema.safeParse({
        ...summary,
        egressBlockedAt: plus(400),
        sandboxesTerminatedAt: null,
        keysRevokedAt: null,
        workflowsCancelledAt: null,
        completedAt: null,
        affected: { runs: 2 },
      }).success,
    ).toBe(true);
    expect(operatorKillEventSummarySchema.safeParse({ ...summary, scope: 'run' }).success).toBe(
      false,
    );
  });
});

describe('kill confirmation phrase (unit)', () => {
  it('is GLOBAL for a global kill and KILL plus the tenant slug for a tenant kill', () => {
    expect(killConfirmationPhrase('global', 'ignored')).toBe('GLOBAL');
    expect(killConfirmationPhrase('tenant', 'acme')).toBe('KILL acme');
  });

  it('matches exactly: case, wrong slug, partial and empty input all fail', () => {
    expect(matchesKillConfirmation('GLOBAL', 'GLOBAL')).toBe(true);
    expect(matchesKillConfirmation('  KILL acme \n', 'KILL acme')).toBe(true);
    expect(matchesKillConfirmation('global', 'GLOBAL')).toBe(false);
    expect(matchesKillConfirmation('KILL acm', 'KILL acme')).toBe(false);
    expect(matchesKillConfirmation('KILL other', 'KILL acme')).toBe(false);
    expect(matchesKillConfirmation('KILLacme', 'KILL acme')).toBe(false);
    expect(matchesKillConfirmation('', '')).toBe(false);
    expect(matchesKillConfirmation('', 'GLOBAL')).toBe(false);
  });
});

describe('kill SLA and partial helpers (unit)', () => {
  const base = { firedAt: FIRED, egressBlockedAt: null, sandboxesTerminatedAt: null };

  it('flags a phase only after it completed past its §8.5 target', () => {
    expect(killSlaBreaches(base)).toEqual({ gateway: false, sandboxes: false });
    expect(
      killSlaBreaches({
        ...base,
        egressBlockedAt: plus(KILL_SLA_GATEWAY_MS),
        sandboxesTerminatedAt: plus(KILL_SLA_SANDBOX_MS),
      }),
    ).toEqual({ gateway: false, sandboxes: false });
    expect(
      killSlaBreaches({
        ...base,
        egressBlockedAt: plus(KILL_SLA_GATEWAY_MS + 1),
        sandboxesTerminatedAt: plus(KILL_SLA_SANDBOX_MS + 1),
      }),
    ).toEqual({ gateway: true, sandboxes: true });
  });

  it('names every failed component and nothing that succeeded', () => {
    expect(killFailedComponents({})).toEqual([]);
    expect(
      killFailedComponents({
        egress: [
          { identity: 'run:r1', outcome: 'blocked' },
          { identity: 'run:r2', outcome: 'failed' },
        ],
        sandboxResults: [
          { sandboxId: 'sbx-1', outcome: 'failed' },
          { sandboxId: 'sbx-2', outcome: 'terminated' },
        ],
        keyResults: [{ keyId: 'vk-1', outcome: 'failed' }],
        workflowResults: [{ workflowId: 'wf-1', outcome: 'failed' }],
      }),
    ).toEqual([
      { kind: 'egress', id: 'run:r2' },
      { kind: 'sandbox', id: 'sbx-1' },
      { kind: 'key', id: 'vk-1' },
      { kind: 'workflow', id: 'wf-1' },
    ]);
  });

  it('treats only initiated and propagating as open', () => {
    expect(isKillOpen('initiated')).toBe(true);
    expect(isKillOpen('propagating')).toBe(true);
    for (const status of ['halted', 'partially_halted', 'failed'] as const) {
      expect(isKillOpen(status)).toBe(false);
    }
  });
});
