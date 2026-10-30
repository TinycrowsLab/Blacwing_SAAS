import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ApiTokenId,
  AssessmentRequestId,
  ScheduleId,
  AssetId,
  EvidenceId,
  FindingId,
  ID_TYPES,
  type IdType,
  KillEventId,
  OobId,
  ReproArtifactId,
  RunId,
  SessionId,
  StandingAuthorisationId,
  SubtaskId,
  TenantId,
  TestCaseId,
  TestPlanId,
  UserId,
} from './entities.js';
import { IdValidationError, isIdValidationError } from './errors.js';
import { ID_PREFIX_LIST, ID_PREFIXES, type IdPrefix } from './prefixes.js';
import { newPublicId, parsePublicId, type PublicId, toPublicId } from './public-id.js';
import { newId, type Uuid } from './uuid.js';

/** The value `fn` throws; fails the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

// Compile-time checks. `tsc -b` builds this file, so each `@ts-expect-error` must stay an error:
// if branding ever weakens, the directive becomes unused (TS2578) and the typecheck fails.
function takesRunId(id: RunId): RunId {
  return id;
}
function takesFindingId(id: FindingId): FindingId {
  return id;
}

describe('branded entity types (compile time)', () => {
  it('prevents passing a FindingId where a RunId is expected', () => {
    const finding = FindingId.generate();
    const run = RunId.generate();
    // @ts-expect-error TS2345 cross-entity confusion: a FindingId is not a RunId
    takesRunId(finding);
    // @ts-expect-error TS2345 cross-entity confusion: a RunId is not a FindingId
    takesFindingId(run);
    expect(takesRunId(run)).toBe(run);
  });

  it('prevents passing an unvalidated plain string or a raw UUID as an entity id', () => {
    const plain = 'run_01fwhe4ydgfk1shh6w1g60eecf';
    // @ts-expect-error TS2345 a plain string must go through RunId.parse first
    takesRunId(plain);
    const uuid: Uuid = newId();
    // @ts-expect-error TS2345 a bare UUID is not a public id
    takesRunId(uuid);
    expect(takesRunId(RunId.parse(plain))).toBe(plain);
  });

  it('keeps branded ids usable as strings', () => {
    const run: string = RunId.generate();
    expect(typeof run).toBe('string');
    expectTypeOf<RunId>().toExtend<string>();
    expectTypeOf<Uuid>().toExtend<string>();
  });

  it("matches the issue's brand shape exactly", () => {
    expectTypeOf<RunId>().toEqualTypeOf<string & { readonly __brand: 'RunId' }>();
    expectTypeOf<FindingId>().toEqualTypeOf<string & { readonly __brand: 'FindingId' }>();
    expectTypeOf<PublicId<'run'>>().toEqualTypeOf<RunId>();
    expectTypeOf<FindingId>().not.toExtend<RunId>();
  });

  it('types the generic helpers per prefix', () => {
    expectTypeOf(newPublicId('run')).toEqualTypeOf<RunId>();
    expectTypeOf(toPublicId(newId(), 'fnd')).toEqualTypeOf<FindingId>();
    expectTypeOf<ReturnType<typeof RunId.parse>>().toEqualTypeOf<RunId>();
    expectTypeOf<ReturnType<typeof RunId.toUuid>>().toEqualTypeOf<Uuid>();
  });

  it('narrows parsePublicId results by prefix', () => {
    const parsed = parsePublicId(RunId.generate());
    if (parsed.prefix !== 'run') throw new Error('expected a run id');
    expectTypeOf(parsed.id).toEqualTypeOf<RunId>();
    expect(takesRunId(parsed.id)).toBe(parsed.id);
  });
});

describe('entity constructors (runtime)', () => {
  const all: readonly [IdType<IdPrefix>, string][] = [
    [RunId, 'run'],
    [FindingId, 'fnd'],
    [AssetId, 'asset'],
    [StandingAuthorisationId, 'sa'],
    [TestPlanId, 'tp'],
    [TestCaseId, 'tc'],
    [SubtaskId, 'sub'],
    [SessionId, 'sess'],
    [EvidenceId, 'evd'],
    [ReproArtifactId, 'rpa'],
    [ApiTokenId, 'tok'],
    [TenantId, 'ten'],
    [UserId, 'usr'],
    [OobId, 'oob'],
    [KillEventId, 'kill'],
    [AssessmentRequestId, 'areq'],
    [ScheduleId, 'sched'],
  ];

  it('covers every registered prefix exactly once', () => {
    expect(all.map(([type]) => type.prefix).sort()).toEqual([...ID_PREFIX_LIST].sort());
    expect(Object.keys(ID_TYPES).sort()).toEqual([...ID_PREFIX_LIST].sort());
    for (const p of ID_PREFIX_LIST) {
      expect(ID_TYPES[p].prefix).toBe(p);
      expect(ID_TYPES[p].brand).toBe(ID_PREFIXES[p]);
    }
  });

  it.each(all)('%o generates, parses and converts its own ids', (type, expectedPrefix) => {
    expect(type.prefix).toBe(expectedPrefix);
    const id = type.generate();
    expect(id.startsWith(`${expectedPrefix}_`)).toBe(true);
    expect(type.is(id)).toBe(true);
    expect(type.parse(id)).toBe(id);
    const uuid = type.toUuid(id);
    expect(type.fromUuid(uuid)).toBe(id);
    expect(type.fromUuid(uuid.toUpperCase())).toBe(id);
  });

  it.each(all)("%o rejects every other entity's ids", (type) => {
    for (const other of all.map(([t]) => t).filter((t) => t.prefix !== type.prefix)) {
      const foreign = other.generate();
      expect(type.is(foreign)).toBe(false);
      expect(() => type.parse(foreign)).toThrow(IdValidationError);
      expect(() => type.toUuid(foreign)).toThrow(IdValidationError);
    }
  });

  it('FindingId.parse throws prefix_mismatch for a run id', () => {
    const error = thrownBy(() => FindingId.parse(RunId.generate()));
    expect(isIdValidationError(error) && error.reason).toBe('prefix_mismatch');
  });

  it('constructors are frozen', () => {
    expect(Object.isFrozen(RunId)).toBe(true);
    expect(Object.isFrozen(ID_TYPES)).toBe(true);
  });
});
