import { describe, expect, it } from 'vitest';

import {
  canTriggerKill,
  formatHaltMs,
  isKillReasonValid,
  isRetryableKillError,
  killPollInterval,
  killTimeline,
  retryDelayMs,
  scopeNeedsRef,
} from './kill-model';

import type { KillEventView } from '@blackwing/contracts';

const T0 = '2026-10-20T10:00:00.000Z';

const event = (over: Partial<KillEventView> = {}): KillEventView => ({
  killEventId: '01890a5d-ac96-774b-bcce-b302099a8058',
  tenantId: '01890a5d-ac96-774b-bcce-b302099a8057',
  scope: 'run',
  scopeRefId: '01890a5d-ac96-774b-bcce-b302099a8056',
  source: 'console',
  actorType: 'user',
  actorRef: 'user:ada',
  reason: 'change freeze',
  status: 'halted',
  triggeredAt: T0,
  egressBlockedAt: '2026-10-20T10:00:01.000Z',
  sandboxesTerminatedAt: '2026-10-20T10:00:03.000Z',
  keysRevokedAt: '2026-10-20T10:00:03.500Z',
  workflowsCancelledAt: '2026-10-20T10:00:03.300Z',
  completedAt: '2026-10-20T10:00:03.600Z',
  haltMs: 3600,
  affected: {},
  reenabledAt: null,
  reenabledBy: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

describe('kill.ui.rbac: who may see the kill control', () => {
  it('shows a run or asset kill to org admins and appsec engineers, never to developers', () => {
    expect(canTriggerKill(['org_admin'], { scope: 'run' })).toBe(true);
    expect(canTriggerKill(['appsec_engineer'], { scope: 'run' })).toBe(true);
    expect(canTriggerKill(['developer'], { scope: 'run' })).toBe(false);
    expect(canTriggerKill(['developer'], { scope: 'asset' })).toBe(false);
  });

  it('lets an asset owner kill only owned assets', () => {
    expect(canTriggerKill(['asset_owner'], { scope: 'asset' })).toBe(false);
    expect(canTriggerKill(['asset_owner'], { scope: 'asset', ownsAsset: false })).toBe(false);
    expect(canTriggerKill(['asset_owner'], { scope: 'asset', ownsAsset: true })).toBe(true);
  });

  it('reserves the tenant-wide kill for org admins', () => {
    expect(canTriggerKill(['org_admin'], { scope: 'tenant' })).toBe(true);
    expect(canTriggerKill(['appsec_engineer'], { scope: 'tenant' })).toBe(false);
    expect(canTriggerKill(['asset_owner'], { scope: 'tenant', ownsAsset: true })).toBe(false);
  });

  it('ignores unknown roles and an empty role list', () => {
    expect(canTriggerKill([], { scope: 'run' })).toBe(false);
    expect(canTriggerKill(['wizard'], { scope: 'run' })).toBe(false);
  });
});

describe('scope inference', () => {
  it('only run and asset kills name a ref; a tenant kill names none', () => {
    expect(scopeNeedsRef('run')).toBe(true);
    expect(scopeNeedsRef('asset')).toBe(true);
    expect(scopeNeedsRef('tenant')).toBe(false);
  });
});

describe('reason validation', () => {
  it('requires three characters once trimmed, and rejects blank or oversized reasons', () => {
    expect(isKillReasonValid('')).toBe(false);
    expect(isKillReasonValid('   ')).toBe(false);
    expect(isKillReasonValid('ab')).toBe(false);
    expect(isKillReasonValid('  ab  ')).toBe(false);
    expect(isKillReasonValid('abc')).toBe(true);
    expect(isKillReasonValid(` abc `)).toBe(true);
    expect(isKillReasonValid('x'.repeat(10_000))).toBe(false);
  });
});

describe('killTimeline', () => {
  it('marks every stage confirmed on a halted kill, with the time from the trigger', () => {
    const stages = killTimeline(event());
    expect(stages.map((s) => s.key)).toEqual(['gateway', 'sandboxes', 'keys', 'workflows']);
    expect(stages.every((s) => s.state === 'confirmed')).toBe(true);
    expect(stages[0]?.atMs).toBe(1000);
  });

  it('shows a zero-length halt as nothing to stop, without inventing timings', () => {
    const stages = killTimeline(
      event({
        haltMs: 0,
        egressBlockedAt: null,
        sandboxesTerminatedAt: null,
        keysRevokedAt: null,
        workflowsCancelledAt: null,
      }),
    );
    expect(stages.every((s) => s.state === 'not_needed' && s.atMs === null)).toBe(true);
  });

  it('marks unconfirmed stages degraded on a partial or failed kill, and pending while open', () => {
    const partial = killTimeline(
      event({ status: 'partially_halted', keysRevokedAt: null, completedAt: null, haltMs: null }),
    );
    expect(partial.find((s) => s.key === 'keys')?.state).toBe('degraded');
    const open = killTimeline(
      event({ status: 'propagating', keysRevokedAt: null, completedAt: null, haltMs: null }),
    );
    expect(open.find((s) => s.key === 'keys')?.state).toBe('pending');
  });

  it('clamps a stage stamped before the trigger to zero instead of showing a negative time', () => {
    const stages = killTimeline(event({ egressBlockedAt: '2026-10-20T09:59:59.000Z' }));
    expect(stages[0]?.atMs).toBe(0);
  });
});

describe('polling and retries', () => {
  it('polls every second only while the kill is open', () => {
    expect(killPollInterval('initiated')).toBe(1000);
    expect(killPollInterval('propagating')).toBe(1000);
    expect(killPollInterval(undefined)).toBe(1000);
    expect(killPollInterval('halted')).toBe(false);
    expect(killPollInterval('failed')).toBe(false);
  });

  it('backs off exponentially from one second, capped at 30 seconds', () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(20)).toBe(30_000);
  });

  it('does not retry a refused, missing or invalid kill', () => {
    expect(isRetryableKillError(403)).toBe(false);
    expect(isRetryableKillError(404)).toBe(false);
    expect(isRetryableKillError(422)).toBe(false);
    expect(isRetryableKillError(503)).toBe(true);
    expect(isRetryableKillError(undefined)).toBe(true);
  });
});

describe('formatHaltMs', () => {
  it('shows measuring until the server reports, then milliseconds or seconds', () => {
    expect(formatHaltMs(null)).toBe('Measuring');
    expect(formatHaltMs(0)).toBe('0 ms');
    expect(formatHaltMs(820)).toBe('820 ms');
    expect(formatHaltMs(3300)).toBe('3.3 s');
  });
});
