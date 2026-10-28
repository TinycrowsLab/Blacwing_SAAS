import { createLogger } from '@blackwing/logger';

import type { KillActivityDeps } from './activities.js';
import type {
  EgressAck,
  EgressControlClient,
  KeyAck,
  KeyControlClient,
  ReversalJournal,
  WorkflowAck,
  WorkflowControlClient,
  KillEventRepo,
  KillStageAuditRecord,
  KillStageMetrics,
  SandboxAck,
  SandboxControlClient,
} from './ports.js';
import type { KillEventState, KillPropagationRequest, KillStageColumn } from './types.js';
import type { KillAffected, KillEgressIdentity, KillEventStatus } from '@blackwing/contracts';

// Test doubles for the kill activities (shared by the unit tests). Not exported from the package.

export const TENANT = '0190a000-0000-7000-8000-000000000001';
export const KILL_ID = '0190a000-0000-7000-8000-0000000000aa';
export const RUN_ID = '0190a000-0000-7000-8000-0000000000b1';
export const RUN_ID_2 = '0190a000-0000-7000-8000-0000000000b2';
export const T0 = new Date('2026-01-01T00:00:00.000Z');

export const runIdentity = (runId: string): KillEgressIdentity => ({ kind: 'run', runId });

export function makeRequest(
  identities: readonly KillEgressIdentity[],
  extra: Partial<KillPropagationRequest['targets']> = {},
): KillPropagationRequest {
  return {
    killEventId: KILL_ID,
    tenantId: TENANT,
    scope: 'tenant',
    scopeRefId: null,
    triggeredAt: T0.toISOString(),
    targets: {
      runIds: identities.map((i) => i.runId),
      sessionIds: [],
      sandboxIds: [],
      virtualKeyIds: [],
      egressIdentities: [...identities],
      workflowIds: [],
      ...extra,
    },
  };
}

export class MemoryKillRepo implements KillEventRepo {
  event: KillEventState = {
    id: KILL_ID,
    tenantId: TENANT,
    status: 'initiated',
    triggeredAt: T0,
    egressBlockedAt: null,
    sandboxesTerminatedAt: null,
    keysRevokedAt: null,
    workflowsCancelledAt: null,
    completedAt: null,
    affected: {},
  };
  haltMs: number | null = null;
  writes = 0;

  private owns(tenantId: string, id: string): boolean {
    return tenantId === this.event.tenantId && id === this.event.id;
  }
  get(tenantId: string, id: string): Promise<KillEventState | null> {
    return Promise.resolve(this.owns(tenantId, id) ? this.event : null);
  }
  markStage(tenantId: string, id: string, column: KillStageColumn, at: Date): Promise<boolean> {
    if (!this.owns(tenantId, id) || this.event[column] !== null) return Promise.resolve(false);
    this.event = { ...this.event, [column]: at };
    this.writes += 1;
    return Promise.resolve(true);
  }
  transition(
    tenantId: string,
    id: string,
    to: KillEventStatus,
    from: readonly KillEventStatus[],
  ): Promise<boolean> {
    if (!this.owns(tenantId, id) || !from.includes(this.event.status))
      return Promise.resolve(false);
    this.event = { ...this.event, status: to };
    return Promise.resolve(true);
  }
  mergeAffected(tenantId: string, id: string, patch: Partial<KillAffected>): Promise<void> {
    if (this.owns(tenantId, id)) {
      this.event = { ...this.event, affected: { ...this.event.affected, ...patch } };
    }
    return Promise.resolve();
  }
  complete(
    tenantId: string,
    id: string,
    input: { status: KillEventStatus; completedAt: Date; haltMs: number },
  ): Promise<boolean> {
    if (!this.owns(tenantId, id) || this.event.completedAt !== null) return Promise.resolve(false);
    this.event = { ...this.event, status: input.status, completedAt: input.completedAt };
    this.haltMs = input.haltMs;
    return Promise.resolve(true);
  }
}

