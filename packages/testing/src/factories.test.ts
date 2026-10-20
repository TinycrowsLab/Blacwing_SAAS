import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  assetSchema,
  findingSchema,
  runSchema,
  standingAuthorisationSchema,
  tenantSchema,
  testCaseSchema,
  userSchema,
} from '@blackwing/contracts';
import { isUuidV7, parseUuid, uuidTimestamp } from '@blackwing/ids';
import { nowIso } from '@blackwing/time';

import {
  assetArbitrary,
  findingArbitrary,
  runArbitrary,
  standingAuthorisationArbitrary,
  tenantArbitrary,
  tenantIdPairArbitrary,
  testCaseArbitrary,
  userArbitrary,
} from './arbitraries.js';
import { FixedClock } from './clock.js';
import {
  createFactories,
  DEFAULT_FACTORY_SEED,
  type Factories,
  makeAsset,
  makeFinding,
  makeRun,
  makeStandingAuthorisation,
  makeTenant,
  makeTestCase,
  makeUser,
  resetFactories,
} from './factories.js';
import { createSeededRandom } from './random.js';

const SCHEMAS = [
  ['makeTenant', tenantSchema],
  ['makeUser', userSchema],
  ['makeAsset', assetSchema],
  ['makeStandingAuthorisation', standingAuthorisationSchema],
  ['makeRun', runSchema],
  ['makeTestCase', testCaseSchema],
  ['makeFinding', findingSchema],
] as const;

function everyEntity(f: Factories): unknown[] {
  return [
    f.makeTenant(),
    f.makeUser(),
    f.makeAsset(),
    f.makeStandingAuthorisation(),
    f.makeRun(),
    f.makeTestCase(),
    f.makeFinding(),
  ];
}

describe('factories produce entities that pass their Zod contracts', () => {
  const f = createFactories();

  it.each(SCHEMAS)('%s', (factory, schema) => {
    const entity = f[factory]();
    expect(schema.safeParse(entity).error?.issues ?? []).toEqual([]);
  });

  it.each(SCHEMAS)('module-level %s', (factory, schema) => {
    const helpers = {
      makeTenant,
      makeUser,
      makeAsset,
      makeStandingAuthorisation,
      makeRun,
      makeTestCase,
      makeFinding,
    };
    expect(schema.safeParse(helpers[factory]()).success).toBe(true);
  });

  it('uses UUIDv7 ids from @blackwing/ids, timestamped by the clock', () => {
    const clock = new FixedClock('2026-05-05T05:05:05.005Z');
    const tenant = createFactories({ clock }).makeTenant();
    expect(isUuidV7(tenant.id)).toBe(true);
    expect(uuidTimestamp(parseUuid(tenant.id))).toBe(clock.nowMs());
    expect(tenant.createdAt).toBe('2026-05-05T05:05:05.005Z');
    expect(tenant.updatedAt).toBe(tenant.createdAt);
  });

  it('issues distinct, increasing ids even within one clock millisecond', () => {
    const g = createFactories();
    const ids = Array.from({ length: 50 }, () => g.newId());
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
  });

  it('defaults are valid against the §8 rules (SoD, never destructive, signed active SA)', () => {
    const sa = createFactories().makeStandingAuthorisation();
    expect(sa.approverId).not.toBe(sa.requesterId);
    expect(sa.maxIntrusiveness).not.toBe('destructive');
    expect(sa.status).toBe('active');
    expect(sa.signature).not.toBeNull();
    expect(Date.parse(sa.expiresAt)).toBeGreaterThan(Date.parse(sa.validFrom));
  });

  it('uses reserved example domains only', () => {
    const g = createFactories();
    expect(g.makeUser().email).toMatch(/@example\.test$/);
    expect(g.makeAsset().identifiers.every((id) => id.includes('.example.test'))).toBe(true);
  });
});

