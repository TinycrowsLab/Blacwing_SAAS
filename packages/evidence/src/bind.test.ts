import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { bindEvidence, type BindEvidenceDeps, type EvidenceRecord } from './bind.js';
import { EvidenceIntegrityError } from './errors.js';
import {
  bodiesOf,
  buildStream,
  fakeObjects,
  fakeStore,
  FINDING_ID,
  OCCURRENCE_ID,
  recorder,
  REPLAY_ITEMS,
  uuid,
} from './test-support.js';

import type { EvidenceMetrics } from './telemetry.js';

interface Harness {
  readonly deps: BindEvidenceDeps;
  readonly store: ReturnType<typeof fakeStore>;
  readonly audit: ReturnType<typeof recorder>;
  readonly metrics: { bound: number; integrityFailed: number };
  readonly records: EvidenceRecord[];
  readonly ids: string[];
}

/** A harness over one stream of the four replay items, with honest bytes and digests unless `tamper` says otherwise. */
function harness(
  options: {
    records?: EvidenceRecord[];
    bodies?: Map<string, string>;
    maxItemBytes?: number;
  } = {},
): Harness {
  const records = options.records ?? buildStream(REPLAY_ITEMS);
  const store = fakeStore(records);
  const audit = recorder();
  const metrics = { bound: 0, integrityFailed: 0 };
  const sink: EvidenceMetrics = {
    bound: () => void (metrics.bound += 1),
    integrityFailed: () => void (metrics.integrityFailed += 1),
  };
  const deps: BindEvidenceDeps = {
    store: store.store,
    objects: fakeObjects(options.bodies ?? bodiesOf(records, REPLAY_ITEMS)),
    audit: audit.audit,
    metrics: sink,
    ...(options.maxItemBytes === undefined ? {} : { maxItemBytes: options.maxItemBytes }),
  };
  return { deps, store, audit, metrics, records, ids: records.map((record) => record.id) };
}

function input(ids: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    findingId: FINDING_ID,
    occurrenceId: OCCURRENCE_ID,
    evidenceIds: [...ids],
    oracleType: 'error_signature',
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the binding to be refused');
}

describe('bindEvidence: the happy path', () => {
  it('records the ordered, hash-verified chain on the occurrence and confirms the finding', async () => {
    const h = harness();
    const result = await bindEvidence(h.deps, input(h.ids));

    expect(result.outcome).toBe('confirmed');
    expect(result.alreadyBound).toBe(false);
    expect(result.chain.map((ref) => ref.evidenceId)).toEqual(h.ids);
    expect(result.chain.at(-1)?.chain).toBe(h.records.at(-1)?.chain);
    expect(h.store.calls.bindChain).toHaveLength(1);
    expect(h.store.calls.bindChain[0]).toMatchObject({
      findingId: FINDING_ID,
      expectedStateVersion: 3,
    });
    expect(h.store.current().status).toBe('confirmed');
  });

  it('stores references only: object key, digest and link, never a body', async () => {
    const h = harness();
    const result = await bindEvidence(h.deps, input(h.ids));
    for (const ref of result.chain) {
      expect(Object.keys(ref).sort()).toEqual(['chain', 'evidenceId', 'objectKey', 'sha256']);
    }
  });

  it('audits evidence.bound with the count and counts it', async () => {
    const h = harness();
    await bindEvidence(h.deps, input(h.ids));
    expect(h.audit.events).toEqual([{ type: 'evidence.bound', findingId: FINDING_ID, count: 4 }]);
    expect(h.metrics).toEqual({ bound: 1, integrityFailed: 0 });
  });

  it('is idempotent: the same chain again is a no-op with no second write or audit', async () => {
    const h = harness();
    await bindEvidence(h.deps, input(h.ids));
    h.store.setBound(h.store.calls.bindChain[0]?.refs ?? []);
    const again = await bindEvidence(h.deps, input(h.ids));
    expect(again.alreadyBound).toBe(true);
    expect(h.store.calls.bindChain).toHaveLength(1);
    expect(h.audit.events).toHaveLength(1);
  });

  it('reports a race that bound the same chain first as already bound, without a second audit', async () => {
    const h = harness();
    const raced = { ...h.store.store, bindChain: () => Promise.resolve('already_bound' as const) };
    const result = await bindEvidence({ ...h.deps, store: raced }, input(h.ids));
    expect(result.alreadyBound).toBe(true);
    expect(h.audit.events).toEqual([]);
    expect(h.metrics.bound).toBe(0);
  });
});

