// KILL-008 (#184): the §8.5 kill SLO chaos suite. Real timers, the real propagation code and the real HTTP
// adapters, against an in-process control plane (`mock`) or the live stack (`real`). Run by
// `pnpm --filter @blackwing/worker test:chaos` (nightly and on demand, see docs/runbooks/kill-slo.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockControlPlane, NO_FAULTS, type ControlFaults } from './control-plane.js';
import {
  buildFleet,
  fireAll,
  fireKill,
  fleetUuid,
  planKills,
  type ControlUrls,
  type FleetRun,
  type PlannedKill,
} from './fleet.js';
import { assertWithinBudgets, buildSloReport, type KillSloReport } from './slo.js';
import { parseKillChaosConfig } from '../../config.js';

const chaos = parseKillChaosConfig();
const DEFAULT_REPORT = fileURLToPath(
  new URL('../../../../../eval/harness/out/kill-slo-report.json', import.meta.url),
);
const reportPath = chaos.reportPath ?? DEFAULT_REPORT;
/** Fault cases shorten the sandbox and key deadlines so a failing ack resolves in about a second. */
const FAULT_DEADLINE_MS = 1_000;
const FAULT_KILL_BASE = 0x7000;
const EGRESS_STAGE = 'egress';

/** Mock-mode control plane for the current test; a fresh one per fault case keeps cases independent. */
let plane: MockControlPlane | undefined;
let urls: ControlUrls = { egress: '', sandbox: '', keys: '' };

async function startControlPlane(): Promise<void> {
  if (chaos.mode !== 'mock') {
    // parseKillChaosConfig already required every live URL in real mode.
    urls = {
      egress: chaos.egressUrl ?? '',
      sandbox: chaos.sandboxUrl ?? '',
      keys: chaos.keysUrl ?? '',
    };
    return;
  }
  plane = await MockControlPlane.start();
  urls = { egress: plane.baseUrl, sandbox: plane.baseUrl, keys: plane.baseUrl };
}

async function stopControlPlane(): Promise<void> {
  await plane?.stop();
  plane = undefined;
}

function requirePlane(): MockControlPlane {
  if (plane === undefined) throw new Error('fault injection and traffic checks need mock mode');
  return plane;
}

/** §8.2 check: the gateway denies target traffic for this run's identity. */
function trafficDenied(runId: string): boolean {
  return !requirePlane().allowsTraffic({ kind: 'run', runId });
}

/** Every run's traffic is denied and its sandbox and key are gone, as the mock control plane recorded them. */
function expectMockStateSettled(runs: readonly FleetRun[]): void {
  for (const run of runs) {
    expect(trafficDenied(run.runId)).toBe(true);
    expect(requirePlane().isTerminated(run.sandboxId)).toBe(true);
    expect(requirePlane().isRevoked(run.keyId)).toBe(true);
  }
}

function egressSamples(latencies: readonly (readonly [string, number])[]): number[] {
  return latencies.filter(([stage]) => stage === EGRESS_STAGE).map(([, ms]) => ms);
}

describe('kill SLO load scenario (§8.5, F33)', () => {
  beforeEach(startControlPlane);
  afterEach(stopControlPlane);

  it('halts every kill and keeps the egress and full-halt p99 inside budget', async () => {
    const fleet = buildFleet(chaos.runs);
    const plans = planKills(fleet);
    const fired = await fireAll(plans, urls, {});

    const statuses: Record<string, number> = {};
    for (const kill of fired) statuses[kill.status] = (statuses[kill.status] ?? 0) + 1;
    const report: KillSloReport = buildSloReport({
      mode: chaos.mode,
      runs: fleet.runs.length,
      killStatuses: statuses,
      egressSamplesMs: fired.flatMap((k) => egressSamples(k.metrics.latencies)),
      haltSamplesMs: fired.flatMap((k) => k.metrics.halts),
      generatedAt: new Date().toISOString(),
    });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    expect(report.killsFired).toBe(plans.length);
    expect(statuses).toEqual({ halted: plans.length });
    if (chaos.mode === 'mock') {
      expectMockStateSettled(fleet.runs);
    }
    assertWithinBudgets(report);
  });
});

