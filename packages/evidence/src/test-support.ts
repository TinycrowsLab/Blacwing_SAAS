import { EVIDENCE_GENESIS_CHAIN, evidenceChainLink, sha256Hex } from '@blackwing/crypto';

import type { EvidenceRecord, EvidenceBindingStore, EvidenceAuditEvent } from './bind.js';
import type { EvidenceObjectReader } from './objects.js';
import type { EvidenceChainRef } from '@blackwing/contracts';

const HEX_RADIX = 16;
const UUID_TAIL_WIDTH = 12;
const SEQUENCE_WIDTH = 6;
const FINDING_LABEL = 0x100;
const OCCURRENCE_LABEL = 0x200;
const ITEM_LABEL_BASE = 0x300;

/** A UUIDv7 with a readable tail, so a test can tell ids apart in a failure message. */
export function uuid(label: number): string {
  return `018f0000-0000-7000-8000-${label.toString(HEX_RADIX).padStart(UUID_TAIL_WIDTH, '0')}`;
}

export const FINDING_ID = uuid(FINDING_LABEL);
export const OCCURRENCE_ID = uuid(OCCURRENCE_LABEL);

export interface SeedItem {
  readonly kind: EvidenceRecord['kind'];
  readonly role: EvidenceRecord['role'];
  readonly body: string;
}

/**
 * Builds the stored records of one run's stream: each item's digest is the hash of its body, and each link covers
 * the previous link, exactly as the repository appends them.
 */
export function buildStream(items: readonly SeedItem[], tenantId = 'tenant-a'): EvidenceRecord[] {
  let prevChain: string | null = null;
  return items.map((item, index) => {
    const id = uuid(ITEM_LABEL_BASE + index);
    const sha256 = sha256Hex(item.body);
    const size = Buffer.byteLength(item.body, 'utf8');
    const objectKey = `${tenantId}/run-1/${String(index + 1).padStart(SEQUENCE_WIDTH, '0')}`;
    const chain = evidenceChainLink({
      prevChain,
      sha256,
      kind: item.kind,
      role: item.role,
      size,
      objectKey,
    });
    const record: EvidenceRecord = {
      id,
      kind: item.kind,
      role: item.role,
      objectKey,
      sha256,
      size,
      prevChain,
      chain,
    };
    prevChain = chain;
    return record;
  });
}

/** The replay pair for the positive and the negative control. */
export const REPLAY_ITEMS: readonly SeedItem[] = [
  { kind: 'request', role: 'positive', body: 'GET /search?q=a%27' },
  { kind: 'response', role: 'positive', body: 'HTTP 500 SQLITE_ERROR' },
  { kind: 'request', role: 'negative_control', body: 'GET /search?q=apple' },
  { kind: 'response', role: 'negative_control', body: 'HTTP 200 products' },
];

/** A fake of the store port that keeps the records it is given and records every write. */
export function fakeStore(records: readonly EvidenceRecord[]) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const calls = {
    bindChain: [] as Parameters<EvidenceBindingStore['bindChain']>[0][],
    markSuspected: [] as Parameters<EvidenceBindingStore['markSuspected']>[0][],
  };
  let finding = { id: FINDING_ID, status: 'validating', stateVersion: 3 };
  let occurrenceRefs: readonly EvidenceChainRef[] = [];
  const store: EvidenceBindingStore = {
    getFindingForBinding: (findingId, occurrenceId) =>
      Promise.resolve(
        findingId === FINDING_ID && occurrenceId === OCCURRENCE_ID
          ? {
              finding: { ...finding },
              occurrence: { id: OCCURRENCE_ID, findingId, evidenceRefs: occurrenceRefs },
            }
          : undefined,
      ),
    getMany: (ids) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const record = byId.get(id);
          return record === undefined ? [] : [record];
        }),
      ),
    bindChain: (input) => {
      calls.bindChain.push(input);
      occurrenceRefs = input.refs.map((ref) => ({ ...ref }));
      finding = { ...finding, status: 'confirmed', stateVersion: finding.stateVersion + 1 };
      return Promise.resolve('bound');
    },
    markSuspected: (input) => {
      calls.markSuspected.push(input);
      finding = { ...finding, status: 'suspected', stateVersion: finding.stateVersion + 1 };
      return Promise.resolve();
    },
  };
  return {
    store,
    calls,
    setBound(refs: readonly EvidenceChainRef[]) {
      occurrenceRefs = refs;
    },
    current: () => ({ ...finding }),
  };
}

/** Object reader over a map of key to body. Missing keys throw, as a storage read would. */
export function fakeObjects(bodies: ReadonlyMap<string, string>): EvidenceObjectReader {
  return {
    sha256Of: (objectKey) => {
      const body = bodies.get(objectKey);
      if (body === undefined) {
        return Promise.reject(new Error(`no such object: ${objectKey}`));
      }
      return Promise.resolve(sha256Hex(body));
    },
  };
}

export function bodiesOf(
  records: readonly EvidenceRecord[],
  items: readonly SeedItem[],
): Map<string, string> {
  return new Map(records.map((record, index) => [record.objectKey, items[index]?.body ?? '']));
}

export const GENESIS = EVIDENCE_GENESIS_CHAIN;

/** Collects audit events in order. */
export function recorder() {
  const events: EvidenceAuditEvent[] = [];
  return {
    events,
    audit: {
      record: (event: EvidenceAuditEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    },
  };
}
