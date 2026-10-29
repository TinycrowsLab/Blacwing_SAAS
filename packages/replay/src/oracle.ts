import { createHash } from 'node:crypto';

/**
 * Deterministic validation oracles for the replay engine (#719 scope, minimal form for #881). An oracle is
 * declared before a test runs and is evaluated mechanically against the recorded response. It never judges
 * a finding by model output (§8.11). Oracles inspect a response; they send nothing.
 */

/** The response an oracle inspects: status and the decoded body, nothing else. */
export interface ObservedResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * An error-signature oracle: the response matches when its status is exactly `expectedStatus` AND the body
 * contains one of `signatures` (case-sensitive, literal substring). Literal matching keeps the verdict
 * deterministic and free of regex backtracking.
 */
export interface ErrorSignatureOracle {
  readonly id: string;
  readonly type: 'error_signature';
  readonly expectedStatus: number;
  readonly signatures: readonly string[];
}

/** The verdict for one response. `signature` names the first matched signature (never the body). */
export interface OracleVerdict {
  readonly matched: boolean;
  readonly signature?: string;
}

/** Evaluates an error-signature oracle against one recorded response. Pure and deterministic. */
export function evaluateErrorSignature(
  oracle: ErrorSignatureOracle,
  response: ObservedResponse,
): OracleVerdict {
  if (response.status !== oracle.expectedStatus) return { matched: false };
  const signature = oracle.signatures.find((candidate) => response.body.includes(candidate));
  return signature === undefined ? { matched: false } : { matched: true, signature };
}

/** SHA-256 of a response body, so evidence can prove what was observed without storing the body. */
export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
