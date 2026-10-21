import { createLogger } from '@blackwing/logger';

import { createSaBoundsActivities } from './activities.js';
import { runSaTimeBounds, type SaBoundsControl, type SaBoundsSignalState } from './sequence.js';

import type {
  RunEgressBlocker,
  RunLifecycle,
  RunSessionControl,
  SaBoundsAuditSink,
  SaBoundsMetrics,
} from './ports.js';
import type {
  SaBoundsActivities,
  SaBoundsAuditInput,
  SaBoundsStatus,
  SaTimeBounds,
  SaTimeBoundsInput,
} from './types.js';

// Test doubles for the SA-bounds sequence (shared by the unit tests). Not exported from the package.

export const TENANT = '0190a000-0000-7000-8000-000000000001';
export const RUN_ID = '0190a000-0000-7000-8000-0000000000b1';
export const SA_ID = '0190a000-0000-7000-8000-0000000000c1';

/** Every port call, in order, across all fakes: the ordering assertions read this. */
type CallLog = string[];

export interface Harness {
  readonly calls: CallLog;
  readonly audits: SaBoundsAuditInput[];
  readonly metrics: { expiry: string[]; transitions: string[]; latencies: number[] };
  readonly status: { current: SaBoundsStatus };
  readonly state: SaBoundsSignalState;
  /** Virtual clock, epoch ms. */
  clock: { ms: number };
  /** Queue a signal at a virtual instant. */
  at(iso: string, apply: (state: SaBoundsSignalState) => void): void;
  failEgress: { times: number };
  failCancel: { on: boolean };
  run(): Promise<void>;
  /** Run state as the fake lifecycle sees it. */
  lifecycle: { state: string };
}

export interface HarnessOptions {
  readonly bounds: SaTimeBounds;
  readonly start: string;
  /** Initial lifecycle state of the run. */
  readonly runState?: string;
}

/** Runs the real sequence over the real activities with fake ports and a virtual clock. */
export function makeHarness(options: HarnessOptions): Harness {
  const calls: CallLog = [];
  const audits: SaBoundsAuditInput[] = [];
  const metricsLog = {
    expiry: [] as string[],
    transitions: [] as string[],
    latencies: [] as number[],
  };
  const clock = { ms: new Date(options.start).getTime() };
  const failEgress = { times: 0 };
  const failCancel = { on: false };
  const lifecycle = { state: options.runState ?? 'executing' };
  const events: { ms: number; apply: (s: SaBoundsSignalState) => void }[] = [];

  const egress: RunEgressBlocker = {
    blockRun: (input) => {
      calls.push(`egress.block:${input.reason}`);
      if (failEgress.times > 0) {
        failEgress.times -= 1;
        return Promise.reject(new Error('gateway unreachable'));
      }
      return Promise.resolve('blocked');
    },
  };
  const sessions: RunSessionControl = {
    cancel: () => {
      calls.push('sessions.cancel');
      return failCancel.on ? Promise.reject(new Error('session manager down')) : Promise.resolve();
    },
    pause: () => {
      calls.push('sessions.pause');
      return Promise.resolve();
    },
    resume: () => {
      calls.push('sessions.resume');
      return Promise.resolve();
    },
  };
  const terminal = (): boolean =>
    ['expired', 'failed', 'cancelled', 'killed', 'completed'].includes(lifecycle.state);
  const runs: RunLifecycle = {
    expire: (_ref, reason) => {
      calls.push(`run.expire:${reason}`);
      if (!terminal()) lifecycle.state = 'expired';
      return Promise.resolve();
    },
    windowClosed: (_ref, isTerminal) => {
      calls.push(`run.windowClosed:${String(isTerminal)}`);
      if (terminal()) return Promise.resolve('ignored');
      if (isTerminal) {
        lifecycle.state = 'failed';
        return Promise.resolve('terminated');
      }
      if (lifecycle.state !== 'executing') return Promise.resolve('ignored');
      lifecycle.state = 'paused:window_closed';
      return Promise.resolve('paused');
    },
    windowReopened: () => {
      calls.push('run.windowReopened');
      if (lifecycle.state !== 'paused:window_closed') return Promise.resolve('ignored');
      lifecycle.state = 'executing';
      return Promise.resolve('resumed');
    },
  };
  const audit: SaBoundsAuditSink = {
    emit: (input) => {
      calls.push(`audit:${input.event}`);
      audits.push(input);
      return Promise.resolve();
    },
  };
  const metrics: SaBoundsMetrics = {
    saExpiry: (r) => metricsLog.expiry.push(r),
    windowTransition: (k) => metricsLog.transitions.push(k),
    egressBlockLatency: (s) => metricsLog.latencies.push(s),
  };

  const acts: SaBoundsActivities = createSaBoundsActivities({
    egress,
    sessions,
    runs,
    audit,
    metrics,
    log: createLogger('sa-bounds-test', { level: 'silent' }),
    now: () => new Date(clock.ms),
  });

  const state: SaBoundsSignalState = {
    bounds: options.bounds,
    revoked: null,
    finished: false,
    version: 0,
  };
  const status = {
    current: {
      phase: 'waiting',
      expiresAt: options.bounds.expiresAt,
      windowCloseAt: null,
      nextOpenAt: null,
      stoppedFor: null,
    } as SaBoundsStatus,
  };
  const ctl: SaBoundsControl = {
    state,
    status,
    waitUntil: (wake, ms) => {
      if (wake()) return Promise.resolve();
      events.sort((a, b) => a.ms - b.ms);
      const next = events[0];
      if (next !== undefined && next.ms <= clock.ms + ms) {
        events.shift();
        clock.ms = Math.max(clock.ms, next.ms);
        next.apply(state);
        state.version += 1;
        return Promise.resolve();
      }
      clock.ms += ms;
      return Promise.resolve();
    },
  };
  const input: SaTimeBoundsInput = {
    ...options.bounds,
    tenantId: TENANT,
    runId: RUN_ID,
    saId: SA_ID,
  };

  return {
    calls,
    audits,
    metrics: metricsLog,
    status,
    state,
    clock,
    at: (iso, apply) => {
      events.push({ ms: new Date(iso).getTime(), apply });
    },
    failEgress,
    failCancel,
    lifecycle,
    run: () => runSaTimeBounds(input, acts, ctl),
  };
}
