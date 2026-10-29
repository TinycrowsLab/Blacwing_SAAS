import { AppError, type AppErrorOptions, ForbiddenError, ValidationError } from '@blackwing/errors';

import { nextVersion } from '../run/state.js';

import type { SaStatus } from '@blackwing/contracts';

/**
 * Standing-authorisation state machine (AUTHZ-001, CONTEXT_PACK §7, §8.1, §8.4).
 *
 * Pure and side-effect free: it takes values and returns values, never reads the database or a clock
 * (the caller passes `now`), and emits no logs. The service layer (AUTHZ-002/008) persists `next` with
 * optimistic concurrency on `version` (a losing writer reloads and retries), writes `auditIntent` as
 * `authz.sa.state_changed` (§8.8), and logs and counts the transition.
 *
 *   draft --submit--> pending_approval --approve--> active --expire--> expired
 *                            |                        |
 *                            +----reject--> draft     +----revoke----> revoked
 *
 * `expired` and `revoked` are terminal. Approve and reject are decisions by a person other than the
 * requester (separation of duties, §8.4); the system never decides. Expiry is refused before
 * `expires_at`, so a scheduler cannot end an SA early by mistake.
 */

/** Every event the SA lifecycle accepts. */
export const SA_EVENT_TYPES = ['submit', 'approve', 'reject', 'expire', 'revoke'] as const;
export type SaEventType = (typeof SA_EVENT_TYPES)[number];

/** The single source of truth for legal transitions: `SA_TRANSITIONS[event]` names its source and target. */
export const SA_TRANSITIONS: Readonly<
  Record<SaEventType, { readonly from: SaStatus; readonly to: SaStatus }>
> = Object.freeze({
  submit: { from: 'draft', to: 'pending_approval' },
  approve: { from: 'pending_approval', to: 'active' },
  reject: { from: 'pending_approval', to: 'draft' },
  expire: { from: 'active', to: 'expired' },
  revoke: { from: 'active', to: 'revoked' },
});

/** The fields of a standing authorisation the lifecycle reads or changes. */
export interface SaState {
  readonly status: SaStatus;
  /** `standing_authorisations.version`: bumped by every accepted transition. */
  readonly version: number;
  readonly requesterId: string;
  /** Set by `approve`; `null` until then. */
  readonly approverId: string | null;
  readonly expiresAt: Date;
  /** Set by `revoke`; `null` otherwise. */
  readonly revocationReason: string | null;
}

/** Who triggers a transition. The audit actor; the caller fills in real ids. */
export interface SaActor {
  readonly kind: 'user' | 'system';
  readonly id: string;
}

/** Facts the caller supplies for the guards. The domain layer never looks anything up itself. */
export interface SaTransitionContext {
  readonly actor: SaActor;
  /** The caller's clock, used by the expiry guard. */
  readonly now: Date;
  /** Required by `revoke`: why the authorisation is withdrawn. */
  readonly revocationReason?: string | undefined;
}

/** What the service must write to `audit_events` for a transition (§8.8). */
export interface SaAuditIntent {
  /** Stable audit event name for every SA transition. */
  readonly event: 'authz.sa.state_changed';
  readonly eventType: SaEventType;
  readonly from: SaStatus;
  readonly to: SaStatus;
  readonly actor: SaActor;
}

export interface SaTransitionResult {
  readonly next: SaState;
  readonly auditIntent: SaAuditIntent;
}

/** Raised when the lifecycle refuses an event from the current state (or a time precondition). `AUTHZ_ILLEGAL_TRANSITION` (409). */
export class IllegalSaTransitionError extends AppError {
  declare readonly code: 'AUTHZ_ILLEGAL_TRANSITION';
  /** State the authorisation was in. */
  readonly from: string;
  /** Event that was refused. */
  readonly eventType: string;

  constructor(from: string, eventType: string, options: AppErrorOptions = {}) {
    super(
      'AUTHZ_ILLEGAL_TRANSITION',
      `Illegal standing authorisation transition: ${from} on ${eventType}`,
      {
        detail: `A standing authorisation cannot "${eventType}" from "${from}".`,
        ...options,
      },
    );
    this.from = from;
    this.eventType = eventType;
  }
}

function forbid(detail: string): never {
  throw new ForbiddenError('Standing authorisation guard refused the event', { detail });
}

/** §8.4: a decision needs a person, and that person must not be the requester. */
function requireSeparatedDecider(requesterId: string, actor: SaActor): void {
  if (actor.kind !== 'user') forbid('A person must decide on this standing authorisation.');
  if (actor.id === requesterId) {
    forbid('The approver must be a different person from the requester.');
  }
}

/**
 * Applies `event` to `sa` and returns the next state and the audit intent.
 *
 * Refusals: an event that is not legal from the current status throws `IllegalSaTransitionError`
 * (`AUTHZ_ILLEGAL_TRANSITION`, 409), including an unknown event string. A decision by the requester or
 * by the system throws `ForbiddenError`. `expire` before `expiresAt` (or with an invalid `now`) throws
 * `IllegalSaTransitionError`. A `revoke` without a non-blank reason throws `ValidationError`.
 * The input is never mutated.
 */
export function transitionSa(
  sa: SaState,
  event: SaEventType,
  ctx: SaTransitionContext,
): SaTransitionResult {
  if (!Object.hasOwn(SA_TRANSITIONS, event)) throw new IllegalSaTransitionError(sa.status, event);
  const rule = SA_TRANSITIONS[event];
  if (sa.status !== rule.from) throw new IllegalSaTransitionError(sa.status, event);

  let revocationReason = sa.revocationReason;
  switch (event) {
    case 'submit':
      break;
    case 'approve':
    case 'reject':
      requireSeparatedDecider(sa.requesterId, ctx.actor);
      break;
    case 'expire':
      // Written as a negation so an invalid `now` (NaN) also refuses instead of expiring.
      if (!(ctx.now.getTime() >= sa.expiresAt.getTime())) {
        throw new IllegalSaTransitionError(sa.status, event, {
          detail: 'The standing authorisation has not reached its expiry yet.',
        });
      }
      break;
    case 'revoke': {
      const reason = ctx.revocationReason?.trim() ?? '';
      if (reason === '') {
        throw new ValidationError('A revocation needs a reason.', {
          detail: 'Give a reason for revoking this standing authorisation.',
        });
      }
      revocationReason = reason;
      break;
    }
  }

  const next: SaState = {
    ...sa,
    status: rule.to,
    version: nextVersion(sa.version),
    approverId: event === 'approve' ? ctx.actor.id : sa.approverId,
    revocationReason,
  };
  return {
    next,
    auditIntent: {
      event: 'authz.sa.state_changed',
      eventType: event,
      from: sa.status,
      to: rule.to,
      actor: ctx.actor,
    },
  };
}
