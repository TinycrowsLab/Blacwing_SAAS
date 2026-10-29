import { canonicalize } from '../concurrency/index.js';

/**
 * The canonical envelope an approval signs (AUTHZ-004, §8.1, §8.9). It is the approved standing authorisation as the
 * gateway will verify it: the scope, ceilings, budgets, windows and validity, with who requested and who approved.
 * Keys are sorted and instants are ISO strings, so the same content always canonicalises to the same bytes.
 */

/** The stored fields the envelope carries. Structural, so the stored row satisfies it. */
export interface EnvelopeSource {
  readonly publicId: string;
  readonly assetIds: readonly string[];
  readonly scopeRules: Record<string, unknown>;
  readonly maxIntrusiveness: string;
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: Record<string, unknown>;
  readonly testWindows: readonly Record<string, unknown>[];
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly requesterId: string;
}

/** The state the approval sets, which the envelope must name. */
export interface ApprovedState {
  readonly approverId: string;
  /** The version the row will hold after the approval. */
  readonly version: number;
}

/** The UTF-8 bytes of the canonical envelope, ready for the signer. */
export function canonicalEnvelope(source: EnvelopeSource, approved: ApprovedState): Uint8Array {
  const body = {
    saId: source.publicId,
    assetIds: [...source.assetIds],
    scopeRules: source.scopeRules,
    maxIntrusiveness: source.maxIntrusiveness,
    preApprovedTestClasses: [...source.preApprovedTestClasses],
    defaultBudgets: source.defaultBudgets,
    testWindows: [...source.testWindows],
    validFrom: source.validFrom.toISOString(),
    expiresAt: source.expiresAt.toISOString(),
    requesterId: source.requesterId,
    approverId: approved.approverId,
    status: 'active',
    version: approved.version,
  };
  return new TextEncoder().encode(canonicalize(body));
}
