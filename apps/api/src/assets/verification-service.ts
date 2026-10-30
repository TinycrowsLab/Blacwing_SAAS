import { type AuditEmitter, createAuditEmitter } from '@blackwing/audit';
import {
  addDays,
  addHours,
  decideAfterProbe,
  expectedLocationOf,
  IllegalVerificationTransitionError,
  isChallengeExpired,
  methodAppliesToAssetType,
  newVerificationToken,
  transitionVerification,
  type VerificationEventType,
  type VerificationPolicy,
  type VerificationProbe,
  type VerificationProbeTarget,
} from '@blackwing/domain';
import { KillSwitchActiveError, NotFoundError } from '@blackwing/errors';

import {
  type AssetCaller,
  assetAuditInput,
  assetResource,
  authoriseAsset,
  inAssetSpan,
  memberRolesOf,
  rowIdOf,
} from './access.js';
import { auditSqlTx } from './audit-tx.js';
import {
  AssetVerificationMethodNotApplicableError,
  AssetVerificationProbeUnavailableError,
} from './errors.js';

import type { AssetMetrics } from './metrics.js';
import type { AssetPolicyEngine } from './policy.js';
import type { AssetRepository, AssetRow } from './repository.js';
import type { AssetVerificationRepository, ChallengeRow } from './verification-repository.js';
import type {
  AssetVerificationView,
  StartVerificationBody,
  VerificationChallengeView,
  VerificationMethod,
} from '@blackwing/contracts';
import type { TenantTx } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

/**
 * Ownership verification (ASSET-003, CONTEXT_PACK §8.10): start, check and cancel one asset's proof of control.
 * An asset is verified only through a passing probe, and only a verified asset may be targeted (AUTHZ preflight).
 *
 * Every operation authorises as the asset API does (RBAC `asset:verify`, then the Cedar owner check) and runs its
 * state change, challenge write and audit event in one tenant transaction. A check is the exception: a probe is a
 * network call, so it runs between two short transactions and holds no row lock while it waits. The first
 * transaction reserves the probe run (and settles an expired challenge); the second applies the answer to the
 * challenge that is still open, and ignores an answer that arrived for a challenge already settled.
 */

/** The tenant kill switch (§8.4): a halted tenant may not start or probe a verification. Cancel stays allowed. */
interface VerificationHaltState {
  isHalted(tenantId: string): Promise<boolean>;
}

export interface AssetVerificationServiceDeps {
  readonly repository: AssetRepository;
  /** Whether the tenant is halted by a kill that has not been re-enabled (`TenantHaltRepository`). */
  readonly halts: VerificationHaltState;
  readonly verifications: AssetVerificationRepository;
  readonly policy: AssetPolicyEngine;
  /** The deployed probes by method. A method without a probe fails closed (`503`, no attempt is spent). */
  readonly probes: ReadonlyMap<VerificationMethod, VerificationProbe>;
  readonly settings: VerificationPolicy;
  readonly metrics: AssetMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly audit?: AuditEmitter;
  /** The clock (UTC). Injected so expiry is testable; the default is the wall clock. */
  readonly clock?: () => Date;
}

/** What a probe run was turned into, for the metric and the decision. The reason is logged, never returned. */
interface ProbeOutcome {
  readonly passed: boolean;
  readonly result: 'passed' | 'not_found' | 'probe_error';
  readonly reason: string;
}

/** Either the answer is already settled (an expired or raced challenge), or a probe run must be made. */
type CheckStep =
  | { readonly kind: 'settled'; readonly view: AssetVerificationView }
  | {
      readonly kind: 'probe';
      readonly assetRowId: string;
      readonly challengeId: string;
      readonly probe: VerificationProbe;
      readonly target: VerificationProbeTarget;
    };

function toIso(value: Date): string {
  return value.toISOString();
}

function challengeView(
  challenge: ChallengeRow,
  maxCheckAttempts: number,
): VerificationChallengeView {
  return {
    id: challenge.id,
    method: challenge.method,
    status: challenge.status,
    token: challenge.token,
    expectedLocation: challenge.expectedLocation,
    attempts: challenge.attempts,
    maxCheckAttempts,
    expiresAt: toIso(challenge.expiresAt),
    lastCheckedAt: challenge.lastCheckedAt === null ? null : toIso(challenge.lastCheckedAt),
    createdAt: toIso(challenge.createdAt),
    updatedAt: toIso(challenge.updatedAt),
  };
}

export class AssetVerificationService {
  private readonly audit: AuditEmitter;
  private readonly clock: () => Date;

  constructor(private readonly deps: AssetVerificationServiceDeps) {
    this.audit = deps.audit ?? createAuditEmitter();
    this.clock = deps.clock ?? (() => new Date());
  }

