import { createLogger } from '@blackwing/logger';

import { createKillActivities, type KillActivityDeps } from '../activities.js';
import { createHttpEgressControlClient } from '../egress-client.js';
import { createHttpKeyControlClient } from '../key-client.js';
import { runKillPropagation } from '../propagate.js';
import { createHttpSandboxControlClient } from '../sandbox-client.js';
import {
  FakeReversalJournal,
  FakeWorkflowCanceller,
  makeDeps,
  MemoryKillRepo,
  type RecordingMetrics,
} from '../testing.js';

import type { KillLaterStage, KillPropagationRequest } from '../types.js';
import type { KillApiScope, KillEventStatus, KillTargetSet } from '@blackwing/contracts';

// Fleet model for the chaos scenario: tenants with assets, and non-terminal runs each holding a sandbox,
// a virtual key and a workflow. Kills are planned per run, per asset and per tenant, then fired together.

const HEX_RADIX = 16;
const UUID_TAIL_HEX_DIGITS = 12;

/** A deterministic UUIDv7-shaped id, so runs are reproducible and every id passes the contracts' uuid check. */
export function fleetUuid(n: number): string {
  return `0190a000-0000-7000-8000-${n.toString(HEX_RADIX).padStart(UUID_TAIL_HEX_DIGITS, '0')}`;
}

const TENANT_BASE = 0x100;
const ASSET_BASE = 0x200;
const RUN_BASE = 0x1000;
const KILL_BASE = 0x9000;
const TENANTS = 2;
const ASSETS_PER_TENANT = 2;

export interface FleetRun {
  readonly runId: string;
  readonly tenantId: string;
  readonly assetId: string;
  readonly sandboxId: string;
  readonly keyId: string;
  readonly workflowId: string;
}

export interface Fleet {
  readonly tenantIds: readonly string[];
  readonly assetIds: readonly { readonly assetId: string; readonly tenantId: string }[];
  readonly runs: readonly FleetRun[];
}

/** Seeds `runCount` non-terminal runs spread round-robin over two tenants and their assets. */
export function buildFleet(runCount: number): Fleet {
  const tenantIds = Array.from({ length: TENANTS }, (_, t) => fleetUuid(TENANT_BASE + t));
  const assetIds = tenantIds.flatMap((tenantId, t) =>
    Array.from({ length: ASSETS_PER_TENANT }, (_, a) => ({
      assetId: fleetUuid(ASSET_BASE + t * ASSETS_PER_TENANT + a),
      tenantId,
    })),
  );
  const runs = Array.from({ length: runCount }, (_, i): FleetRun => {
    const asset = assetIds[i % assetIds.length];
    if (asset === undefined) throw new RangeError('fleet has no assets');
    return {
      runId: fleetUuid(RUN_BASE + i),
      tenantId: asset.tenantId,
      assetId: asset.assetId,
      sandboxId: `sbx-${String(i)}`,
      keyId: `vk-${String(i)}`,
      workflowId: `run-wf-${String(i)}`,
    };
  });
  return { tenantIds, assetIds, runs };
}

export interface PlannedKill {
  readonly label: string;
  readonly tenantId: string;
  readonly scope: KillApiScope;
  readonly scopeRefId: string | null;
  readonly targets: KillTargetSet;
}

function targetsFor(runs: readonly FleetRun[]): KillTargetSet {
  return {
    runIds: runs.map((r) => r.runId),
    sessionIds: [],
    sandboxIds: runs.map((r) => r.sandboxId),
    virtualKeyIds: runs.map((r) => r.keyId),
    egressIdentities: runs.map((r) => ({ kind: 'run' as const, runId: r.runId })),
    workflowIds: runs.map((r) => r.workflowId),
  };
}

/** One kill per run (run scope), per asset (asset scope) and per tenant (tenant scope). */
export function planKills(fleet: Fleet): PlannedKill[] {
  const runKills = fleet.runs.map((run): PlannedKill => ({
    label: `run:${run.runId}`,
    tenantId: run.tenantId,
    scope: 'run',
    scopeRefId: run.runId,
    targets: targetsFor([run]),
  }));
  const assetKills = fleet.assetIds.map(({ assetId, tenantId }): PlannedKill => {
    const runs = fleet.runs.filter((r) => r.assetId === assetId);
    return {
      label: `asset:${assetId}`,
      tenantId,
      scope: 'asset',
      scopeRefId: assetId,
      targets: targetsFor(runs),
    };
  });
  const tenantKills = fleet.tenantIds.map((tenantId): PlannedKill => {
    const runs = fleet.runs.filter((r) => r.tenantId === tenantId);
    return {
      label: `tenant:${tenantId}`,
      tenantId,
      scope: 'tenant',
      scopeRefId: null,
      targets: targetsFor(runs),
    };
  });
  return [...runKills, ...assetKills, ...tenantKills];
}

