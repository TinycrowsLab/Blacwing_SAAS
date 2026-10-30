import type { RawObservation, ReplayExchange } from '../engine.js';

const SHA256_HEX_LENGTH = 64;
const ZERO_DIGEST = '0'.repeat(SHA256_HEX_LENGTH);

/** A completed observation for one replay, with the given exchanges. Shared by the evaluator tests. */
export function observationWith(
  exchanges: readonly ReplayExchange[] = [],
  replayId = '0190a000-0000-7000-8000-000000000001',
): RawObservation {
  return {
    replayId,
    candidateId: '0190a000-0000-7000-8000-000000000002',
    testCaseId: 'webapi.authz.bola',
    oracleType: 'access_matrix',
    status: 'completed',
    exchanges,
    evidenceRefs: [],
    replayMs: 1,
    attempts: 1,
    pins: {} as RawObservation['pins'],
  };
}

export function exchange(overrides: Partial<ReplayExchange> = {}): ReplayExchange {
  return {
    stepIndex: 0,
    kind: 'http_request',
    status: 200,
    body: '',
    bodySha256: ZERO_DIGEST,
    truncated: false,
    evidenceRef: 'evidence://replay/0',
    ...overrides,
  };
}
