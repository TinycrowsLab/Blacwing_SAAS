import type {
  RunRef,
  SaBoundsAuditInput,
  SaStopReason,
  WindowCloseOutcome,
  WindowReopenOutcome,
} from './types.js';

/**
 * Ports the SA-bounds activities depend on. The egress gateway control client (EGRESS), the session
 * manager, the run repository (ORCH-002) and the audit ledger writer (AUDIT-002) are owned elsewhere.
 */

/** Egress gateway control: blocks every target request for one run. Idempotent. */
export interface RunEgressBlocker {
  /**
   * Resolves only once the gateway fails closed for the run (`already_blocked` is the idempotent ack).
   * Throws if the gateway cannot be reached or answers no.
   */
  blockRun(
    input: RunRef & { readonly reason: SaStopReason | 'window_closed' },
    signal: AbortSignal,
  ): Promise<'blocked' | 'already_blocked'>;
}

/** Session manager control. */
export interface RunSessionControl {
  /**
   * Ends the run's sessions. A `state_changing` action in flight completes its reversal-journal
   * obligation first, then the session stops.
   */
  cancel(ref: RunRef): Promise<void>;
  pause(ref: RunRef): Promise<void>;
  resume(ref: RunRef): Promise<void>;
}

/**
 * Run state transitions through the domain state machine (`applyTransition`), persisted with the
 * optimistic `state_version` write. Every method is a no-op for a run that is already terminal.
 */
export interface RunLifecycle {
  /** `sa_expired` event: the run becomes `expired`. */
  expire(ref: RunRef, reason: SaStopReason): Promise<void>;
  /**
   * `terminal=false`: `pause` with reason `window_closed` when executing; any other state keeps
   * running its non-traffic work and reports `ignored`. `terminal=true`: `window_closed` event.
   */
  windowClosed(ref: RunRef, terminal: boolean): Promise<WindowCloseOutcome>;
  /** `resume` only for a run paused with reason `window_closed`. */
  windowReopened(ref: RunRef): Promise<WindowReopenOutcome>;
}

export interface SaBoundsAuditSink {
  emit(input: SaBoundsAuditInput): Promise<void>;
}

export interface SaBoundsMetrics {
  /** `blackwing_sa_expiry_total{reason}` */
  saExpiry(reason: SaStopReason): void;
  /** `blackwing_window_transitions_total{kind}` */
  windowTransition(kind: 'closed' | 'reopened' | 'closed_terminal'): void;
  /** `blackwing_egress_block_latency_seconds`: from the expiry instant to the gateway ack. */
  egressBlockLatency(seconds: number): void;
}