if (chaos.mode === 'mock') {
  describe('kill fault injection (mock control plane)', () => {
    beforeEach(startControlPlane);
    afterEach(stopControlPlane);

    const faultDeadlines = {
      sandboxDeadlineMs: FAULT_DEADLINE_MS,
      keyDeadlineMs: FAULT_DEADLINE_MS,
    };
    const killId = (n: number): string => fleetUuid(FAULT_KILL_BASE + n);
    const tenantKill = (): PlannedKill => {
      const plan = planKills(buildFleet(4)).find((p) => p.scope === 'tenant');
      if (plan === undefined) throw new Error('fleet produced no tenant kill');
      return plan;
    };
    const withFaults = (faults: Partial<ControlFaults>): void => {
      requirePlane().faults = { ...NO_FAULTS, ...faults };
    };

    it('kill.chaos.failclosed: egress ack lost after the block applied; post-block traffic is denied', async () => {
      withFaults({ egress: { kind: 'apply_then_fail_ack' } });
      const plan = tenantKill();
      const kill = await fireKill(plan, urls, faultDeadlines, killId(1));
      expect(kill.status).toBe('partially_halted');
      expect(kill.repo.event.completedAt).not.toBeNull();
      expect(kill.repo.event.egressBlockedAt).toBeNull();
      expect(kill.metrics.partial).toBeGreaterThan(0);
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
      // Later traffic attempts, after the kill has finished, are still denied.
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
    });

    it('kill.chaos.failclosed: egress unreachable; the gateway fails closed and the kill completes partially_halted', async () => {
      withFaults({ egress: { kind: 'fail_before_apply' } });
      const plan = tenantKill();
      const kill = await fireKill(plan, urls, faultDeadlines, killId(2));
      expect(kill.status).toBe('partially_halted');
      expect(kill.repo.event.egressBlockedAt).toBeNull();
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
    });

    it('a sandbox terminate ack failure completes partially_halted with egress blocked and keys revoked', async () => {
      withFaults({ sandbox: { kind: 'fail_before_apply' } });
      const plan = tenantKill();
      const kill = await fireKill(plan, urls, faultDeadlines, killId(3));
      expect(kill.status).toBe('partially_halted');
      expect(kill.repo.event.egressBlockedAt).not.toBeNull();
      expect(kill.repo.event.keysRevokedAt).not.toBeNull();
      expect(kill.repo.event.workflowsCancelledAt).not.toBeNull();
      expect(kill.repo.event.completedAt).not.toBeNull();
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
    });

    it('a key revoke ack failure completes partially_halted with egress blocked and sandboxes gone', async () => {
      withFaults({ keys: { kind: 'fail_before_apply' } });
      const plan = tenantKill();
      const kill = await fireKill(plan, urls, faultDeadlines, killId(4));
      expect(kill.status).toBe('partially_halted');
      expect(kill.repo.event.egressBlockedAt).not.toBeNull();
      expect(kill.repo.event.sandboxesTerminatedAt).not.toBeNull();
      expect(kill.repo.event.completedAt).not.toBeNull();
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
    });

    it('a delayed egress ack past the 2 s budget still denies traffic before the ack arrives', async () => {
      withFaults({ egress: { kind: 'delay_ack', ms: 2_500 } });
      const plan = tenantKill();
      const kill = await fireKill(plan, urls, {}, killId(5));
      expect(kill.status).toBe('partially_halted');
      const [egressMs = 0] = egressSamples(kill.metrics.latencies);
      expect(egressMs).toBeGreaterThanOrEqual(2_000);
      for (const run of plan.targets.runIds) expect(trafficDenied(run)).toBe(true);
    });
  });
}
