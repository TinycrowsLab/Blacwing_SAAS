/** Workspace package name of this package. */
export const name = '@blackwing/testing';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// Pure helpers only: importing this entry never touches Docker, the network or Vitest internals.
// Testcontainers helpers live in "@blackwing/testing/containers", Vitest wiring in
// "@blackwing/testing/vitest" and the config presets in "@blackwing/testing/vitest-config".

export {
  assetArbitrary,
  factoriesArbitrary,
  findingArbitrary,
  instantArbitrary,
  isoDateTimeArbitrary,
  runArbitrary,
  standingAuthorisationArbitrary,
  tenantArbitrary,
  tenantIdPairArbitrary,
  tenantSlugArbitrary,
  testCaseArbitrary,
  userArbitrary,
  uuidV7Arbitrary,
} from './arbitraries.js';
export { type Clock, DEFAULT_TEST_EPOCH, FixedClock, type InstantInput } from './clock.js';
export {
  crossTenantDenied,
  CrossTenantAssertionError,
  type CrossTenantDeniedOptions,
  type CrossTenantDeniedResult,
  isDenialError,
  isEmptyResult,
} from './cross-tenant.js';
export {
  createFactories,
  DEFAULT_FACTORY_SEED,
  type Factories,
  type Factory,
  type FactoryOptions,
  makeAsset,
  makeFinding,
  makeRun,
  makeStandingAuthorisation,
  makeTenant,
  makeTestCase,
  makeUser,
  resetFactories,
} from './factories.js';
export { createSeededRandom, type SeededRandom } from './random.js';
