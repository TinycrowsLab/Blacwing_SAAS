import { createHash } from 'node:crypto';

import {
  type Asset,
  assetSchema,
  type Finding,
  findingSchema,
  type Run,
  runSchema,
  type StandingAuthorisation,
  standingAuthorisationSchema,
  type Tenant,
  tenantSchema,
  type TestCase,
  testCaseSchema,
  type User,
  userSchema,
} from '@blackwing/contracts';
import { createUuidV7Generator, type Uuid } from '@blackwing/ids';
import { type Clock, FixedClock, toIso } from '@blackwing/time';

import { DEFAULT_TEST_EPOCH } from './clock.js';
import { createSeededRandom, type SeededRandom } from './random.js';

import type { z } from 'zod';

/** Default seed used by the module-level `make*` helpers. */
export const DEFAULT_FACTORY_SEED = 0x0b1ac;

/** Default SA validity and budgets, and run budgets: generous enough that tests never hit them by accident. */
const SA_VALIDITY_MS = 2_592_000_000; // 30 days
const SA_MAX_DURATION_MS = 14_400_000; // 4 h
const RUN_MAX_DURATION_MS = 7_200_000; // 2 h
/** Hex lengths of the random parts of generated values. */
const SLUG_SUFFIX_HEX = 6;
const SUBJECT_HEX = 16;
const SIGNATURE_HEX = 32;

/** Options for {@link createFactories}. */
export interface FactoryOptions {
  /** Seed for every generated value. Equal seeds (and equal call order) give equal entities. */
  readonly seed?: number;
  /** Clock for timestamps and UUIDv7 time bits. Defaults to a `FixedClock` at `DEFAULT_TEST_EPOCH`. */
  readonly clock?: Clock;
}

/** A factory: valid-by-default entity, any field overridable; the result is parsed by its Zod contract. */
export type Factory<T> = (overrides?: Partial<T>) => T;

/** The factory set returned by {@link createFactories}. */
export interface Factories {
  readonly seed: number;
  readonly clock: Clock;
  readonly random: SeededRandom;
  /** A deterministic UUIDv7 from this factory set's generator (the value of a DB `uuid` column). */
  newId(): Uuid;
  readonly makeTenant: Factory<Tenant>;
  readonly makeUser: Factory<User>;
  readonly makeAsset: Factory<Asset>;
  readonly makeStandingAuthorisation: Factory<StandingAuthorisation>;
  readonly makeRun: Factory<Run>;
  readonly makeTestCase: Factory<TestCase>;
  readonly makeFinding: Factory<Finding>;
}

/**
 * Builds a deterministic factory set.
 *
 * Entities are pure functions of `(seed, clock, call order, overrides)`: ids come from
 * `@blackwing/ids` `createUuidV7Generator` fed by the seeded generator and the clock, and timestamps
 * come from the clock. Every result is parsed with its `@blackwing/contracts` schema, so an override
 * that breaks a contract rule (requester = approver, a destructive SA, ...) throws a `ZodError`
 * instead of silently producing an invalid fixture. Build deliberately invalid input by spreading a
 * valid entity into a plain object.
 */