describe('determinism', () => {
  it('equal seeds give equal entity sequences', () => {
    expect(everyEntity(createFactories({ seed: 99 }))).toEqual(
      everyEntity(createFactories({ seed: 99 })),
    );
  });

  it('different seeds give different ids', () => {
    expect(createFactories({ seed: 1 }).makeTenant().id).not.toBe(
      createFactories({ seed: 2 }).makeTenant().id,
    );
  });

  it('is deterministic for any seed (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        expect(createFactories({ seed }).makeRun()).toEqual(createFactories({ seed }).makeRun());
      }),
      { numRuns: 50 },
    );
  });

  it('resetFactories restarts the module-level sequence', () => {
    resetFactories();
    const first = makeTenant();
    resetFactories();
    expect(makeTenant()).toEqual(first);
    expect(resetFactories().seed).toBe(DEFAULT_FACTORY_SEED);
    resetFactories({ seed: 5 });
    expect(makeTenant()).toEqual(createFactories({ seed: 5 }).makeTenant());
  });

  it('the seeded generator is reproducible and spans its range', () => {
    const a = createSeededRandom(3);
    const b = createSeededRandom(3);
    const xs = Array.from({ length: 20 }, () => a.uint32());
    expect(Array.from({ length: 20 }, () => b.uint32())).toEqual(xs);
    expect(new Set(xs).size).toBe(20);
    const r = createSeededRandom(4);
    const ints = Array.from({ length: 500 }, () => r.int(1, 6));
    expect(Math.min(...ints)).toBe(1);
    expect(Math.max(...ints)).toBe(6);
    expect(r.hex(13)).toMatch(/^[0-9a-f]{13}$/);
    expect(r.pick(['only'])).toBe('only');
    expect(() => createSeededRandom(1.5)).toThrow(RangeError);
    expect(() => r.int(5, 1)).toThrow(RangeError);
  });
});

describe('overrides', () => {
  it('override only what the test asserts; the rest stays valid', () => {
    const g = createFactories();
    const tenant = g.makeTenant();
    const asset = g.makeAsset({ tenantId: tenant.id, environment: 'prod' });
    expect(asset.tenantId).toBe(tenant.id);
    expect(asset.environment).toBe('prod');
    expect(assetSchema.parse(asset)).toEqual(asset);
  });

  it('overrides that break a contract rule throw instead of producing an invalid fixture', () => {
    const g = createFactories();
    const user = g.makeUser();
    expect(() =>
      g.makeStandingAuthorisation({ requesterId: user.id, approverId: user.id }),
    ).toThrow(ZodError);
    expect(() => g.makeRun({ state: 'paused' })).toThrow(ZodError);
    expect(() => g.makeTestCase({ class: 'destructive', status: 'approved' })).toThrow(ZodError);
    expect(() => g.makeTenant({ slug: 'Not Valid' })).toThrow(ZodError);
  });

  it('a paused run with a reason, or a released finding with its release, is valid', () => {
    const g = createFactories();
    expect(g.makeRun({ state: 'paused', pauseReason: 'gate2_pending' }).state).toBe('paused');
    const approver = g.makeUser();
    const finding = g.makeFinding({
      status: 'released',
      releasedBy: approver.id,
      releasedAt: nowIso(g.clock),
    });
    expect(finding.releasedBy).toBe(approver.id);
  });
});

describe('fast-check arbitraries produce valid entities', () => {
  const cases = [
    ['tenantArbitrary', tenantArbitrary, tenantSchema],
    ['userArbitrary', userArbitrary, userSchema],
    ['assetArbitrary', assetArbitrary, assetSchema],
    ['standingAuthorisationArbitrary', standingAuthorisationArbitrary, standingAuthorisationSchema],
    ['runArbitrary', runArbitrary, runSchema],
    ['testCaseArbitrary', testCaseArbitrary, testCaseSchema],
    ['findingArbitrary', findingArbitrary, findingSchema],
  ] as const;

  it.each(cases)('%s', (_name, arbitrary, schema) => {
    fc.assert(
      fc.property(arbitrary() as fc.Arbitrary<unknown>, (entity) => {
        expect(schema.safeParse(entity).error?.issues ?? []).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('tenantIdPairArbitrary always yields two distinct UUIDv7s', () => {
    fc.assert(
      fc.property(tenantIdPairArbitrary(), ([a, b]) => {
        expect(a).not.toBe(b);
        expect(isUuidV7(a) && isUuidV7(b)).toBe(true);
      }),
    );
  });
});
