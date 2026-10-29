import fc from 'fast-check';

import {
  type Asset,
  assetEnvironmentSchema,
  assetTypeSchema,
  authorisableIntrusivenessSchema,
  type Finding,
  intrusivenessSchema,
  LIMITS,
  type Run,
  runModeSchema,
  type Severity,
  runTriggerSchema,
  type StandingAuthorisation,
  type Tenant,
  tenantStatusSchema,
  type TestCase,
  type User,
  userStatusSchema,
} from '@blackwing/contracts';

import { FixedClock } from './clock.js';
import { createFactories, type Factories } from './factories.js';

/** Largest generated seed (any 31-bit value). */
const MAX_SEED = 2_147_483_647;
const DAY_MS = 86_400_000;

/** Lowest and highest instants generated (keeps UUIDv7 timestamps and ISO strings in a sane range). */
const MIN_INSTANT = Date.parse('2000-01-01T00:00:00.000Z');
const MAX_INSTANT = Date.parse('2099-12-31T23:59:59.999Z');

/** Canonical lowercase UUIDv7 strings. */
export const uuidV7Arbitrary = (): fc.Arbitrary<string> => fc.uuid({ version: 7 });

/** Two distinct tenant ids: the input of every cross-tenant property (§8.6). */
export const tenantIdPairArbitrary = (): fc.Arbitrary<readonly [string, string]> =>
  fc.tuple(uuidV7Arbitrary(), uuidV7Arbitrary()).filter(([a, b]) => a !== b);

/** Epoch milliseconds between 2000 and 2099. */
export const instantArbitrary = (): fc.Arbitrary<number> =>
  fc.integer({ min: MIN_INSTANT, max: MAX_INSTANT });

/** `Z`-suffixed millisecond ISO-8601 instants. */
export const isoDateTimeArbitrary = (): fc.Arbitrary<string> =>
  instantArbitrary().map((ms) => new Date(ms).toISOString());

/** Valid tenant slugs (lowercase words joined by single hyphens, 3-63 characters). */
export const tenantSlugArbitrary = (): fc.Arbitrary<string> =>
  fc
    .array(fc.stringMatching(/^[a-z0-9]{1,10}$/), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join('-'))
    .filter((slug) => slug.length >= LIMITS.slugMin && slug.length <= LIMITS.slugMax);

/** A factory set with a random seed and start instant: the source of every entity arbitrary. */
export const factoriesArbitrary = (): fc.Arbitrary<Factories> =>
  fc
    .record({ seed: fc.integer({ min: 0, max: MAX_SEED }), start: instantArbitrary() })
    .map(({ seed, start }) => createFactories({ seed, clock: new FixedClock(start) }));

/** Valid tenants with varied slugs, statuses and regions. */
export const tenantArbitrary = (): fc.Arbitrary<Tenant> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      slug: tenantSlugArbitrary(),
      status: fc.constantFrom(...tenantStatusSchema.options),
      region: fc.constantFrom('eu-west-1', 'eu-central-1', 'us-east-1', 'ap-southeast-2'),
    })
    .map(({ factories, ...overrides }) => factories.makeTenant(overrides));

/** Valid users. */
export const userArbitrary = (): fc.Arbitrary<User> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      status: fc.constantFrom(...userStatusSchema.options),
    })
    .map(({ factories, ...overrides }) => factories.makeUser(overrides));

/** Valid assets of every type and environment. */
export const assetArbitrary = (): fc.Arbitrary<Asset> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      tenantId: uuidV7Arbitrary(),
      type: fc.constantFrom(...assetTypeSchema.options),
      environment: fc.constantFrom(...assetEnvironmentSchema.options),
    })
    .map(({ factories, ...overrides }) => factories.makeAsset(overrides));

/** Valid standing authorisations; never destructive (§8.3), requester always differs from approver (§8.4). */
export const standingAuthorisationArbitrary = (): fc.Arbitrary<StandingAuthorisation> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      tenantId: uuidV7Arbitrary(),
      maxIntrusiveness: fc.constantFrom(...authorisableIntrusivenessSchema.options),
      validityDays: fc.integer({ min: 1, max: 365 }),
    })
    .map(({ factories, validityDays, ...overrides }) =>
      factories.makeStandingAuthorisation({
        ...overrides,
        expiresAt: new Date(factories.clock.nowMs() + validityDays * DAY_MS).toISOString(),
      }),
    );

/** Valid runs in non-paused, non-terminal states. */
export const runArbitrary = (): fc.Arbitrary<Run> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      tenantId: uuidV7Arbitrary(),
      mode: fc.constantFrom(...runModeSchema.options),
      trigger: fc.constantFrom(...runTriggerSchema.options),
      state: fc.constantFrom(
        'draft',
        'preflight',
        'recon',
        'planning',
        'awaiting_gate1',
        'approved',
        'executing',
      ),
      stateVersion: fc.nat({ max: 1000 }),
    } as const)
    .map(({ factories, ...overrides }) => factories.makeRun(overrides));

/** Valid proposed test cases of every non-destructive class. */
export const testCaseArbitrary = (): fc.Arbitrary<TestCase> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      tenantId: uuidV7Arbitrary(),
      class: fc.constantFrom(...intrusivenessSchema.exclude(['destructive']).options),
    })
    .map(({ factories, ...overrides }) => factories.makeTestCase(overrides));

/**
 * CVSS v4.0 severities whose score, band and nomenclature follow from their vectors (the FIRST reference values).
 * A random score would not follow from its vector, which the finding write refuses (CVSS_VECTOR_SCORE_MISMATCH).
 */
const SCORED_SEVERITIES: readonly Severity[] = [
  {
    cvss4: {
      vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
      score: 9.3,
      severity: 'critical',
      nomenclature: 'CVSS-B',
    },
  },
  {
    cvss4: {
      vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
      score: 8.7,
      severity: 'high',
      nomenclature: 'CVSS-B',
    },
  },
  {
    cvss4: {
      vector: 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L',
      score: 5.2,
      severity: 'medium',
      nomenclature: 'CVSS-B',
    },
  },
  {
    cvss4: {
      vector: 'CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N',
      score: 1.0,
      severity: 'low',
      nomenclature: 'CVSS-B',
    },
  },
  {
    cvss4: {
      vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N',
      score: 0,
      severity: 'none',
      nomenclature: 'CVSS-B',
    },
  },
];

/** Valid candidate findings with varied severity and confidence. */
export const findingArbitrary = (): fc.Arbitrary<Finding> =>
  fc
    .record({
      factories: factoriesArbitrary(),
      tenantId: uuidV7Arbitrary(),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      severity: fc.constantFrom(...SCORED_SEVERITIES),
    })
    .map(({ factories, ...overrides }) => factories.makeFinding(overrides));
