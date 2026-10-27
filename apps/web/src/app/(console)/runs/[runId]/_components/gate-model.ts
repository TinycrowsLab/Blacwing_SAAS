import { z } from 'zod';

import {
  isRole,
  isoDateTimeSchema,
  ROLE_PERMISSIONS,
  type Permission,
  type RunEvent,
  type RunPauseReason,
  type RunState,
} from '@blackwing/contracts';

export type GateNumber = 1 | 2 | 3;

/** All gates in display order. */
/** Gate 3 is the last human gate (triage and release). */
export const LAST_GATE = 3;
export const GATES: readonly GateNumber[] = [1, 2, LAST_GATE];
const SUBJECT_MAX = 500;

/** Data the server attaches to a pending gate (`gate_decisions` row / `gate.pending` payload). */
export interface PendingGate {
  readonly gate: GateNumber;
  /** Gate 2 only: the out-of-envelope action class, already redacted by the server (§8.7). */
  readonly subject?: string | null;
  /** Gate 2 only: ISO-8601 UTC `timeout_at`; silence after this instant is a denial. */
  readonly timeoutAt?: string | null;
}

export interface GateRunState {
  readonly state: RunState;
  readonly pauseReason: RunPauseReason | null;
}

/** Permission that lets a role act at each gate, and the role names shown when it cannot (§8.4). */
const GATE_PERMISSION: Readonly<Record<GateNumber, Permission>> = {
  1: 'testplan:approve',
  2: 'gate:decide',
  3: 'finding:release',
};
const GATE_ROLE_LABEL: Readonly<Record<GateNumber, string>> = {
  1: 'Asset Owner',
  2: 'Asset Owner',
  3: 'AppSec Engineer',
};

export function gateRoleLabel(gate: GateNumber): string {
  return GATE_ROLE_LABEL[gate];
}

/** Cosmetic only: the server enforces authorisation and separation of duties (§8.11). */
export function canActAtGate(roles: readonly string[], gate: GateNumber): boolean {
  return roles.some(
    (role) => isRole(role) && ROLE_PERMISSIONS[role].includes(GATE_PERMISSION[gate]),
  );
}

/** §8.4: a Gate 1 requester may not approve their own plan. Unknown identities fail closed. */
export function isOwnGate1Request(
  requesterId: string | null,
  currentUserId: string | null,
): boolean {
  return requesterId === null || currentUserId === null || requesterId === currentUserId;
}

/** The gate a run state is waiting at, if any. */
export function gateForRun(run: GateRunState): GateNumber | null {
  if (run.state === 'awaiting_gate1') return 1;
  if (run.state === 'awaiting_gate3') return LAST_GATE;
  if (run.state === 'paused' && run.pauseReason === 'gate2_pending') return 2;
  return null;
}

const gateEventPayload = z.object({
  gate: z.number().refine((n): n is GateNumber => (GATES as readonly number[]).includes(n)),
  subject: z.string().max(SUBJECT_MAX).nullish(),
  timeoutAt: isoDateTimeSchema.nullish(),
});

/**
 * Folds `gate.pending` / `gate.decided` events (in stream order) into per-gate state. A later event wins;
 * malformed payloads are ignored. `pending` carries the latest data, `decided` means hide.
 */
export function foldGateEvents(
  events: readonly RunEvent[],
): ReadonlyMap<GateNumber, PendingGate | 'decided'> {
  const out = new Map<GateNumber, PendingGate | 'decided'>();
  for (const event of events) {
    if (event.type !== 'gate.pending' && event.type !== 'gate.decided') continue;
    const parsed = gateEventPayload.safeParse(event.payload);
    if (!parsed.success) continue;
    const { gate, subject, timeoutAt } = parsed.data;
    out.set(
      gate,
      event.type === 'gate.decided'
        ? 'decided'
        : { gate, subject: subject ?? null, timeoutAt: timeoutAt ?? null },
    );
  }
  return out;
}

/**
 * The gates to show, ordered 1, 2, 3. A gate shows when the run state says it is pending or a
 * `gate.pending` event arrived, unless a later `gate.decided` hid it. Event data wins over `known`.
 */
export function visibleGates(
  run: GateRunState,
  known: readonly PendingGate[],
  events: readonly RunEvent[],
): PendingGate[] {
  const folded = foldGateEvents(events);
  const byGate = new Map<GateNumber, PendingGate>(known.map((g) => [g.gate, g]));
  const fromState = gateForRun(run);
  const result: PendingGate[] = [];
  for (const gate of GATES) {
    const event = folded.get(gate);
    if (event === 'decided') continue;
    if (event === undefined && fromState !== gate) continue;
    result.push(event ?? byGate.get(gate) ?? { gate });
  }
  return result;
}

export type Countdown =
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly remainingMs: number }
  /** Reached zero while the panel was open. */
  | { readonly kind: 'timed_out' }
  /** Already past `timeout_at` when first seen. */
  | { readonly kind: 'expired' };

/**
 * Time left to `timeoutAt`, measured on the server's clock: `serverOffsetMs` is (server now - client now)
 * taken when the run was fetched, so client drift cannot extend a deadline. `wasRunning` tells a timeout
 * observed live from one that had already passed on load. Nothing here can mean "approved".
 */
export function gate2Countdown(
  timeoutAt: string | null | undefined,
  clientNowMs: number,
  serverOffsetMs: number,
  wasRunning: boolean,
): Countdown {
  if (timeoutAt === null || timeoutAt === undefined) return { kind: 'none' };
  const deadline = Date.parse(timeoutAt);
  if (!Number.isFinite(deadline)) return { kind: 'none' };
  const remainingMs = deadline - (clientNowMs + serverOffsetMs);
  if (remainingMs > 0) return { kind: 'running', remainingMs };
  return { kind: wasRunning ? 'timed_out' : 'expired' };
}

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 60;

/** `1:05:09` / `4:07`. Rounds up so it never shows 0:00 while time remains. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const h = Math.floor(total / (MINUTE * HOUR));
  const m = Math.floor(total / MINUTE) % HOUR;
  const s = total % MINUTE;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}
