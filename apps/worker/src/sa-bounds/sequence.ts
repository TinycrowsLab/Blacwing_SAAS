import type {
  SaBoundsActivities,
  SaBoundsStatus,
  SaStopReason,
  SaTimeBoundsInput,
  SaTimeBounds,
  SaTimeline,
} from './types.js';

/** What signals change. `version` bumps on every change so a pending wait wakes and re-evaluates. */
export interface SaBoundsSignalState {
  bounds: SaTimeBounds;
  revoked: { readonly revokedAt: string } | null;
  finished: boolean;
  version: number;
}

/** Wait seam: the workflow passes Temporal's `condition`; tests pass a fake clock. */
export interface SaBoundsControl {
  readonly state: SaBoundsSignalState;
  readonly status: { current: SaBoundsStatus };
  /** Resolves when `wake()` is true or `ms` elapsed, whichever is first. */
  waitUntil(wake: () => boolean, ms: number): Promise<void>;
}

/**
 * ORCH-014: the orchestration-side guarantee that no target traffic flows past the SA's bounds.
 * Sequential code over injected activities (unit-testable without a Temporal server, deterministic in
 * the workflow sandbox).
 *
 * Expiry or revocation: egress is blocked FIRST, so nothing can slip out while sessions tear down, then
 * sessions are cancelled, then the run is finalised `expired`. A failing step never skips the steps
 * after it, except that finalising must succeed (its failure fails the workflow so it is retried).
 * Window close: sessions pause and the run pauses until the next window, or, with no window left before
 * expiry, egress is blocked and the run takes the terminal `window_closed` transition.
 */
export async function runSaTimeBounds(
  input: SaTimeBoundsInput,
  acts: SaBoundsActivities,
  ctl: SaBoundsControl,
): Promise<void> {
  const ref = { tenantId: input.tenantId, runId: input.runId };
  const audit = { ...ref, saId: input.saId };
  const setStatus = (patch: Partial<SaBoundsStatus>): void => {
    ctl.status.current = { ...ctl.status.current, ...patch };
  };

  /** Audit never blocks a stop: Temporal retries the activity, and a final failure is not allowed to halt the stop. */
  const safeAudit = async (...args: Parameters<SaBoundsActivities['audit']>): Promise<void> => {
    try {
      await acts.audit(...args);
    } catch {
      // Left to the audit reconciler (AUDIT-*); the stop goes on.
    }
  };

  async function blockFirst(
    reason: SaStopReason | 'window_closed',
    triggerAt: string,
  ): Promise<void> {
    try {
      const result = await acts.blockEgress({ ...audit, reason, triggerAt });
      await safeAudit({
        ...audit,
        event: 'egress.blocked',
        details: { reason, outcome: result.outcome, latencyMs: result.latencyMs },
      });
    } catch {
      // The gateway also blocks on its own expiry check and fails closed (§8.2); keep tearing down.
      await safeAudit({
        ...audit,
        event: 'egress.blocked',
        details: { reason, outcome: 'unconfirmed', latencyMs: null },
      });
    }
  }

  async function cancelQuietly(): Promise<void> {
    try {
      await acts.cancelSessions(ref);
    } catch {
      // The run is finalised and the gateway is blocked; the session manager reaps stragglers.
    }
  }

  async function stopForExpiry(reason: SaStopReason, triggerAt: string): Promise<void> {
    await blockFirst(reason, triggerAt);
    await cancelQuietly();
    await acts.finaliseExpired({ ...ref, reason });
    await safeAudit({
      ...audit,
      event: 'sa.expired',
      details: { reason, triggerAt, expiresAt: ctl.state.bounds.expiresAt },
    });
    setStatus({ phase: 'stopped', stoppedFor: reason, windowCloseAt: null, nextOpenAt: null });
  }

  async function onWindowClosed(timeline: SaTimeline): Promise<'continue' | 'stop'> {
    const terminal = timeline.nextOpenAt === null;
    const details = { nextOpenAt: timeline.nextOpenAt, terminal, at: timeline.now };
    if (terminal) {
      await blockFirst('window_closed', timeline.now);
      await cancelQuietly();
      await acts.applyWindowClosed({ ...ref, terminal: true });
      await safeAudit({ ...audit, event: 'window.closed', details });
      setStatus({ phase: 'stopped', stoppedFor: 'window_closed', nextOpenAt: null });
      return 'stop';
    }
    await acts.pauseSessions(ref);
    await acts.applyWindowClosed({ ...ref, terminal: false });
    await safeAudit({ ...audit, event: 'window.closed', details });
    return 'continue';
  }

  /** Read through a function: signal handlers mutate the state while an activity is awaited. */
  const signalPending = (): boolean => ctl.state.finished || ctl.state.revoked !== null;

  let wasOpen: boolean | undefined;
  for (;;) {
    if (ctl.state.finished) {
      setStatus({ phase: 'finished' });
      return;
    }
    if (ctl.state.revoked !== null) {
      await stopForExpiry('sa_revoked', ctl.state.revoked.revokedAt);
      return;
    }

    const { timeline, waitMs } = await acts.evaluateTimeline({
      ...ctl.state.bounds,
      ...audit,
    });
    // A signal may have landed while the activity ran; honour it before acting on the timeline.
    if (signalPending()) continue;

    if (timeline.phase === 'expired') {
      await stopForExpiry('sa_expired', timeline.expiresAt);
      return;
    }

    const open = timeline.phase === 'open';
    if (wasOpen === true && !open) {
      if ((await onWindowClosed(timeline)) === 'stop') return;
    } else if (wasOpen === false && open) {
      await acts.applyWindowReopened(ref);
      await acts.resumeSessions(ref);
      await safeAudit({ ...audit, event: 'window.reopened', details: { at: timeline.now } });
    }
    wasOpen = open;
    setStatus({
      phase: open ? 'open' : 'closed',
      expiresAt: timeline.expiresAt,
      windowCloseAt: timeline.closeAt,
      nextOpenAt: timeline.nextOpenAt,
    });

    const seen = ctl.state.version;
    await ctl.waitUntil(() => ctl.state.version !== seen, waitMs);
  }
}
