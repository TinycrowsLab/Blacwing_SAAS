import { ValidationError } from '@blackwing/errors';

import { assertLabTarget } from './lab-guard.js';
import {
  bodyDigest,
  evaluateErrorSignature,
  type ErrorSignatureOracle,
  type ObservedResponse,
} from './oracle.js';

import type { ScopeRules } from '@blackwing/contracts';

/**
 * Deterministic replay of one candidate finding (#719, minimal form for #881). The probe is sent `runs`
 * times and must reproduce the oracle every time; the negative control (an ordinary value for the same
 * parameter) must NOT trip the oracle. Only then is the candidate Confirmed. Anything else is Suspected,
 * which is the analyst-only queue (CONTEXT_PACK §3.2 step 9). Model output never decides the outcome.
 */

/** Sends one GET and returns the observed response. The only place network I/O happens. */
export type Fetcher = (url: string) => Promise<ObservedResponse>;

/** Per-request timeout for the lab fetcher. */
export const REPLAY_REQUEST_TIMEOUT_MS = 5_000;

/** A replay plan: the test case it verifies, its declared oracle and the scope it may run under. */
export interface ReplayPlan {
  readonly testCaseId: string;
  readonly oracle: ErrorSignatureOracle;
  readonly probeUrl: string;
  readonly negativeControlUrl: string;
  readonly runs: number;
  readonly scope: ScopeRules;
  /** Pinned lab image reference (§8.9): recorded in the result so a replay names the exact target build. */
  readonly labImage: string;
}

export type ReplayOutcome = 'confirmed' | 'suspected';

export type SuspectReason =
  'probe_not_reproduced' | 'negative_control_triggered' | 'transport_error';

/** One observed exchange, reduced to what evidence may keep: status, verdict and a body digest, not the body. */
export interface ObservedExchange {
  readonly status: number;
  readonly matched: boolean;
  readonly signature?: string;
  readonly bodySha256: string;
}

export interface ReplayResult {
  readonly testCaseId: string;
  readonly oracleId: string;
  readonly labImage: string;
  readonly outcome: ReplayOutcome;
  readonly reasons: readonly SuspectReason[];
  readonly probe: readonly ObservedExchange[];
  readonly negativeControl?: ObservedExchange;
}

const MIN_RUNS = 2;

/**
 * Replays `plan` with `fetch`. Every URL passes {@link assertLabTarget} before the fetcher is called, so an
 * out-of-scope or non-lab URL throws without traffic. A transport failure is never a confirmation.
 */
export async function replayFinding(plan: ReplayPlan, fetch: Fetcher): Promise<ReplayResult> {
  if (!Number.isInteger(plan.runs) || plan.runs < MIN_RUNS) {
    throw new ValidationError(`a replay needs at least ${MIN_RUNS} runs`);
  }
  assertLabTarget(plan.probeUrl, plan.scope);
  assertLabTarget(plan.negativeControlUrl, plan.scope);

  const reasons: SuspectReason[] = [];
  const probe: ObservedExchange[] = [];
  let control: ObservedExchange | undefined;
  try {
    for (let run = 0; run < plan.runs; run += 1) {
      probe.push(await observe(plan.oracle, plan.probeUrl, fetch));
    }
    control = await observe(plan.oracle, plan.negativeControlUrl, fetch);
  } catch {
    reasons.push('transport_error');
  }

  if (reasons.length === 0) {
    if (!probe.every((exchange) => exchange.matched)) reasons.push('probe_not_reproduced');
    if (control?.matched === true) reasons.push('negative_control_triggered');
  }
  const confirmed = reasons.length === 0;
  return {
    testCaseId: plan.testCaseId,
    oracleId: plan.oracle.id,
    labImage: plan.labImage,
    outcome: confirmed ? 'confirmed' : 'suspected',
    reasons,
    probe,
    ...(control === undefined ? {} : { negativeControl: control }),
  };
}

async function observe(
  oracle: ErrorSignatureOracle,
  url: string,
  fetch: Fetcher,
): Promise<ObservedExchange> {
  const response = await fetch(url);
  const verdict = evaluateErrorSignature(oracle, response);
  return {
    status: response.status,
    matched: verdict.matched,
    ...(verdict.signature === undefined ? {} : { signature: verdict.signature }),
    bodySha256: bodyDigest(response.body),
  };
}
