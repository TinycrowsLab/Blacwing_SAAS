import {
  isKillOpen,
  isRole,
  KILL_PHASES,
  KILL_REASON_MIN,
  LIMITS,
  ROLE_PERMISSIONS,
  type KillApiScope,
  type KillEventStatus,
  type KillEventView,
  type KillScope,
} from '@blackwing/contracts';

/** Live status is re-read this often while a kill is open (§8.5: the user watches the halt happen). */
const LIVE_POLL_MS = 1000;
/** Backoff for a failed status read: 1 s, 2 s, 4 s … capped at 30 s. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
/** Failed status reads retried before the panel says the status is unavailable. */
export const MAX_STATUS_RETRIES = 6;
const MS_PER_SECOND = 1000;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;

export const KILL_SCOPE_LABELS: Readonly<Record<KillScope, string>> = {
  run: 'Run',
  asset: 'Asset',
  tenant: 'Tenant',
  global: 'Platform',
};

/** A run or asset kill names its target; a tenant kill names none (the tenant is the session's). */
export function scopeNeedsRef(scope: KillApiScope): boolean {
  return scope === 'run' || scope === 'asset';
}

/**
 * Cosmetic role gate (enforcement is server-side, §8.11). The role must hold `kill:trigger`. An asset
 * owner may kill only assets they own, and only an org admin may stop the whole tenant (the API's
 * contract for `POST /v1/kill`).
 */
export function canTriggerKill(
  roles: readonly string[],
  target: { readonly scope: KillApiScope; readonly ownsAsset?: boolean },
): boolean {
  const capable = roles.filter(
    (role) => isRole(role) && ROLE_PERMISSIONS[role].includes('kill:trigger'),
  );
  if (target.scope === 'tenant') return capable.includes('org_admin');
  return capable.some((role) => role !== 'asset_owner' || target.ownsAsset === true);
}

/** Reason is required: at least `KILL_REASON_MIN` characters once trimmed, within the contract's maximum. */
export function isKillReasonValid(reason: string): boolean {
  return reason.trim().length >= KILL_REASON_MIN && reason.length <= LIMITS.reasonMax;
}

export type StageState = 'pending' | 'confirmed' | 'degraded' | 'not_needed';

export interface TimelineStage {
  readonly key: string;
  readonly label: string;
  readonly state: StageState;
  /** Milliseconds from the trigger to the confirmation, or null when not confirmed. */
  readonly atMs: number | null;
}

/**
 * The §8.5 stages in execution order (egress, sandboxes, keys, workflows), each from what the server
 * confirmed. A stage the server never confirmed is `degraded` when the kill ended partial or failed,
 * `pending` while it is open, and `not_needed` when the kill halted with nothing in scope.
 */
export function killTimeline(event: KillEventView): readonly TimelineStage[] {
  const triggered = Date.parse(event.triggeredAt);
  const nothingRunning = event.status === 'halted' && event.haltMs === 0;
  const ended = event.status === 'partially_halted' || event.status === 'failed';
  return KILL_PHASES.map((phase) => {
    const at = event[phase.field];
    if (at !== null) {
      const atMs = Math.max(0, Date.parse(at) - triggered);
      return { key: phase.key, label: phase.label, state: 'confirmed', atMs: finite(atMs) };
    }
    const state: StageState = nothingRunning ? 'not_needed' : ended ? 'degraded' : 'pending';
    return { key: phase.key, label: phase.label, state, atMs: null };
  });
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Live polling runs only while the kill is open; a settled kill is read once more and then stops. */
export function killPollInterval(status: KillEventStatus | undefined): number | false {
  return status === undefined || isKillOpen(status) ? LIVE_POLL_MS : false;
}

/** Exponential backoff for a failed status read (attempt 1 is the first retry). */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
}

/** A refused, missing or invalid kill is not transient: retrying it would only repeat the answer. */
export function isRetryableKillError(status: number | undefined): boolean {
  return ![HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE].includes(status ?? 0);
}

/** `820 ms`, `3.3 s`; `Measuring` until the server reports a halt time. */
export function formatHaltMs(ms: number | null): string {
  if (ms === null) return 'Measuring';
  return ms < MS_PER_SECOND
    ? `${String(Math.max(0, Math.round(ms)))} ms`
    : `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}
