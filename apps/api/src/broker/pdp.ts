import {
  type BrokerPdpDecision,
  type BrokerPdpEvaluateRequest,
  type IntrusivenessClass,
  intrusivenessRank,
  requiresReversalJournal,
} from '@blackwing/contracts';

/**
 * The Policy Decision Point of the PreToolUse hook (RUNTIME-005, #467; CONTEXT_PACK §4.3, §8.1, §8.2, §8.3,
 * §8.11). The decision is a pure function of facts the broker loads itself: the caller's claim about scope or
 * intrusiveness is never an input. Every rule is deny by default: a missing envelope, an expired or revoked
 * envelope, a class above the envelope, a `state_changing` call without a journal entry, or a target outside
 * scope each deny. Only the all-clear allows. Out of envelope or out of scope (but not a hard baseline block) answers
 * `exception`, which the hook may turn into a Gate 2 deferral (RUNTIME-006).
 */

/** The standing-authorisation envelope the run executes under (§8.1). */
export interface PdpEnvelope {
  /** Validity is half-open: allowed at exactly `validFrom`, denied at exactly `expiresAt`. */
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly revoked: boolean;
  readonly maxIntrusiveness: IntrusivenessClass;
}

/** The facts one decision reads. `envelope` is `null` when the run has no standing authorisation. */
export interface PdpFacts {
  readonly envelope: PdpEnvelope | null;
  /** The persona's intrusiveness ceiling for this session. Governs calls with no test case. */
  readonly sessionCeiling: IntrusivenessClass;
  /** The class of the test case the call is for, or `null` for a call outside a test case. */
  readonly testCaseClass: IntrusivenessClass | null;
  /** Whether a reversal-journal entry exists for the test case (§8.3). */
  readonly reversalJournalPresent: boolean;
  /** SCOPE-002 matcher over the run's scope rules. Must be `true` for every target that may be reached. */
  readonly inScope: (target: string) => boolean;
}

/** The run a decision is bound to. Taken from the token, never from the body (§8.6). */
export interface PdpRef {
  readonly tenantId: string;
  readonly runId: string;
}

/** Loads the facts for one call inside the run's tenant context. An unknown run yields no envelope. */
export interface PdpFactsReader {
  load(ref: PdpRef, request: BrokerPdpEvaluateRequest): Promise<PdpFacts>;
}

export interface PdpService {
  evaluate(ref: PdpRef, request: BrokerPdpEvaluateRequest): Promise<BrokerPdpDecision>;
}

const deny = (reason: BrokerPdpDecision['reason']): BrokerPdpDecision => ({
  decision: 'deny',
  reason,
});

const exception = (
  reason: BrokerPdpDecision['reason'],
  intrusiveness: IntrusivenessClass,
): BrokerPdpDecision => ({ decision: 'exception', reason, intrusiveness });

/** The decision for one call. Pure: the same facts, request and instant always give the same answer. */
export function decidePdp(
  facts: PdpFacts,
  request: BrokerPdpEvaluateRequest,
  now: Date,
): BrokerPdpDecision {
  const envelope = facts.envelope;
  if (envelope === null) return deny('no_envelope');
  if (envelope.revoked) return deny('envelope_revoked');
  const at = now.getTime();
  if (at < envelope.validFrom.getTime()) return deny('envelope_not_yet_valid');
  if (at >= envelope.expiresAt.getTime()) return deny('envelope_expired');

  const callClass = facts.testCaseClass ?? facts.sessionCeiling;
  if (callClass === 'destructive') return deny('destructive_class');
  const overEnvelope = intrusivenessRank(callClass) > intrusivenessRank(envelope.maxIntrusiveness);
  const overCeiling =
    facts.testCaseClass !== null &&
    intrusivenessRank(facts.testCaseClass) > intrusivenessRank(facts.sessionCeiling);
  // Above the envelope or out of scope is an exception a human may approve (Gate 2). The rest are hard denials.
  if (overEnvelope || overCeiling) return exception('intrusiveness_exceeds_envelope', callClass);
  if (requiresReversalJournal(callClass) && !facts.reversalJournalPresent) {
    return deny('state_change_without_journal');
  }
  if (request.targets.some((target) => !facts.inScope(target))) {
    return exception('out_of_scope', callClass);
  }
  return { decision: 'allow', reason: 'in_envelope' };
}

interface PdpServiceOptions {
  readonly facts: PdpFactsReader;
  readonly now: () => Date;
}

/** The PDP service the broker endpoint answers with. A facts failure throws, so the hook fails closed. */
export function createPdpService(options: PdpServiceOptions): PdpService {
  return {
    async evaluate(ref, request) {
      const facts = await options.facts.load(ref, request);
      return decidePdp(facts, request, options.now());
    },
  };
}
