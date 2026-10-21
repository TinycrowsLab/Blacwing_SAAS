import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SearchAttributeType } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import {
  ASSESSMENT_RUN_WORKFLOW,
  type RunInput,
  type RunStateView,
  type RunState,
} from '@blackwing/contracts';

import { assessmentRunStartOptions } from './start.js';

import type {
  PersistRunStateRequest,
  PersistRunStateResult,
  PhaseResult,
  RunActivities,
  WriteAuditRequest,
} from '../activities/run/types.js';
import type { AssessmentRunWorkflow } from '../workflows/assessment-run.workflow.js';
import type { WorkflowHandle } from '@temporalio/client';

// Test doubles and a Temporal test environment for the AssessmentRunWorkflow tests (ORCH-002).
// Not exported from the package.

/**
 * Recorded happy-path history for the replay determinism test: the protobuf `History`, base64. (The SDK's
 * JSON helpers cannot serialise a history fetched in this process, so the wire format is stored.)
 */
export const REPLAY_HISTORY_PATH = fileURLToPath(
  new URL('./assessment-run.history.b64', import.meta.url),
);

/** Serialises a fetched history for {@link REPLAY_HISTORY_PATH}. */
export function encodeHistory(history: temporal.api.history.v1.IHistory): string {
  return `${Buffer.from(temporal.api.history.v1.History.encode(history).finish()).toString('base64')}\n`;
}

/** Reads the recorded history back. */
export function decodeHistory(base64: string): temporal.api.history.v1.History {
  return temporal.api.history.v1.History.decode(Buffer.from(base64.trim(), 'base64'));
}

export const TENANT = '0190a000-0000-7000-8000-000000000001';
const REQUESTER = '0190a000-0000-7000-8000-0000000000c1';
export const APPROVER = '0190a000-0000-7000-8000-0000000000c2';
export const FINDING = '0190a000-0000-7000-8000-0000000000f1';

const UUID_TAIL = 12;
const POLL_ATTEMPTS = 400;
const POLL_MS = 50;

/** A valid `RunInput` with a fresh run id. */
export function runInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    tenantId: TENANT,
    runId: `0190a000-0000-7000-8000-${randomUUID().slice(-UUID_TAIL)}`,
    saId: '0190a000-0000-7000-8000-0000000000a1',
    requestedBy: REQUESTER,
    mode: 'black',
    assetIds: ['0190a000-0000-7000-8000-0000000000d1'],
    objective: 'Assess the staging web app',
    runManifest: { promptHash: 'sha256:abc' },
    budgets: { costCapUsd: 50, maxRequests: 10_000, maxDurationMs: 3_600_000 },
    ...overrides,
  };
}

export type PhaseName =
  'runPreflight' | 'runRecon' | 'runPlanning' | 'runExecution' | 'runValidation' | 'runReporting';

interface Hold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/** In-memory stand-in for `runs` plus the audit log, with the optimistic-concurrency contract. */
export class RunStubs {
  row: RunStateView = { state: 'draft', version: 0, pauseReason: null };
  readonly audits: WriteAuditRequest[] = [];
  readonly persisted: PersistRunStateRequest[] = [];
  readonly phaseCalls: string[] = [];
  readonly tenants = new Set<string>();
  envelopeValid = true;
  /** Per-phase result override. */
  readonly phaseResults = new Map<PhaseName, PhaseResult>();
  /** Per-phase hard failure (throws every attempt). */
  readonly phaseThrows = new Set<PhaseName | 'persistRunState' | 'writeAudit'>();
  /** Runs once, inside `persistRunState`, before the CAS: simulates a concurrent API write. */
  beforePersist: (() => void) | undefined;
  /** Lost races to report before the CAS is allowed. */
  conflictsToInject = 0;
  private readonly holds = new Map<
    string,
    { reached: () => void; release: () => void; gate: Promise<void> }
  >();

  /** Makes the named activity block until `release()`; `reached` resolves once it is running. */
  hold(name: PhaseName | 'verifyEnvelope' | `audit:${string}`): Hold {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.holds.set(name, { reached, release, gate });
    return { reached: reachedP, release };
  }

  /** Lets every held activity go, so a failing test cannot leave the worker waiting to drain. */
  releaseAll(): void {
    for (const h of this.holds.values()) h.release();
  }

  private async maybeHold(name: string): Promise<void> {
    const h = this.holds.get(name);
    if (h === undefined) return;
    h.reached();
    await h.gate;
  }

