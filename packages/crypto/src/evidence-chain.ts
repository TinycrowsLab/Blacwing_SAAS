import { createHash } from 'node:crypto';

/**
 * Content hashing and the evidence hash chain (EVIDENCE, CONTEXT_PACK §7 `evidence_items.chain`, §8.8). Every
 * evidence item stores the SHA-256 of its bytes and a link hash over its own metadata and the link hash of the
 * item before it in the same run's stream. Editing, dropping or reordering an item breaks a link, so a
 * tampered trail can never verify. The link covers the object key, so an item cannot be re-pointed at other
 * bytes either.
 */

/** Link input for the first item of a stream: 64 zeros, a value no SHA-256 link can be mistaken for. */
const SHA256_HEX_LENGTH = 64;
export const EVIDENCE_GENESIS_CHAIN = '0'.repeat(SHA256_HEX_LENGTH);

/** Fields that go into a link, in order. Any field containing a newline is refused: it would make links ambiguous. */
export interface EvidenceChainLinkInput {
  readonly prevChain: string | null;
  readonly sha256: string;
  readonly kind: string;
  readonly role: string;
  readonly size: number;
  readonly objectKey: string;
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The chain link hash of one evidence item (lowercase hex SHA-256). Deterministic and order-sensitive. */
export function evidenceChainLink(input: EvidenceChainLinkInput): string {
  const fields = [
    input.prevChain ?? EVIDENCE_GENESIS_CHAIN,
    input.sha256,
    input.kind,
    input.role,
    String(input.size),
    input.objectKey,
  ];
  if (fields.some((field) => field.includes('\n'))) {
    throw new TypeError('evidence chain: fields must not contain a newline');
  }
  return sha256Hex(fields.join('\n'));
}