export function createFactories(options: FactoryOptions = {}): Factories {
  const seed = options.seed ?? DEFAULT_FACTORY_SEED;
  const clock = options.clock ?? new FixedClock(DEFAULT_TEST_EPOCH);
  const random = createSeededRandom(seed);
  const generator = createUuidV7Generator({
    now: () => clock.nowMs(),
    randomFill: (buffer) => {
      random.fill(buffer);
    },
    poolSize: 64,
  });
  let sequence = 0;
  const next = (): number => (sequence += 1);
  const newId = (): Uuid => generator();
  const iso = (offsetMs = 0): string => toIso(clock.nowMs() + offsetMs);

  function build<T>(schema: z.ZodType<T>, defaults: T, overrides: Partial<T> | undefined): T {
    return schema.parse({ ...defaults, ...overrides });
  }

  const makeTenant: Factory<Tenant> = (overrides) => {
    const n = next();
    return build(
      tenantSchema,
      {
        id: newId(),
        slug: `tenant-${n}-${random.hex(SLUG_SUFFIX_HEX)}`,
        name: `Tenant ${n}`,
        status: 'active',
        region: 'eu-west-1',
        plan: 'team',
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeUser: Factory<User> = (overrides) => {
    const n = next();
    return build(
      userSchema,
      {
        id: newId(),
        keycloakSub: `kc-${random.hex(SUBJECT_HEX)}`,
        // `.test` is reserved (RFC 2606): fixtures can never address a real mailbox.
        email: `user-${n}@example.test`,
        name: `User ${n}`,
        status: 'active',
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeAsset: Factory<Asset> = (overrides) => {
    const n = next();
    return build(
      assetSchema,
      {
        id: newId(),
        tenantId: newId(),
        type: 'web_app',
        identifiers: [{ kind: 'url', value: `https://asset-${n}.example.test` }],
        environment: 'staging',
        ownerUserId: newId(),
        verificationStatus: 'verified',
        verificationMethod: 'dns_txt',
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeStandingAuthorisation: Factory<StandingAuthorisation> = (overrides) => {
    const n = next();
    return build(
      standingAuthorisationSchema,
      {
        id: newId(),
        tenantId: newId(),
        assetIds: [newId()],
        scopeRules: { rules: [{ effect: 'include', host: `asset-${n}.example.test` }] },
        maxIntrusiveness: 'active_safe',
        preApprovedTestClasses: [],
        defaultBudgets: { costCapUsd: 50, maxRequests: 10_000, maxDurationMs: SA_MAX_DURATION_MS },
        testWindows: [],
        validFrom: iso(),
        expiresAt: iso(SA_VALIDITY_MS),
        requesterId: newId(),
        approverId: newId(),
        // Opaque placeholders: fixtures never carry real signatures or key material.
        signature: `test-signature.${random.hex(SIGNATURE_HEX)}`,
        signingKeyId: 'test-signing-key',
        status: 'active',
        revocationReason: null,
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeRun: Factory<Run> = (overrides) => {
    const n = next();
    return build(
      runSchema,
      {
        id: newId(),
        tenantId: newId(),
        mode: 'black',
        objective: `Assessment run ${n}`,
        assetIds: [newId()],
        saId: newId(),
        inputManifestId: null,
        state: 'draft',
        pauseReason: null,
        stateVersion: 0,
        runManifest: null,
        budgets: { costCapUsd: 25, maxRequests: 5_000, maxDurationMs: RUN_MAX_DURATION_MS },
        requestedBy: newId(),
        trigger: 'console',
        startedAt: null,
        endedAt: null,
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeTestCase: Factory<TestCase> = (overrides) => {
    const n = next();
    return build(
      testCaseSchema,
      {
        id: newId(),
        tenantId: newId(),
        testPlanId: newId(),
        class: 'active_safe',
        title: `Test case ${n}`,
        refs: { owasp: ['A01:2021'], wstg: ['WSTG-ATHZ-02'], asvs: ['V4.1.1'] },
        cweCandidates: ['CWE-284'],
        targets: [`https://asset-${n}.example.test/`],
        roles: ['anonymous'],
        budget: { maxRequests: 100, maxRps: 2, maxConcurrency: 1, maxBytes: 5_000_000 },
        oracle: { type: 'response.status', params: { expected: 403 } },
        negativeControl: null,
        status: 'proposed',
        statusReason: null,
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  const makeFinding: Factory<Finding> = (overrides) => {
    const n = next();
    const runId = newId();
    return build(
      findingSchema,
      {
        id: newId(),
        tenantId: newId(),
        runId,
        assetId: newId(),
        fingerprint: createHash('sha256').update(`finding:${seed}:${n}`).digest('hex'),
        title: `Finding ${n}`,
        class: 'broken_access_control',
        cweId: 'CWE-22',
        owaspCategory: 'A01',
        mappingVersion: '1.0.0',
        unmapped: false,
        classification: { cweCandidates: ['CWE-22'], apiTop10: null, wstg: ['WSTG-ATHZ-01'] },
        severity: {
          cvssV4Vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N',
          cvssV4Score: 6.9,
          cvssV31Vector: null,
        },
        location: {
          method: 'GET',
          urlTemplate: `/resource/${n}`,
          parameter: null,
          file: null,
          line: null,
        },
        status: 'candidate',
        baselineStatus: null,
        firstSeenRunId: runId,
        lastSeenRunId: runId,
        confidence: 0.5,
        acceptedRisk: null,
        releasedBy: null,
        releasedAt: null,
        createdAt: iso(),
        updatedAt: iso(),
      },
      overrides,
    );
  };

  return {
    seed,
    clock,
    random,
    newId,
    makeTenant,
    makeUser,
    makeAsset,
    makeStandingAuthorisation,
    makeRun,
    makeTestCase,
    makeFinding,
  };
}

let shared = createFactories();

/**
 * Restarts the module-level factories (`makeTenant`, ...). Vitest isolates modules per test file, so
 * each file starts from the default seed; call this in `beforeEach` when a test needs the exact same
 * entities regardless of what ran before it.
 */
export function resetFactories(options: FactoryOptions = {}): Factories {
  shared = createFactories(options);
  return shared;
}

export const makeTenant: Factory<Tenant> = (overrides) => shared.makeTenant(overrides);
export const makeUser: Factory<User> = (overrides) => shared.makeUser(overrides);
export const makeAsset: Factory<Asset> = (overrides) => shared.makeAsset(overrides);
export const makeStandingAuthorisation: Factory<StandingAuthorisation> = (overrides) =>
  shared.makeStandingAuthorisation(overrides);
export const makeRun: Factory<Run> = (overrides) => shared.makeRun(overrides);
export const makeTestCase: Factory<TestCase> = (overrides) => shared.makeTestCase(overrides);
export const makeFinding: Factory<Finding> = (overrides) => shared.makeFinding(overrides);