export class FakeGateway implements EgressControlClient {
  calls: { identities: KillEgressIdentity[] }[] = [];
  constructor(
    private readonly behave: (
      identities: readonly KillEgressIdentity[],
      call: number,
    ) => readonly EgressAck[] | Error,
  ) {}
  block(request: { identities: readonly KillEgressIdentity[] }): Promise<readonly EgressAck[]> {
    this.calls.push({ identities: [...request.identities] });
    const out = this.behave(request.identities, this.calls.length);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export class FakeSandboxController implements SandboxControlClient {
  calls: { sandboxIds: string[] }[] = [];
  constructor(
    private readonly behave: (
      ids: readonly string[],
      call: number,
    ) => readonly SandboxAck[] | Error = (ids) => ackSandboxes(ids),
  ) {}
  terminate(request: { sandboxIds: readonly string[] }): Promise<readonly SandboxAck[]> {
    this.calls.push({ sandboxIds: [...request.sandboxIds] });
    const out = this.behave(request.sandboxIds, this.calls.length);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export class FakeKeyGateway implements KeyControlClient {
  calls: { keyIds: string[] }[] = [];
  constructor(
    private readonly behave: (ids: readonly string[], call: number) => readonly KeyAck[] | Error = (
      ids,
    ) => ids.map((keyId) => ({ keyId, outcome: 'revoked' as const })),
  ) {}
  revoke(request: { keyIds: readonly string[] }): Promise<readonly KeyAck[]> {
    this.calls.push({ keyIds: [...request.keyIds] });
    const out = this.behave(request.keyIds, this.calls.length);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export class FakeWorkflowCanceller implements WorkflowControlClient {
  calls: { workflowIds: string[] }[] = [];
  constructor(
    private readonly behave: (
      ids: readonly string[],
      call: number,
    ) => readonly WorkflowAck[] | Error = (ids) =>
      ids.map((workflowId) => ({ workflowId, outcome: 'cancelled' as const })),
  ) {}
  cancel(request: { workflowIds: readonly string[] }): Promise<readonly WorkflowAck[]> {
    this.calls.push({ workflowIds: [...request.workflowIds] });
    const out = this.behave(request.workflowIds, this.calls.length);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

export class FakeReversalJournal implements ReversalJournal {
  calls: { runIds: string[] }[] = [];
  constructor(
    private readonly pending = 0,
    private readonly fail = false,
  ) {}
  flagPending(_tenantId: string, _killEventId: string, runIds: readonly string[]): Promise<number> {
    this.calls.push({ runIds: [...runIds] });
    return this.fail ? Promise.reject(new Error('journal down')) : Promise.resolve(this.pending);
  }
}

export const ackSandboxes = (
  ids: readonly string[],
  outcome: SandboxAck['outcome'] = 'terminated',
): SandboxAck[] => ids.map((sandboxId) => ({ sandboxId, outcome }));

export const ackAll = (
  identities: readonly KillEgressIdentity[],
  outcome: EgressAck['outcome'] = 'blocked',
): EgressAck[] => identities.map((identity) => ({ identity, outcome }));

export class RecordingMetrics implements KillStageMetrics {
  latencies: [string, number][] = [];
  results: [string, string][] = [];
  partial = 0;
  stageLatency(stage: string, ms: number): void {
    this.latencies.push([stage, ms]);
  }
  stageResult(stage: string, result: string): void {
    this.results.push([stage, result]);
  }
  keyCount = 0;
  workflowCount = 0;
  keysRevoked(count: number): void {
    this.keyCount += count;
  }
  workflowsCancelled(count: number): void {
    this.workflowCount += count;
  }
  sandboxCount = 0;
  sandboxesTerminated(count: number): void {
    this.sandboxCount += count;
  }
  partialHalt(): void {
    this.partial += 1;
  }
  halts: number[] = [];
  haltMs(ms: number): void {
    this.halts.push(ms);
  }
}

/** Deps wired to fakes with a virtual clock: `sleep` advances time instead of waiting. */
export function makeDeps(
  repo: MemoryKillRepo,
  egress: EgressControlClient,
  overrides: Partial<KillActivityDeps> = {},
) {
  let nowMs = T0.getTime();
  const audits: KillStageAuditRecord[] = [];
  const metrics = new RecordingMetrics();
  const deps: KillActivityDeps = {
    repo,
    egress,
    sandboxes: new FakeSandboxController(),
    keys: new FakeKeyGateway(),
    workflows: new FakeWorkflowCanceller(),
    reversals: new FakeReversalJournal(),
    audit: {
      append: (record) => {
        audits.push(record);
        return Promise.resolve();
      },
    },
    metrics,
    log: createLogger('kill-test'),
    now: () => new Date(nowMs),
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, audits, metrics, advance: (ms: number) => (nowMs += ms) };
}
