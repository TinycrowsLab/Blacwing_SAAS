import { isChallengeExpired } from '@blackwing/domain';

import { DnsResolverUnavailableError, observeDnsTxt, type DnsTxtObservation } from './observe.js';
import { temporalActivityRuntime } from '../../run/execution/activity-context.js';

import type { DnsResolver } from './resolver.js';
import type { VerificationChallengeStatus, VerificationMethod } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

/**
 * The DNS TXT ownership probe as a Temporal activity (ASSET-005, CONTEXT_PACK §8.10). The worker resolves the proof;
 * the API never does. A definitive answer (matched, or a clean miss) is applied to the challenge through the
 * verification state machine. A resolver outage is a retryable error: the activity is retried and the challenge is
 * left as it was, so an outage can never fail an asset.
 */

/** The challenge fields the probe needs, read inside the tenant context. */
export interface DnsChallenge {
  readonly challengeId: string;
  readonly assetId: string;
  readonly method: VerificationMethod;
  /** The full record value (`blackwing-site-verification=<token>`). */
  readonly token: string;
  /** The DNS name to query (`_blackwing-challenge.<host>`); null for a method with no probe location. */
  readonly expectedLocation: string | null;
  readonly status: VerificationChallengeStatus;
  readonly expiresAt: Date;
}

/** What applying a probe answer did: the challenge passed, stays open for another check, failed, or was not open. */
export type DnsProbeOutcome = 'passed' | 'retry' | 'failed' | 'ignored';

/**
 * Persistence of the probe: the challenge is read and, for a definitive answer, the state machine is applied in one
 * tenant transaction (the verification and the asset change and the audit event commit together, §8.8). Every
 * method is tenant-scoped (RLS).
 */
export interface VerificationDnsStore {
  /** The challenge in `tenantId`, or `undefined` when it is missing or belongs to another tenant. */
  load(tenantId: string, challengeId: string): Promise<DnsChallenge | undefined>;
  /** Applies one definitive answer. A challenge that is no longer open is `ignored` and changes nothing. */
  apply(input: {
    readonly tenantId: string;
    readonly challengeId: string;
    readonly matched: boolean;
    readonly at: Date;
  }): Promise<DnsProbeOutcome>;
}

export interface VerificationDnsMetrics {
  /** `asset_verification_dns_total{result}`: one per probe that reached a definitive answer or a resolver failure. */
  result(result: 'passed' | 'not_found' | 'resolver_error'): void;
}

export interface VerificationDnsActivityDeps {
  readonly store: VerificationDnsStore;
  readonly resolver: DnsResolver;
  /** The pinned upstreams, joined; recorded with each observation. */
  readonly resolverLabel: string;
  readonly settings: {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly maxRecords: number;
  };
  readonly metrics: VerificationDnsMetrics;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  /** The clock (UTC). Injected so expiry is testable. */
  readonly now?: () => Date;
  /** The cancellation signal of the running activity. Defaults to the Temporal activity context. */
  readonly cancellation?: () => AbortSignal;
}

export interface VerifyDnsTxtInput {
  /** The tenant that owns the challenge (the RLS context the activity runs under). */
  readonly tenantId: string;
  readonly challengeId: string;
}

/** Why no probe ran. None of these is a failure of the challenge; a skipped probe changes nothing. */
type DnsProbeSkipReason = 'not_found' | 'not_pending' | 'not_dns' | 'no_location' | 'expired';

export type VerifyDnsTxtResult =
  | {
      readonly status: 'checked';
      readonly outcome: DnsProbeOutcome;
      readonly matched: boolean;
      readonly observedValues: readonly string[];
      readonly truncated: boolean;
      readonly chain: readonly string[];
      readonly resolver: string;
      readonly elapsedMs: number;
    }
  | { readonly status: 'skipped'; readonly reason: DnsProbeSkipReason };

export interface VerificationDnsActivities {
  verifyDnsTxtActivity(input: VerifyDnsTxtInput): Promise<VerifyDnsTxtResult>;
}

function skipped(reason: DnsProbeSkipReason): VerifyDnsTxtResult {
  return { status: 'skipped', reason };
}

/** Builds the DNS probe activity over its ports. Idempotent: a re-run of a settled challenge is `ignored`. */
export function createVerificationDnsActivities(
  deps: VerificationDnsActivityDeps,
): VerificationDnsActivities {
  const now = deps.now ?? ((): Date => new Date());
  const cancellation =
    deps.cancellation ?? ((): AbortSignal => temporalActivityRuntime().cancellationSignal);
  const { log } = deps;

  return {
    async verifyDnsTxtActivity(input) {
      const challenge = await deps.store.load(input.tenantId, input.challengeId);
      if (challenge === undefined) return skipped('not_found');
      if (challenge.status !== 'pending') return skipped('not_pending');
      if (challenge.method !== 'dns_txt') return skipped('not_dns');
      const expectedName = challenge.expectedLocation;
      if (expectedName === null) return skipped('no_location');

      const at = now();
      if (isChallengeExpired(challenge.expiresAt, at)) return skipped('expired');

      let observation: DnsTxtObservation;
      try {
        observation = await observeDnsTxt({
          name: expectedName,
          token: challenge.token,
          resolver: deps.resolver,
          resolverLabel: deps.resolverLabel,
          settings: deps.settings,
          signal: cancellation(),
        });
      } catch (error) {
        if (error instanceof DnsResolverUnavailableError) {
          deps.metrics.result('resolver_error');
          log.warn(
            { challengeId: challenge.challengeId, expectedName, code: error.code },
            'dns verification lookup unavailable; the activity is retried',
          );
        }
        throw error;
      }

      const outcome = await deps.store.apply({
        tenantId: input.tenantId,
        challengeId: challenge.challengeId,
        matched: observation.matched,
        at,
      });
      deps.metrics.result(observation.matched ? 'passed' : 'not_found');
      log.info(
        {
          challengeId: challenge.challengeId,
          expectedName,
          matched: observation.matched,
          outcome,
          elapsedMs: observation.elapsedMs,
          recordCount: observation.observedValues.length,
          truncated: observation.truncated,
        },
        'dns verification probe completed',
      );

      return {
        status: 'checked',
        outcome,
        matched: observation.matched,
        observedValues: observation.observedValues,
        truncated: observation.truncated,
        chain: observation.chain,
        resolver: observation.resolver,
        elapsedMs: observation.elapsedMs,
      };
    },
  };
}