/** Control-plane base URLs. Mock mode points them all at one in-process server; real mode at the live stack. */
export interface ControlUrls {
  readonly egress: string;
  readonly sandbox: string;
  readonly keys: string;
}

export interface KillTimeouts {
  /** Overrides for fault cases only. Load runs keep the §8.5 production budgets. */
  readonly sandboxDeadlineMs?: number;
  readonly keyDeadlineMs?: number;
}

export interface FiredKill {
  readonly plan: PlannedKill;
  readonly killEventId: string;
  readonly status: KillEventStatus;
  readonly repo: MemoryKillRepo;
  readonly metrics: RecordingMetrics;
}

const log = createLogger('kill-chaos', { level: 'warn' });

/** Stage order of the real workflow (KILL-005/006): sandboxes, keys, workflows, each followed by its audit. */
function laterStages(acts: ReturnType<typeof createKillActivities>): KillLaterStage[] {
  return [
    {
      name: 'sandbox',
      async run(request: KillPropagationRequest) {
        const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
        const result = await acts.terminateSandboxes({
          ...ref,
          sandboxIds: request.targets.sandboxIds,
        });
        await acts.auditSandboxesTerminated({ ...ref, result }).catch(() => undefined);
      },
    },
    {
      name: 'keys',
      async run(request: KillPropagationRequest) {
        const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
        const result = await acts.revokeKeys({ ...ref, keyIds: request.targets.virtualKeyIds });
        await acts.auditKeysRevoked({ ...ref, result }).catch(() => undefined);
      },
    },
    {
      name: 'workflows',
      async run(request: KillPropagationRequest) {
        const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
        const result = await acts.cancelWorkflows({
          ...ref,
          workflowIds: request.targets.workflowIds,
          runIds: request.targets.runIds,
        });
        await acts.auditWorkflowsCancelled({ ...ref, result }).catch(() => undefined);
      },
    },
  ];
}

/**
 * Fires one planned kill through the real propagation code (`runKillPropagation` and the kill activities)
 * over the real HTTP adapters and the wall clock. The Temporal wiring is not run here: `laterStages`
 * mirrors `workflows/kill-propagation.ts`, and `kill-propagation.int.test.ts` covers the real workflow.
 */
export async function fireKill(
  plan: PlannedKill,
  urls: ControlUrls,
  timeouts: KillTimeouts,
  killEventId: string,
): Promise<FiredKill> {
  const repo = new MemoryKillRepo();
  repo.event = { ...repo.event, id: killEventId, tenantId: plan.tenantId, triggeredAt: new Date() };
  const overrides: Partial<KillActivityDeps> = {
    sandboxes: createHttpSandboxControlClient({ baseUrl: urls.sandbox }),
    keys: createHttpKeyControlClient({ baseUrl: urls.keys }),
    workflows: new FakeWorkflowCanceller(),
    reversals: new FakeReversalJournal(),
    now: () => new Date(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    ...(timeouts.sandboxDeadlineMs === undefined
      ? {}
      : { sandboxDeadlineMs: timeouts.sandboxDeadlineMs }),
    ...(timeouts.keyDeadlineMs === undefined ? {} : { keyDeadlineMs: timeouts.keyDeadlineMs }),
    log,
  };
  const { deps, metrics } = makeDeps(
    repo,
    createHttpEgressControlClient({ baseUrl: urls.egress }),
    overrides,
  );
  const acts = createKillActivities(deps);
  const request: KillPropagationRequest = {
    killEventId,
    tenantId: plan.tenantId,
    scope: plan.scope,
    scopeRefId: plan.scopeRefId,
    triggeredAt: repo.event.triggeredAt.toISOString(),
    targets: plan.targets,
  };
  await runKillPropagation(request, acts, laterStages(acts), { current: initialProgress() });
  return { plan, killEventId, status: repo.event.status, repo, metrics };
}

function initialProgress() {
  return { received: true, stage: 'waiting' as const, egress: null, completed: false };
}

/** Fires every planned kill at once, so the control plane sees them concurrently. */
export function fireAll(
  plans: readonly PlannedKill[],
  urls: ControlUrls,
  timeouts: KillTimeouts,
): Promise<FiredKill[]> {
  return Promise.all(
    plans.map((plan, i) => fireKill(plan, urls, timeouts, fleetUuid(KILL_BASE + i))),
  );
}
