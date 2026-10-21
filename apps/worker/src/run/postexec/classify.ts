import type { CandidateOutcome, Gate3FindingDecision, Refusal, ValidatorVerdict } from './types.js';

// Pure routing rules for the post-execution phases. Bundled into nothing but unit-tested directly.
// Validation judgement itself belongs to VALIDATE; this only routes a verdict (REFERENCES §7, §8.11).

/**
 * Confirmed needs the oracle to hold, the negative control to stay silent, and both the evidence bundle
 * and the standalone repro artifact (F18). Anything else is suspected: the split is deterministic and
 * fails closed, so a verdict that is ambiguous can never reach Gate 3.
 */
export function classifyVerdict(findingId: string, verdict: ValidatorVerdict): CandidateOutcome {
  if (!verdict.oraclePassed) return { findingId, outcome: 'suspected', reason: 'ORACLE_FAILED' };
  if (verdict.negativeControlFired) {
    return { findingId, outcome: 'suspected', reason: 'NEGATIVE_CONTROL_FIRED' };
  }
  if (verdict.evidenceBundleId === null || verdict.reproArtifactId === null) {
    return { findingId, outcome: 'suspected', reason: 'EVIDENCE_MISSING' };
  }
  return {
    findingId,
    outcome: 'confirmed',
    evidenceBundleId: verdict.evidenceBundleId,
    reproArtifactId: verdict.reproArtifactId,
  };
}

/** `accepted_risk` needs a non-blank reason and an expiry that parses and lies in the future (§3.4). */
export function acceptedRiskValid(decision: Gate3FindingDecision, now: Date): boolean {
  if (decision.reason === undefined || decision.reason.trim() === '') return false;
  if (decision.expiresAt === undefined) return false;
  const expires = Date.parse(decision.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

/**
 * Drops repeated decisions for the same finding within one signal. The first wins; a later one with a
 * different decision is a conflict and refused rather than silently resolved.
 */
export function dedupeDecisions(decisions: readonly Gate3FindingDecision[]): {
  readonly unique: readonly Gate3FindingDecision[];
  readonly conflicts: readonly Refusal[];
} {
  const seen = new Map<string, Gate3FindingDecision>();
  const conflicts: Refusal[] = [];
  for (const d of decisions) {
    const prior = seen.get(d.findingId);
    if (prior === undefined) seen.set(d.findingId, d);
    else if (prior.decision !== d.decision) {
      conflicts.push({ findingId: d.findingId, code: 'DECISION_CONFLICT' });
    }
  }
  return { unique: [...seen.values()], conflicts };
}
