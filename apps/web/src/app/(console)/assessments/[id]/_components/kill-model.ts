import {
  isRole,
  ROLE_PERMISSIONS,
  TERMINAL_RUN_STATES,
  type KillEventStatus,
  type RunState,
} from '@blackwing/contracts';

/** Egress gateway must block within this many ms (CONTEXT_PACK §8.5, p99 target). */
export const GATEWAY_SLO_MS = 2000;
/** Every sandbox must be terminated within this many ms (§8.5, p99 target). */
export const SANDBOX_SLO_MS = 10_000;

/**
 * The run's kill record as the console shows it: the server's `kill_events` row (via `useRun` and the
 * `kill.initiated` / `kill.completed` stream events). Every figure is server-measured; the UI never
 * computes a halt time from its own clock.
 */
export interface KillEventView {
  readonly status: KillEventStatus;
  readonly initiatedAt: string;
  readonly gatewayBlockedMs: number | null;
  readonly sandboxesTerminatedMs: number | null;
  readonly completedAt: string | null;
  /** Display name of the operator who triggered the kill. */
  readonly actor: string | null;
}

/** The run fields the kill controls need. `id` is the UUID the API takes; `publicId` is the `run_…` id. */
export interface KillableRun {
  readonly id: string;
  readonly publicId: string;
  readonly state: RunState;
  readonly killEvent: KillEventView | null;
}

/** Run states in which there is nothing left to stop (§3.3 terminal states, plus `released`). */
const KILL_DISABLED_STATES: readonly RunState[] = [...TERMINAL_RUN_STATES, 'released'];

const IN_FLIGHT_STATUSES: readonly KillEventStatus[] = ['initiated', 'propagating'];

/**
 * Cosmetic role gate (enforcement is server-side, §8.11): the role must hold `kill:trigger`, and an
 * Asset Owner only for runs on assets they own.
 */
export function canKillRun(roles: readonly string[], ownsAsset: boolean): boolean {
  return roles.some(
    (role) =>
      isRole(role) &&
      ROLE_PERMISSIONS[role].includes('kill:trigger') &&
      (role !== 'asset_owner' || ownsAsset),
  );
}

/** Whether the run is past the point where a kill means anything. */
export function isRunEnded(run: Pick<KillableRun, 'state' | 'killEvent'>): boolean {
  return KILL_DISABLED_STATES.includes(run.state) || run.killEvent?.status === 'halted';
}

/**
 * True while a kill is under way: the server reports one initiated or propagating (someone else may
 * have pressed the button), or this user's accepted request (`acceptedTriggeredAt`, from the 202) has
 * no completed kill event yet.
 */
export function isKillInFlight(
  killEvent: KillEventView | null,
  acceptedTriggeredAt: string | null,
): boolean {
  if (killEvent?.completedAt === null && IN_FLIGHT_STATUSES.includes(killEvent.status)) {
    return true;
  }
  if (acceptedTriggeredAt === null) return false;
  // Our request is still unsettled unless the server completed an event at least as new as it.
  if (killEvent === null) return true;
  if (killEvent.completedAt === null) return true;
  return Date.parse(killEvent.initiatedAt) < Date.parse(acceptedTriggeredAt);
}

/** Typed confirmation: the operator must enter the run's public id exactly (surrounding space ignored). */
export function isKillConfirmed(typed: string, publicId: string): boolean {
  return publicId !== '' && typed.trim() === publicId;
}

/** Total halt time in ms, from the server's own timestamps; null until the server reports completion. */
export function totalHaltMs(killEvent: KillEventView): number | null {
  if (killEvent.completedAt === null) return null;
  const total = Date.parse(killEvent.completedAt) - Date.parse(killEvent.initiatedAt);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** Within SLO only if the kill fully halted and both stages were measured under their budgets. */
export function isWithinHaltSlo(killEvent: KillEventView): boolean {
  const { gatewayBlockedMs, sandboxesTerminatedMs } = killEvent;
  return (
    killEvent.status === 'halted' &&
    gatewayBlockedMs !== null &&
    sandboxesTerminatedMs !== null &&
    gatewayBlockedMs < GATEWAY_SLO_MS &&
    sandboxesTerminatedMs < SANDBOX_SLO_MS
  );
}

const MS_PER_SECOND = 1000;

/** `820 ms`, `3.3 s`. */
export function formatMs(ms: number): string {
  return ms < MS_PER_SECOND
    ? `${String(Math.round(ms))} ms`
    : `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}