describe('bindEvidence: the minimum evidence set', () => {
  it('refuses a binding that lacks the negative control, without suspecting the finding', async () => {
    const h = harness();
    const partial = h.ids.slice(0, 2);
    const error = await refusal(bindEvidence(h.deps, input(partial)));
    expect(error).toBeInstanceOf(ValidationError);
    expect(h.store.calls.bindChain).toEqual([]);
    expect(h.store.calls.markSuspected).toEqual([]);
    expect(h.store.current().status).toBe('validating');
  });

  it('refuses an OOB oracle with no stored interaction, and accepts it once one is bound', async () => {
    const oobItems = [
      ...REPLAY_ITEMS,
      { kind: 'oob_interaction' as const, role: 'oracle' as const, body: 'dns hit' },
    ];
    const records = buildStream(oobItems);
    const h = harness({ records, bodies: bodiesOf(records, oobItems) });
    const withoutInteraction = records.slice(0, 4).map((record) => record.id);
    expect(
      await refusal(bindEvidence(h.deps, input(withoutInteraction, { oracleType: 'oob' }))),
    ).toBeInstanceOf(ValidationError);
    const complete = await bindEvidence(
      h.deps,
      input(
        records.map((record) => record.id),
        { oracleType: 'oob' },
      ),
    );
    expect(complete.chain).toHaveLength(5);
  });
});