  /** The verification state of an asset and its latest challenge. The token is part of it: `asset:verify` only. */
  async get(caller: AssetCaller, assetId: string): Promise<AssetVerificationView> {
    return inAssetSpan('verification.get', () =>
      this.deps.repository.transact('verification.get', async (tx) => {
        const roles = await memberRolesOf(this.deps.repository, tx, caller.userId);
        const row = await this.liveAsset(tx, assetId);
        authoriseAsset(this.deps.policy, caller, roles, 'verify', assetResource(row));
        const challenge = await this.deps.verifications.latestChallenge(tx, row.id);
        return this.viewOf(row, challenge);
      }),
    );
  }

  /**
   * Starts verification: `unverified` to `pending` with a fresh token. Starting again while pending restarts it
   * (a new token when `rotateOnRestart`, and the attempt budget is reset). A verified or rejected asset refuses.
   */
  async start(
    caller: AssetCaller,
    assetId: string,
    body: StartVerificationBody,
  ): Promise<AssetVerificationView> {
    return inAssetSpan('verification.start', () =>
      this.deps.repository.transact('verification.start', async (tx) => {
        const roles = await memberRolesOf(this.deps.repository, tx, caller.userId);
        let row = await this.lockedAsset(tx, assetId);
        authoriseAsset(this.deps.policy, caller, roles, 'verify', assetResource(row));
        await this.refuseWhenHalted(caller.tenantId);
        const now = this.clock();

        let open = await this.deps.verifications.pendingChallenge(tx, row.id);
        if (open !== undefined && isChallengeExpired(open.expiresAt, now)) {
          const settled = await this.expire(tx, caller, row, open);
          row = settled.asset;
          open = undefined;
        }
        if (!methodAppliesToAssetType(body.method, row.type)) {
          throw new AssetVerificationMethodNotApplicableError(body.method, row.type);
        }
        const event: VerificationEventType = open === undefined ? 'start' : 'restart';
        const next = transitionVerification(row.verificationStatus, event);
        const expectedLocation = expectedLocationOf(body.method, row.identifiers);
        const ttlHours = this.deps.settings.challengeTtlHours;

        let challenge: ChallengeRow;
        let newToken: boolean;
        if (open === undefined) {
          newToken = true;
          challenge = await this.deps.verifications.insertChallenge(tx, {
            tenantId: row.tenantId,
            assetId: row.id,
            method: body.method,
            token: newVerificationToken(),
            expectedLocation,
            expiresAt: addHours(now, ttlHours),
          });
          row = await this.deps.verifications.setAsset(tx, row.id, { verificationStatus: next });
          this.deps.metrics.verificationPendingOpened();
        } else {
          newToken = this.deps.settings.rotateOnRestart;
          challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
            method: body.method,
            token: newToken ? newVerificationToken() : open.token,
            expectedLocation,
            attempts: 0,
            expiresAt: addHours(now, ttlHours),
            lastCheckedAt: null,
          });
        }

        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          assetAuditInput(caller, 'asset.verification_started', row, {
            method: body.method,
            restart: open !== undefined,
            newToken,
          }),
        );
        this.deps.logger.info(
          {
            assetId: row.publicId,
            tenantId: caller.tenantId,
            actorId: caller.userId,
            method: body.method,
            restart: open !== undefined,
          },
          'asset.verification_started',
        );
        return this.viewOf(row, challenge);
      }),
    );
  }

  /**
   * Runs one probe against the open challenge. Three transactions: reserve the run (or settle an expired challenge),
   * probe with no lock held, then apply the answer. A pass verifies the asset; a miss counts an attempt and, at the
   * budget, fails the challenge and returns the asset to unverified.
   */
  async check(caller: AssetCaller, assetId: string): Promise<AssetVerificationView> {
    return inAssetSpan('verification.check', async () => {
      const step = await this.deps.repository.transact('verification.check', (tx) =>
        this.reserveProbeRun(tx, caller, assetId),
      );
      if (step.kind === 'settled') return step.view;

      const outcome = await this.runProbe(step.probe, step.target);
      this.deps.metrics.verificationAttempt(step.target.method, outcome.result);
      this.deps.logger.info(
        {
          assetId,
          tenantId: caller.tenantId,
          actorId: caller.userId,
          method: step.target.method,
          result: outcome.result,
          reason: outcome.reason,
        },
        'asset.verification_probe',
      );

      return this.deps.repository.transact('verification.check.apply', (tx) =>
        this.applyProbeRun(tx, caller, step.assetRowId, step.challengeId, outcome),
      );
    });
  }

  /** Cancels a pending verification: the challenge is cancelled and the asset is unverified again. */
  async cancel(caller: AssetCaller, assetId: string): Promise<AssetVerificationView> {
    return inAssetSpan('verification.cancel', () =>
      this.deps.repository.transact('verification.cancel', async (tx) => {
        const roles = await memberRolesOf(this.deps.repository, tx, caller.userId);
        const row = await this.lockedAsset(tx, assetId);
        authoriseAsset(this.deps.policy, caller, roles, 'verify', assetResource(row));
        const next = transitionVerification(row.verificationStatus, 'cancel');
        const open = await this.requireOpen(tx, row, 'cancel');

        const challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
          status: 'cancelled',
        });
        const updated = await this.deps.verifications.setAsset(tx, row.id, {
          verificationStatus: next,
        });
        this.deps.metrics.verificationPendingClosed();
        await this.audit.emitAuditInTx(
          auditSqlTx(tx),
          assetAuditInput(caller, 'asset.verification_cancelled', updated, {
            method: open.method,
          }),
        );
        this.deps.logger.info(
          { assetId: updated.publicId, tenantId: caller.tenantId, actorId: caller.userId },
          'asset.verification_cancelled',
        );
        return this.viewOf(updated, challenge);
      }),
    );
  }

  /** Transaction 1 of a check. Settles an expired challenge, or reserves a probe run for the open one. */
  private async reserveProbeRun(
    tx: TenantTx,
    caller: AssetCaller,
    assetId: string,
  ): Promise<CheckStep> {
    const roles = await memberRolesOf(this.deps.repository, tx, caller.userId);
    const row = await this.lockedAsset(tx, assetId);
    authoriseAsset(this.deps.policy, caller, roles, 'verify', assetResource(row));
    await this.refuseWhenHalted(caller.tenantId);
    const open = await this.requireOpen(tx, row, 'check');

    const now = this.clock();
    if (isChallengeExpired(open.expiresAt, now)) {
      const settled = await this.expire(tx, caller, row, open);
      return {
        kind: 'settled',
        view: this.viewOf(settled.asset, settled.challenge),
      };
    }
    const probe = this.deps.probes.get(open.method);
    if (probe === undefined) throw new AssetVerificationProbeUnavailableError(open.method);
    return {
      kind: 'probe',
      assetRowId: row.id,
      challengeId: open.id,
      probe,
      target: {
        method: open.method,
        token: open.token,
        expectedLocation: open.expectedLocation,
        identifiers: row.identifiers,
      },
    };
  }

  /** Transaction 2 of a check: applies the answer to the challenge if it is still the open one. */
  private async applyProbeRun(
    tx: TenantTx,
    caller: AssetCaller,
    assetRowId: string,
    challengeId: string,
    outcome: ProbeOutcome,
  ): Promise<AssetVerificationView> {
    const row = await this.lockedAsset(tx, assetRowId);
    const open = await this.deps.verifications.pendingChallenge(tx, row.id);
    if (row.verificationStatus !== 'pending' || open?.id !== challengeId) {
      // Settled by another request while the probe ran: report the state, change nothing.
      const latest = await this.deps.verifications.latestChallenge(tx, row.id);
      return this.viewOf(row, latest);
    }

    const now = this.clock();
    if (isChallengeExpired(open.expiresAt, now)) {
      const settled = await this.expire(tx, caller, row, open);
      return this.viewOf(settled.asset, settled.challenge);
    }

    const attempts = open.attempts + 1;
    const maxCheckAttempts = this.deps.settings.maxCheckAttempts;
    const decision = decideAfterProbe(outcome.passed, attempts, maxCheckAttempts);
    if (decision === 'retry') {
      const challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
        attempts,
        lastCheckedAt: now,
      });
      return this.viewOf(row, challenge, maxCheckAttempts);
    }

    if (decision === 'passed') {
      const next = transitionVerification(row.verificationStatus, 'pass');
      const challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
        status: 'passed',
        attempts,
        lastCheckedAt: now,
      });
      const verified = await this.deps.verifications.setAsset(tx, row.id, {
        verificationStatus: next,
        verificationMethod: open.method,
        verifiedAt: now,
        verificationExpiresAt: addDays(now, this.deps.settings.verificationTtlDays),
      });
      this.deps.metrics.verificationPendingClosed();
      await this.audit.emitAuditInTx(
        auditSqlTx(tx),
        assetAuditInput(caller, 'asset.verification_passed', verified, {
          method: open.method,
          attempts,
        }),
      );
      this.deps.logger.info(
        { assetId: verified.publicId, tenantId: caller.tenantId, actorId: caller.userId },
        'asset.verification_passed',
      );
      return this.viewOf(verified, challenge, maxCheckAttempts);
    }

    // The attempt budget is spent: the challenge fails and the asset goes back to unverified.
    const next = transitionVerification(row.verificationStatus, 'fail');
    const challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
      status: 'failed',
      attempts,
      lastCheckedAt: now,
    });
    const unverified = await this.deps.verifications.setAsset(tx, row.id, {
      verificationStatus: next,
    });
    this.deps.metrics.verificationPendingClosed();
    await this.audit.emitAuditInTx(
      auditSqlTx(tx),
      assetAuditInput(caller, 'asset.verification_failed', unverified, {
        method: open.method,
        reason: 'attempts_exhausted',
        attempts,
      }),
    );
    this.deps.logger.info(
      { assetId: unverified.publicId, tenantId: caller.tenantId, actorId: caller.userId },
      'asset.verification_failed',
    );
    return this.viewOf(unverified, challenge, maxCheckAttempts);
  }

  /** Ends a pending challenge whose window closed: the challenge expires and the asset is unverified. */
  private async expire(
    tx: TenantTx,
    caller: AssetCaller,
    row: AssetRow,
    open: ChallengeRow,
  ): Promise<{ asset: AssetRow; challenge: ChallengeRow }> {
    const next = transitionVerification(row.verificationStatus, 'expire');
    const challenge = await this.deps.verifications.updateChallenge(tx, open.id, {
      status: 'expired',
    });
    const asset = await this.deps.verifications.setAsset(tx, row.id, { verificationStatus: next });
    this.deps.metrics.verificationPendingClosed();
    await this.audit.emitAuditInTx(
      auditSqlTx(tx),
      assetAuditInput(caller, 'asset.verification_failed', asset, {
        method: open.method,
        reason: 'challenge_expired',
        attempts: open.attempts,
      }),
    );
    this.deps.logger.info(
      { assetId: asset.publicId, tenantId: caller.tenantId, actorId: caller.userId },
      'asset.verification_failed',
    );
    return { asset, challenge };
  }

  /**
   * The probe run. A probe that throws counts as a miss (`probe_error`, reason only): an unreachable DNS server must
   * not verify an asset, and it must still spend the budget so a broken probe cannot run forever.
   */
  private async runProbe(
    probe: VerificationProbe,
    target: VerificationProbeTarget,
  ): Promise<ProbeOutcome> {
    try {
      const answer = await probe.check(target);
      if (answer.outcome === 'passed') {
        return { passed: true, result: 'passed', reason: 'token_found' };
      }
      return { passed: false, result: 'not_found', reason: answer.reason };
    } catch {
      return { passed: false, result: 'probe_error', reason: 'probe_threw' };
    }
  }

  /** A halted tenant starts and probes nothing: `423 KILL_SWITCH_ACTIVE`, scope `tenant`. */
  private async refuseWhenHalted(tenantId: string): Promise<void> {
    if (await this.deps.halts.isHalted(tenantId)) {
      throw new KillSwitchActiveError('the tenant is halted: verification is blocked', {
        scope: 'tenant',
        detail:
          'The kill switch is active for this tenant: no verification can be started or checked.',
      });
    }
  }

  /** The asset's open challenge, or a refusal: the transition the caller asked for has no open challenge to act on. */
  private async requireOpen(tx: TenantTx, row: AssetRow, eventType: string): Promise<ChallengeRow> {
    const open = await this.deps.verifications.pendingChallenge(tx, row.id);
    if (open === undefined)
      throw new IllegalVerificationTransitionError(row.verificationStatus, eventType);
    return open;
  }

  /** The asset with this path id, locked for the transaction. `404` for an unknown, deleted or foreign id. */
  private async lockedAsset(tx: TenantTx, assetId: string): Promise<AssetRow> {
    const id = rowIdOf(assetId);
    const row = id === undefined ? undefined : await this.deps.verifications.lockLive(tx, id);
    if (row === undefined) throw new NotFoundError('asset not found');
    return row;
  }

  /** The asset with this path id, read without a lock (for `get`). Same `404` as above. */
  private async liveAsset(tx: TenantTx, assetId: string): Promise<AssetRow> {
    const id = rowIdOf(assetId);
    const row = id === undefined ? undefined : await this.deps.repository.findLive(tx, id);
    if (row === undefined) throw new NotFoundError('asset not found');
    return row;
  }

  private viewOf(
    row: AssetRow,
    challenge: ChallengeRow | undefined,
    maxCheckAttempts: number = this.deps.settings.maxCheckAttempts,
  ): AssetVerificationView {
    return {
      assetId: row.id,
      verificationStatus: row.verificationStatus,
      verificationMethod: row.verificationMethod,
      verifiedAt: row.verifiedAt === null ? null : toIso(row.verifiedAt),
      verificationExpiresAt:
        row.verificationExpiresAt === null ? null : toIso(row.verificationExpiresAt),
      challenge: challenge === undefined ? null : challengeView(challenge, maxCheckAttempts),
    };
  }
}
