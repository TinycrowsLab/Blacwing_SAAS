import { describe, expect, it } from 'vitest';

import { verifyEvidenceChain, type ChainedItem } from './chain.js';
import { buildStream, REPLAY_ITEMS } from './test-support.js';

const stream = (): ChainedItem[] => buildStream(REPLAY_ITEMS);

/** A copy of `items` with one position's fields overwritten; the original is left as it was. */
const patched = (items: ChainedItem[], index: number, patch: Partial<ChainedItem>): ChainedItem[] =>
  items.map((item, position) => (position === index ? { ...item, ...patch } : item));

describe('verifyEvidenceChain', () => {
  it('verifies an unbroken stream and returns its head', () => {
    const items = stream();
    expect(verifyEvidenceChain(items)).toEqual({ ok: true, head: items[3]?.chain });
  });

  it('never verifies an empty list', () => {
    expect(verifyEvidenceChain([])).toEqual({ ok: false, index: 0 });
  });

  it('fails at the item whose digest was edited', () => {
    const items = stream();
    expect(verifyEvidenceChain(patched(items, 1, { sha256: 'e'.repeat(64) }))).toEqual({
      ok: false,
      index: 1,
    });
  });

  it('fails when the stored link does not match the item', () => {
    const items = stream();
    expect(verifyEvidenceChain(patched(items, 2, { chain: 'd'.repeat(64) }))).toEqual({
      ok: false,
      index: 2,
    });
  });

  it('fails when two items are swapped', () => {
    const [a, b, c, d] = stream() as [ChainedItem, ChainedItem, ChainedItem, ChainedItem];
    expect(verifyEvidenceChain([a, c, b, d])).toEqual({ ok: false, index: 1 });
  });

  it('fails when an item is dropped from the middle', () => {
    const [a, , c, d] = stream() as [ChainedItem, ChainedItem, ChainedItem, ChainedItem];
    expect(verifyEvidenceChain([a, c, d])).toEqual({ ok: false, index: 1 });
  });

  it('fails when an item is re-pointed at other bytes', () => {
    const items = stream();
    expect(verifyEvidenceChain(patched(items, 0, { objectKey: 'tenant-a/run-1/999999' }))).toEqual({
      ok: false,
      index: 0,
    });
  });

  it('accepts a first item that links to an earlier stream, since its own link is still checked', () => {
    const items = stream();
    const tail = items.slice(1);
    expect(verifyEvidenceChain(tail)).toEqual({ ok: true, head: items[3]?.chain });
  });

  it('refuses a skipped item even when the first item of the binding is valid', () => {
    const items = stream();
    const gapped = [items[1], items[3]] as ChainedItem[];
    expect(verifyEvidenceChain(gapped)).toEqual({ ok: false, index: 1 });
  });
});
