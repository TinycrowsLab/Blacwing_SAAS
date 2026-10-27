import { TERMINAL_RUN_STATES, type RunState } from '@blackwing/contracts';

// Single source of the run-state presentation model (CONTEXT_PACK §3.3). The run list badges (LIVERUN-001)
// and the detail timeline both import this module so the two cannot drift when §3.3 changes.

export type { RunState };

/** Badge colour token, a variant of the `Badge` in `@blackwing/ui`. */
export type RunStateTone =
  'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'danger' | 'info';

export type RunPhaseGroup = 'preparation' | 'gate' | 'active' | 'finish';

/** Non-terminal states in the order the run normally moves through them. */
export const RUN_PHASES = [
  'draft',
  'preflight',
  'recon',
  'planning',
  'awaiting_gate1',
  'approved',
  'executing',
  'paused',
  'validating',
  'awaiting_gate3',
  'released',
  'reporting',
  'completed',
] as const satisfies readonly RunState[];
export type RunPhase = (typeof RUN_PHASES)[number];

/** Terminal states other than the happy-path `completed`; shown in their own row. */
export const RUN_TERMINAL_STATES = [
  'completed',
  'cancelled',
  'killed',
  'failed',
  'expired',
] as const satisfies readonly RunState[];

export const RUN_STATE_LABELS: Readonly<Record<RunState, string>> = {
  draft: 'Draft',
  preflight: 'Preflight',
  recon: 'Recon',
  planning: 'Planning',
  awaiting_gate1: 'Awaiting Gate 1',
  approved: 'Approved',
  executing: 'Executing',
  paused: 'Paused',
  validating: 'Validating',
  awaiting_gate3: 'Awaiting Gate 3',
  released: 'Released',
  reporting: 'Reporting',
  completed: 'Completed',
  cancelled: 'Cancelled',
  killed: 'Killed',
  failed: 'Failed',
  expired: 'Expired',
};

export const RUN_STATE_GROUPS: Readonly<Record<RunState, RunPhaseGroup>> = {
  draft: 'preparation',
  preflight: 'preparation',
  recon: 'preparation',
  planning: 'preparation',
  awaiting_gate1: 'gate',
  approved: 'active',
  executing: 'active',
  paused: 'active',
  validating: 'active',
  awaiting_gate3: 'gate',
  released: 'finish',
  reporting: 'finish',
  completed: 'finish',
  cancelled: 'finish',
  killed: 'finish',
  failed: 'finish',
  expired: 'finish',
};

export const RUN_STATE_TONES: Readonly<Record<RunState, RunStateTone>> = {
  draft: 'secondary',
  preflight: 'info',
  recon: 'info',
  planning: 'info',
  awaiting_gate1: 'warning',
  approved: 'info',
  executing: 'default',
  paused: 'warning',
  validating: 'info',
  awaiting_gate3: 'warning',
  released: 'success',
  reporting: 'success',
  completed: 'success',
  cancelled: 'outline',
  killed: 'danger',
  failed: 'danger',
  expired: 'outline',
};

export const PAUSE_REASON_LABELS = {
  gate2_pending: 'Gate 2 pending',
  cost_cap: 'Cost cap reached',
  operator_pause: 'Paused by operator',
  window_closed: 'Window closed',
} as const;

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export type PhaseStatus = 'done' | 'current' | 'upcoming';

/**
 * Status of one timeline step for a run in `state`. A run that ended early (cancelled, killed, failed,
 * expired) does not say how far it got, so no step is marked done; only `completed` finished every phase.
 */
export function phaseStatus(phase: RunPhase, state: RunState): PhaseStatus {
  if (phase === state) return 'current';
  if (state === 'completed') return 'done';
  if (isTerminalState(state)) return 'upcoming';
  return RUN_PHASES.indexOf(phase) < RUN_PHASES.indexOf(state as RunPhase) ? 'done' : 'upcoming';
}