  private phase(name: PhaseName) {
    return async (ref: { tenantId: string }): Promise<PhaseResult> => {
      this.phaseCalls.push(name);
      this.tenants.add(ref.tenantId);
      await this.maybeHold(name);
      if (this.phaseThrows.has(name)) throw new Error(`${name} outage`);
      return this.phaseResults.get(name) ?? { outcome: 'ok' };
    };
  }

  readonly activities: RunActivities = {
    persistRunState: (req): Promise<PersistRunStateResult> => {
      if (this.phaseThrows.has('persistRunState')) return Promise.reject(new Error('db outage'));
      this.tenants.add(req.tenantId);
      this.beforePersist?.();
      this.beforePersist = undefined;
      if (this.conflictsToInject > 0) {
        this.conflictsToInject -= 1;
        // The concurrent writer bumped the version without changing the state.
        this.row = { ...this.row, version: this.row.version + 1 };
      }
      if (this.row.version !== req.expectedVersion || this.row.state !== req.from) {
        return Promise.resolve({ outcome: 'conflict', current: { ...this.row } });
      }
      this.persisted.push(req);
      this.row = { state: req.to, version: req.expectedVersion + 1, pauseReason: req.pauseReason };
      return Promise.resolve({ outcome: 'ok', version: this.row.version });
    },
    writeAudit: async (req) => {
      this.tenants.add(req.tenantId);
      await this.maybeHold(`audit:${req.intent.event}`);
      if (this.phaseThrows.has('writeAudit')) throw new Error('audit outage');
      this.audits.push(req);
    },
    verifyEnvelope: async (req) => {
      this.tenants.add(req.tenantId);
      await this.maybeHold('verifyEnvelope');
      return this.envelopeValid;
    },
    runPreflight: this.phase('runPreflight'),
    runRecon: this.phase('runRecon'),
    runPlanning: this.phase('runPlanning'),
    runExecution: this.phase('runExecution'),
    runValidation: this.phase('runValidation'),
    runReporting: this.phase('runReporting'),
  };

  /** States the row went through, in order (from the persisted CAS writes). */
  get path(): RunState[] {
    return ['draft', ...this.persisted.map((p) => p.to)];
  }
}

export interface RunHarness {
  readonly env: TestWorkflowEnvironment;
  readonly taskQueue: string;
  /** Runs `body` with a worker serving `stubs`. */
  withWorker<T>(stubs: RunStubs, body: () => Promise<T>): Promise<T>;
  teardown(): Promise<void>;
}

/** A local Temporal test server with the search attributes the workflow upserts. */
export async function createRunHarness(): Promise<RunHarness> {
  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      searchAttributes: [
        { name: 'tenantId', type: SearchAttributeType.KEYWORD },
        { name: 'runId', type: SearchAttributeType.KEYWORD },
        { name: 'runState', type: SearchAttributeType.KEYWORD },
      ],
    },
  });
  const taskQueue = `bw-run-test-${randomUUID()}`;
  return {
    env,
    taskQueue,
    withWorker: async (stubs, body) => {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: new URL('../workflows/index.ts', import.meta.url).pathname,
        activities: { ...stubs.activities },
        shutdownGraceTime: '1s',
      });
      // Held activities are let go before the worker drains, or shutdown would wait for them forever.
      return worker.runUntil(
        body().finally(() => {
          stubs.releaseAll();
        }),
      );
    },
    teardown: async () => {
      await env.teardown();
    },
  };
}

/** Polls the workflow's `getState` query until it reports `state` (or fails after ~20 s). */
export async function waitForState(
  handle: { query<T>(name: string): Promise<T> },
  state: RunState,
): Promise<RunStateView> {
  let last: RunStateView | undefined;
  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    last = await handle.query<RunStateView>('getState');
    if (last.state === state) return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`run never reached ${state}; last ${JSON.stringify(last)}`);
}

export const USER_APPROVER = { kind: 'user', id: APPROVER } as const;
export const USER_REQUESTER = { kind: 'user', id: REQUESTER } as const;

export type RunHandle = WorkflowHandle<typeof AssessmentRunWorkflow>;

/** Starts a run through the production start options, on the test queue. */
export function startRun(harness: RunHarness, input: RunInput = runInput()): Promise<RunHandle> {
  return harness.env.client.workflow.start<typeof AssessmentRunWorkflow>(ASSESSMENT_RUN_WORKFLOW, {
    ...assessmentRunStartOptions(input),
    taskQueue: harness.taskQueue,
  });
}
