/**
 * Decision logging policy for the PDP (POLICY-004). Denials and evaluation errors are always
 * recorded. Allows follow the configured mode: `all`, `deny_only` (the default) or `sampled`.
 * Sampling never changes a decision; it only decides whether an allow is written down.
 */
export const DECISION_LOG_MODES = ['all', 'deny_only', 'sampled'] as const;
export type DecisionLogMode = (typeof DECISION_LOG_MODES)[number];

export interface DecisionLogPolicy {
  readonly mode: DecisionLogMode;
  /** Fraction of allows written in `sampled` mode, in [0, 1]. */
  readonly sampleRate: number;
  /** Uniform random source in [0, 1) for sampling; injected so tests are exact. */
  readonly random: () => number;
}

export const DEFAULT_DECISION_LOG_POLICY: DecisionLogPolicy = Object.freeze({
  mode: 'deny_only',
  sampleRate: 0.1,
  random: Math.random,
});

/** Builds a validated policy. Unknown modes and rates outside [0, 1] are rejected, never coerced. */
export function createDecisionLogPolicy(
  input: { readonly mode?: string; readonly sampleRate?: number } = {},
  random: () => number = Math.random,
): DecisionLogPolicy {
  const mode = input.mode ?? DEFAULT_DECISION_LOG_POLICY.mode;
  if (!(DECISION_LOG_MODES as readonly string[]).includes(mode)) {
    throw new RangeError(`decision log mode must be one of ${DECISION_LOG_MODES.join(', ')}`);
  }
  const sampleRate = input.sampleRate ?? DEFAULT_DECISION_LOG_POLICY.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new RangeError('decision log sampleRate must be a number between 0 and 1');
  }
  return Object.freeze({ mode: mode as DecisionLogMode, sampleRate, random });
}

/** True when this decision must be written. Denials and errors are always written. */
export function shouldWriteDecisionLog(
  policy: DecisionLogPolicy,
  decision: 'allow' | 'deny',
  errored: boolean,
): boolean {
  if (decision === 'deny' || errored) return true;
  if (policy.mode === 'all') return true;
  if (policy.mode === 'sampled') return policy.random() < policy.sampleRate;
  return false;
}

/**
 * One row of `policy_decision_logs` (POLICY-004). It holds ids, decisions and a digest of the
 * context. Raw context and secrets are never written (§8.7). `nowUtc` is stored so that a decision
 * can be reproduced from the digest and the time.
 */
export interface DecisionLogEntry {
  readonly tenantId: string;
  readonly runId: string | undefined;
  readonly action: string;
  readonly decision: 'allow' | 'deny';
  readonly determiningPolicyIds: readonly string[];
  readonly errored: boolean;
  readonly latencyMs: number;
  readonly contextDigest: string;
  readonly nowUtc: string;
}

/** Port: where decision log entries go. Implementations must tolerate concurrent writes. */
export interface DecisionLogSink {
  write(entry: DecisionLogEntry): Promise<void>;
}