describe('bindEvidence: references and input', () => {
  it('refuses an id the tenant cannot see (missing or another tenant), with no write', async () => {
    const h = harness();
    const foreign = uuid(0x999);
    const error = await refusal(bindEvidence(h.deps, input([...h.ids, foreign])));
    expect(error).toBeInstanceOf(ValidationError);
    expect(h.store.calls.bindChain).toEqual([]);
    expect(h.store.calls.markSuspected).toEqual([]);
  });

  it('refuses the same item named twice', async () => {
    const h = harness();
    const first = h.ids[0] ?? '';
    await expect(bindEvidence(h.deps, input([first, first]))).rejects.toThrow(ValidationError);
  });

  it('refuses malformed input, an unknown oracle and an inline field', async () => {
    const h = harness();
    await expect(bindEvidence(h.deps, input([]))).rejects.toThrow(ValidationError);
    await expect(bindEvidence(h.deps, input(h.ids, { oracleType: 'vibes' }))).rejects.toThrow(
      ValidationError,
    );
    await expect(bindEvidence(h.deps, input(h.ids, { body: 'inline' }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses an unknown occurrence without reading any evidence', async () => {
    const h = harness();
    const error = await refusal(bindEvidence(h.deps, input(h.ids, { occurrenceId: uuid(0x777) })));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(h.store.calls.bindChain).toEqual([]);
  });

  it('refuses an item larger than the size limit, and does not suspect the finding', async () => {
    const h = harness({ maxItemBytes: 10 });
    const error = await refusal(bindEvidence(h.deps, input(h.ids)));
    expect(error).toBeInstanceOf(ValidationError);
    expect(h.store.calls.markSuspected).toEqual([]);
  });

  it('refuses a different chain on an occurrence that is already bound', async () => {
    const h = harness();
    // The occurrence is bound to a different set of items than the ones now offered.
    const other = [uuid(0x801), uuid(0x802), uuid(0x803), uuid(0x804)];
    h.store.setBound(
      other.map((id, index) => ({
        evidenceId: id,
        objectKey: `${id}/k`,
        sha256: 'a'.repeat(64),
        chain: String(index + 1).padStart(64, '0'),
      })),
    );
    expect(await refusal(bindEvidence(h.deps, input(h.ids)))).toBeInstanceOf(ConflictError);
    expect(h.store.calls.bindChain).toEqual([]);
  });
});

describe('bindEvidence: integrity failures fail closed to Suspected', () => {
  it('a digest that does not match its bytes suspects the finding and throws', async () => {
    const h = harness();
    const bodies = bodiesOf(h.records, REPLAY_ITEMS);
    bodies.set(h.records[1]?.objectKey ?? '', 'tampered body');
    const tampered = harness({ records: h.records, bodies });
    const error = await refusal(bindEvidence(tampered.deps, input(tampered.ids)));

    expect(error).toBeInstanceOf(EvidenceIntegrityError);
    expect((error as EvidenceIntegrityError).code).toBe('EVIDENCE_INTEGRITY_FAILED');
    expect((error as EvidenceIntegrityError).reason).toBe('sha256_mismatch');
    expect(tampered.store.calls.bindChain).toEqual([]);
    expect(tampered.store.calls.markSuspected).toEqual([
      { findingId: FINDING_ID, occurrenceId: OCCURRENCE_ID, expectedStateVersion: 3 },
    ]);
    expect(tampered.store.current().status).toBe('suspected');
    expect(tampered.audit.events).toEqual([
      { type: 'evidence.integrity_failed', findingId: FINDING_ID, reason: 'sha256_mismatch' },
    ]);
    expect(tampered.metrics).toEqual({ bound: 0, integrityFailed: 1 });
  });

  it('a broken chain link suspects the finding with chain_broken', async () => {
    const records = buildStream(REPLAY_ITEMS);
    const broken = records.map((record, index) =>
      index === 2 ? { ...record, chain: 'c'.repeat(64) } : record,
    );
    const h = harness({ records: broken });
    const error = await refusal(bindEvidence(h.deps, input(h.ids)));
    expect(error).toBeInstanceOf(EvidenceIntegrityError);
    expect((error as EvidenceIntegrityError).reason).toBe('chain_broken');
    expect(h.store.current().status).toBe('suspected');
  });

  it('an item out of order in the chain suspects the finding', async () => {
    const h = harness();
    const shuffled = [h.ids[1], h.ids[0], h.ids[2], h.ids[3]] as string[];
    const error = await refusal(bindEvidence(h.deps, input(shuffled)));
    expect((error as EvidenceIntegrityError).reason).toBe('chain_broken');
    expect(h.store.current().status).toBe('suspected');
  });

  it('unreadable bytes fail closed with object_unreadable and no storage detail in the message', async () => {
    const h = harness({ bodies: new Map() });
    const error = await refusal(bindEvidence(h.deps, input(h.ids)));
    expect(error).toBeInstanceOf(EvidenceIntegrityError);
    expect((error as EvidenceIntegrityError).reason).toBe('object_unreadable');
    expect((error as EvidenceIntegrityError).message).toBe('evidence integrity check failed');
    expect(h.store.current().status).toBe('suspected');
  });

  it('a finding that is no longer awaiting validation is refused by the store, not overwritten', async () => {
    const h = harness();
    const bodies = bodiesOf(h.records, REPLAY_ITEMS);
    bodies.set(h.records[0]?.objectKey ?? '', 'changed');
    const tampered = harness({ records: h.records, bodies });
    const store = {
      ...tampered.store.store,
      markSuspected: () => Promise.reject(new ConflictError('finding is not awaiting validation')),
    };
    expect(
      await refusal(bindEvidence({ ...tampered.deps, store }, input(tampered.ids))),
    ).toBeInstanceOf(ConflictError);
  });
});
