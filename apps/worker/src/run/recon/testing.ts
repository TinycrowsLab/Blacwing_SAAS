import { createLogger } from '@blackwing/logger';

import { createReconActivities, type ReconActivityDeps } from './activities.js';
import { executeRecon, type ReconPhaseEnv } from './orchestrate.js';

import type {
  ReconAuditRecord,
  ReconAuditSink,
  ReconMetrics,
  ReconRunFacts,
  ReconRunRepo,
  SurfaceCounts,
  SurfaceReader,
} from './ports.js';
import type { ReconDecision, ReconRef, ReconSessionInput, ReconSessionResult } from './types.js';
import type { ReconPersona } from '@blackwing/domain';

// Test doubles for the recon phase (shared by the unit tests). Not exported from the package.

const TENANT = '0190a000-0000-7000-8000-000000000001';
const RUN_ID = '0190a000-0000-7000-8000-0000000000c1';
export const REF: ReconRef = { tenantId: TENANT, runId: RUN_ID };
const NOW = new Date('2026-01-01T12:00:00.000Z');
const START_OFFSET_MS = 1500;
const DEFAULT_CHILD_COST_USD = 0.1;

export function makeFacts(over: Partial<ReconRunFacts> = {}): ReconRunFacts {
  return {
    runId: RUN_ID,
    tenantId: TENANT,
    state: 'recon',
    mode: 'black',
    budgets: { costCapUsd: 100, maxRequests: 10_000, maxDurationMs: 3_600_000 },
    manifestSuppliesSurface: false,
    ...over,
  };
}

class MemoryRunRepo implements ReconRunRepo {
  constructor(public facts: ReconRunFacts | null = makeFacts()) {}
  load(tenantId: string, runId: string): Promise<ReconRunFacts | null> {
    const f = this.facts;
    return Promise.resolve(f?.tenantId === tenantId && f.runId === runId ? f : null);
  }
}

export class FakeSurface implements SurfaceReader {
  reads = 0;
  /** Reads that reject before one answers (a Neo4j or Postgres blip). */
  failures = 0;
  constructor(public counts: SurfaceCounts = { hosts: 1, endpoints: 3 }) {}
  count(): Promise<SurfaceCounts> {
    this.reads += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('surface store unavailable'));
    }
    return Promise.resolve(this.counts);
  }
}

class MemoryAudit implements ReconAuditSink {
  records: ReconAuditRecord[] = [];
  append(record: ReconAuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

class MemoryMetrics implements ReconMetrics {
  sessions: [string, string, string][] = [];
  durations: number[] = [];
  session(persona: string, mode: string, status: string): void {
    this.sessions.push([persona, mode, status]);
  }
  duration(seconds: number): void {
    this.durations.push(seconds);
  }
}

/** What a stubbed `AgentSessionWorkflow` does for one persona. */
type ChildBehaviour =
  | {
      readonly kind: 'ok';
      readonly costUsd?: number;
      readonly status?: ReconSessionResult['status'];
    }
  | { readonly kind: 'crash' }
  /** Stays running until the parent cancels it. */
  | { readonly kind: 'hang' };

export class CancelledError extends Error {}

export interface Harness {
  readonly repo: MemoryRunRepo;
  readonly surface: FakeSurface;
  readonly audit: MemoryAudit;
  readonly metrics: MemoryMetrics;
  readonly deps: ReconActivityDeps;
  /** Every child the phase dispatched, in dispatch order: the session config it was given. */
  readonly dispatched: ReconSessionInput[];
  /** Cancels the whole phase from outside (kill, SA expiry). */
  readonly kill: () => void;
  readonly run: (
    behaviour?: Partial<Record<ReconPersona, ChildBehaviour>>,
  ) => Promise<ReconDecision>;
}

export function makeHarness(over: { repo?: MemoryRunRepo; surface?: FakeSurface } = {}): Harness {
  const repo = over.repo ?? new MemoryRunRepo();
  const surface = over.surface ?? new FakeSurface();
  const audit = new MemoryAudit();
  const metrics = new MemoryMetrics();
  const deps: ReconActivityDeps = {
    repo,
    surface,
    audit,
    metrics,
    log: createLogger('recon-test'),
    now: () => NOW,
  };
  const dispatched: ReconSessionInput[] = [];
  const pending = new Set<(reason: unknown) => void>();
  const cancelAll = (): void => {
    for (const reject of pending) reject(new CancelledError());
    pending.clear();
  };
  let next = 0;
  let outerCancelled = false;

  const run: Harness['run'] = (behaviour = {}) => {
    const env = (b: Partial<Record<ReconPersona, ChildBehaviour>>): ReconPhaseEnv => ({
      acts: retrying(createReconActivities(deps)),
      runChild: (child) => {
        dispatched.push(child);
        const how = b[child.persona] ?? { kind: 'ok' as const };
        if (outerCancelled) return Promise.reject(new CancelledError());
        if (how.kind === 'crash') return Promise.reject(new Error('child crashed'));
        if (how.kind === 'hang') {
          return new Promise<ReconSessionResult>((_resolve, reject) => {
            pending.add(reject);
          });
        }
        // Resolve on a later tick so the parent sees siblings finish in dispatch order.
        return Promise.resolve().then(() => ({
          sessionId: child.sessionId,
          status: how.status ?? 'completed',
          costUsd: how.costUsd ?? DEFAULT_CHILD_COST_USD,
        }));
      },
      cancelChildren: cancelAll,
      isCancellation: (e) => e instanceof CancelledError,
      newSessionId: () => `session-${String((next += 1))}`,
      startedAtMs: NOW.getTime() - START_OFFSET_MS,
      shield: (fn) => fn(),
    });
    return executeRecon(REF, env(behaviour));
  };

  return {
    repo,
    surface,
    audit,
    metrics,
    deps,
    dispatched,
    kill: () => {
      outerCancelled = true;
      cancelAll();
    },
    run,
  };
}

export { MemoryRunRepo };

/** Retries a throwing activity like Temporal's retry policy (a few attempts), so port blips recover. */
function retrying<T extends object>(acts: T, attempts = 3): T {
  return new Proxy(acts, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        let last: unknown;
        for (let i = 0; i < attempts; i += 1) {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (err) {
            last = err;
          }
        }
        throw last instanceof Error ? last : new Error('activity failed');
      };
    },
  });
}
