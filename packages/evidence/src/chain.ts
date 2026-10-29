import { evidenceChainLink } from '@blackwing/crypto';

/** The fields of one stored evidence item that the chain covers, in stream order. */
export interface ChainedItem {
  readonly prevChain: string | null;
  readonly chain: string;
  readonly sha256: string;
  readonly kind: string;
  readonly role: string;
  readonly size: number;
  readonly objectKey: string;
}

export type ChainVerdict =
  { readonly ok: true; readonly head: string } | { readonly ok: false; readonly index: number };

/**
 * Verifies that `items`, in order, form an unbroken chain (§8.8). Each link must be recomputed from the item's own
 * fields, and each item after the first must point at the link of the item before it. A reordered, dropped, edited
 * or re-pointed item fails at the first position where the chain no longer holds. An empty list never verifies.
 */
export function verifyEvidenceChain(items: readonly ChainedItem[]): ChainVerdict {
  if (items.length === 0) return { ok: false, index: 0 };
  for (const [index, item] of items.entries()) {
    const recomputed = evidenceChainLink({
      prevChain: item.prevChain,
      sha256: item.sha256,
      kind: item.kind,
      role: item.role,
      size: item.size,
      objectKey: item.objectKey,
    });
    if (recomputed !== item.chain) return { ok: false, index };
    if (index > 0 && item.prevChain !== items[index - 1]?.chain) return { ok: false, index };
  }
  const head = items.at(-1)?.chain ?? '';
  return { ok: true, head };
}
