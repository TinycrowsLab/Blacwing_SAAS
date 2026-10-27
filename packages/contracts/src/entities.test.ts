// Entity contract rules (CONTEXT_PACK §3.3-§3.5, §7, §8). Fixtures are written by hand here:
// @blackwing/testing depends on this package, so its factories cannot be used without a cycle.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assetSchema,
  findingSchema,
  isoDateTimeSchema,
  MAX_PLAN_TEST_CASES,
  runSchema,
  standingAuthorisationSchema,
  tenantSchema,
  testCaseSchema,
  testPlanJsonSchema,
  testPlanSchema,
  userSchema,
  uuidV7Schema,
} from './index.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const stamps = { createdAt: T0, updatedAt: T0 };

const tenant = {
  id: ID(1),
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  region: 'eu-west-1',
  plan: 'team',
  ...stamps,
};
const user = {
  id: ID(2),
  keycloakSub: 'sub-1',
  email: 'a@example.test',
  name: 'Ada',
  status: 'active',
  ...stamps,
};
const asset = {
  id: ID(3),
  tenantId: ID(1),
  type: 'web_app',
  identifiers: ['https://app.example.test'],
  environment: 'staging',
  ownerUserId: ID(2),
  verificationStatus: 'verified',
  verificationMethod: 'dns_txt',
  ...stamps,
};
const budgets = { costCapUsd: 25, maxRequests: 1000, maxDurationMs: 3_600_000 };
const sa = {
  id: ID(4),
  tenantId: ID(1),
  assetIds: [ID(3)],
  scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
  maxIntrusiveness: 'active_safe',
  preApprovedTestClasses: [],
  defaultBudgets: budgets,
  testWindows: [{ cron: '0 9 * * 1-5', timezone: 'Europe/London', durationMs: 28_800_000 }],
  validFrom: T0,
  expiresAt: T2,
  requesterId: ID(2),
  approverId: ID(5),
  signature: 'eyJhbGciOiJFZERTQSJ9..sig',
  signingKeyId: 'key-1',
  status: 'active',
  revocationReason: null,
  ...stamps,
};
const run = {
  id: ID(6),
  tenantId: ID(1),
  mode: 'black',
  objective: 'Assess the staging app',
  assetIds: [ID(3)],
  saId: ID(4),
  inputManifestId: null,
  state: 'executing',
  pauseReason: null,
  stateVersion: 3,
  runManifest: { model: 'claude-x' },
  budgets,
  requestedBy: ID(2),
  trigger: 'console',
  startedAt: T0,
  endedAt: null,
  ...stamps,
};
const oracle = { type: 'response.status', params: { expected: 403 } };
const testCase = {
  id: ID(7),
  tenantId: ID(1),
  testPlanId: ID(8),
  class: 'active_safe',
  title: 'Unauthenticated admin access',
  refs: { owasp: ['A01:2021'], wstg: ['WSTG-ATHZ-02'], asvs: [] },
  cweCandidates: ['CWE-284'],
  targets: ['https://app.example.test/admin'],
  roles: ['anonymous'],
  budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1_000_000 },
  oracle,
  negativeControl: null,
  status: 'approved',
  statusReason: null,
  ...stamps,
};
const finding = {
  id: ID(9),
  tenantId: ID(1),
  runId: ID(6),
  assetId: ID(3),
  fingerprint: 'a'.repeat(64),
  title: 'Broken access control on /admin',
  class: 'broken_access_control',
  cweId: 'CWE-284',
  owaspCategory: 'A01:2021',
  severity: {
    cvssV4Vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    cvssV4Score: 8.7,
    cvssV31Vector: null,
  },
  location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
  status: 'confirmed',
  baselineStatus: 'new',
  firstSeenRunId: ID(6),
  lastSeenRunId: ID(6),
  confidence: 0.95,
  acceptedRisk: null,
  releasedBy: null,
  releasedAt: null,
  ...stamps,
};

describe('primitives', () => {
  it('accepts canonical lowercase UUIDv7 only', () => {
    expect(uuidV7Schema.safeParse(ID(1)).success).toBe(true);
    expect(uuidV7Schema.safeParse(ID(0xabc).toUpperCase()).success).toBe(false);
    expect(uuidV7Schema.safeParse('01900000-0000-4000-8000-000000000001').success).toBe(false); // v4
    expect(uuidV7Schema.safeParse('01900000-0000-7000-c000-000000000001').success).toBe(false); // variant
  });

  it('accepts only Z-suffixed millisecond ISO timestamps', () => {
    expect(isoDateTimeSchema.safeParse(T0).success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-01-01T00:00:00Z').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('2026-01-01T00:00:00.000+01:00').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('2026-01-01T00:00:00.000').success).toBe(false);
  });

  it('round-trips every Date as an ISO timestamp (property)', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date(0),
          max: new Date('9999-12-31T23:59:59.999Z'),
          noInvalidDate: true,
        }),
        (d) => isoDateTimeSchema.safeParse(d.toISOString()).success,
      ),
    );
  });
});

describe('entity contracts accept the valid fixtures', () => {
  it.each([
    ['tenant', tenantSchema, tenant],
    ['user', userSchema, user],
    ['asset', assetSchema, asset],
    ['standing authorisation', standingAuthorisationSchema, sa],
    ['run', runSchema, run],
    ['test case', testCaseSchema, testCase],
    ['finding', findingSchema, finding],
  ] as const)('%s', (_label, schema, value) => {
    const result = schema.safeParse(value);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('rejects unknown keys (strict objects)', () => {
    expect(tenantSchema.safeParse({ ...tenant, extra: 1 }).success).toBe(false);
  });

  it('rejects updatedAt before createdAt', () => {
    expect(tenantSchema.safeParse({ ...tenant, createdAt: T1, updatedAt: T0 }).success).toBe(false);
  });
});

describe('tenant and user', () => {
  it('rejects malformed slugs and regions', () => {
    for (const slug of ['Acme', 'a', 'acme--corp', '-acme', 'acme_corp']) {
      expect(tenantSchema.safeParse({ ...tenant, slug }).success, slug).toBe(false);
    }
    expect(tenantSchema.safeParse({ ...tenant, region: 'europe' }).success).toBe(false);
  });

  it('rejects an invalid e-mail', () => {
    expect(userSchema.safeParse({ ...user, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('asset', () => {
  it('needs at least one identifier', () => {
    expect(assetSchema.safeParse({ ...asset, identifiers: [] }).success).toBe(false);
  });

  it('a verified asset records its verification method', () => {
    expect(assetSchema.safeParse({ ...asset, verificationMethod: null }).success).toBe(false);
    expect(
      assetSchema.safeParse({
        ...asset,
        verificationStatus: 'unverified',
        verificationMethod: null,
      }).success,
    ).toBe(true);
  });
});

describe('standing authorisation (§8.3, §8.4)', () => {
  it('can never grant the destructive class', () => {
    expect(
      standingAuthorisationSchema.safeParse({ ...sa, maxIntrusiveness: 'destructive' }).success,
    ).toBe(false);
    expect(
      standingAuthorisationSchema.safeParse({ ...sa, maxIntrusiveness: 'state_changing' }).success,
    ).toBe(true);
  });

  it('rejects requester = approver', () => {
    expect(
      standingAuthorisationSchema.safeParse({ ...sa, approverId: sa.requesterId }).success,
    ).toBe(false);
  });

  it('rejects expiresAt at or before validFrom', () => {
    expect(standingAuthorisationSchema.safeParse({ ...sa, expiresAt: T0 }).success).toBe(false);
  });

  it('an active SA must be approved and signed', () => {
    expect(standingAuthorisationSchema.safeParse({ ...sa, signature: null }).success).toBe(false);
    expect(standingAuthorisationSchema.safeParse({ ...sa, approverId: null }).success).toBe(false);
    expect(
      standingAuthorisationSchema.safeParse({
        ...sa,
        status: 'draft',
        approverId: null,
        signature: null,
        signingKeyId: null,
      }).success,
    ).toBe(true);
  });

  it('a revoked SA records a reason', () => {
    expect(standingAuthorisationSchema.safeParse({ ...sa, status: 'revoked' }).success).toBe(false);
    expect(
      standingAuthorisationSchema.safeParse({
        ...sa,
        status: 'revoked',
        revocationReason: 'contract ended',
      }).success,
    ).toBe(true);
  });

  it('needs at least one include rule and valid ports', () => {
    expect(
      standingAuthorisationSchema.safeParse({
        ...sa,
        scopeRules: { rules: [{ effect: 'exclude', host: 'app.example.test' }] },
      }).success,
    ).toBe(false);
    const badPort = { rules: [{ effect: 'include', host: 'a.example.test', ports: [70000] }] };
    expect(standingAuthorisationSchema.safeParse({ ...sa, scopeRules: badPort }).success).toBe(
      false,
    );
  });
});

describe('run (§3.3)', () => {
  it('pauseReason is set exactly when paused', () => {
    expect(runSchema.safeParse({ ...run, state: 'paused' }).success).toBe(false);
    expect(
      runSchema.safeParse({ ...run, state: 'paused', pauseReason: 'gate2_pending' }).success,
    ).toBe(true);
    expect(runSchema.safeParse({ ...run, pauseReason: 'cost_cap' }).success).toBe(false);
  });

  it('a run paused for a closed test window records pauseReason window_closed (ORCH-014)', () => {
    expect(
      runSchema.safeParse({ ...run, state: 'paused', pauseReason: 'window_closed' }).success,
    ).toBe(true);
  });

  it('only terminal runs have endedAt, and never before startedAt', () => {
    expect(runSchema.safeParse({ ...run, endedAt: T1 }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, state: 'killed', endedAt: T1 }).success).toBe(true);
    expect(
      runSchema.safeParse({ ...run, state: 'completed', startedAt: T1, endedAt: T0 }).success,
    ).toBe(false);
  });

  it('rejects unknown states and negative versions', () => {
    expect(runSchema.safeParse({ ...run, state: 'running' }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, stateVersion: -1 }).success).toBe(false);
  });
});

describe('test case (§3.5, §8.3)', () => {
  it('a destructive test case can never be approved or run', () => {
    for (const status of ['approved', 'executing', 'executed']) {
      expect(
        testCaseSchema.safeParse({ ...testCase, class: 'destructive', status }).success,
        status,
      ).toBe(false);
    }
    expect(
      testCaseSchema.safeParse({
        ...testCase,
        class: 'destructive',
        status: 'blocked',
        statusReason: 'baseline policy',
      }).success,
    ).toBe(true);
  });

  it('blocked/skipped statuses need a reason', () => {
    expect(testCaseSchema.safeParse({ ...testCase, status: 'blocked' }).success).toBe(false);
  });

  it('rejects malformed CWE ids and oracle types', () => {
    expect(testCaseSchema.safeParse({ ...testCase, cweCandidates: ['89'] }).success).toBe(false);
    expect(
      testCaseSchema.safeParse({ ...testCase, oracle: { type: 'Bad Type', params: {} } }).success,
    ).toBe(false);
  });
});

describe('test plan (planner output, ORCH-005)', () => {
  const proposed = {
    class: testCase.class,
    title: testCase.title,
    refs: testCase.refs,
    cweCandidates: testCase.cweCandidates,
    targets: testCase.targets,
    roles: testCase.roles,
    budget: testCase.budget,
    oracle: testCase.oracle,
    negativeControl: testCase.negativeControl,
  };

  it('accepts the proposed fields of a test case, including the oracle and negative control', () => {
    const parsed = testPlanSchema.parse({ testCases: [{ ...proposed, negativeControl: oracle }] });
    expect(parsed.testCases[0]?.negativeControl).toEqual(oracle);
  });

  it('parses an empty plan so the orchestrator can fail it with PLAN_EMPTY', () => {
    expect(testPlanSchema.safeParse({ testCases: [] }).success).toBe(true);
  });

  it('keeps the destructive class parseable: persistence rejects it, not the schema', () => {
    expect(
      testPlanSchema.safeParse({ testCases: [{ ...proposed, class: 'destructive' }] }).success,
    ).toBe(true);
  });

  it('rejects a missing oracle, identity fields, unknown keys and an oversized plan', () => {
    expect(
      testPlanSchema.safeParse({ testCases: [{ ...proposed, oracle: undefined }] }).success,
    ).toBe(false);
    expect(
      testPlanSchema.safeParse({ testCases: [{ ...proposed, status: 'approved' }] }).success,
    ).toBe(false);
    expect(testPlanSchema.safeParse({ testCases: [proposed], extra: 1 }).success).toBe(false);
    const many = Array.from({ length: MAX_PLAN_TEST_CASES + 1 }, () => proposed);
    expect(testPlanSchema.safeParse({ testCases: many }).success).toBe(false);
  });

  it('publishes a JSON Schema for the planner outputFormat', () => {
    const schema = testPlanJsonSchema();
    expect(schema).toMatchObject({ type: 'object', required: ['testCases'] });
  });
});

describe('finding (§3.4)', () => {
  it('released findings record who released them and when', () => {
    expect(findingSchema.safeParse({ ...finding, status: 'released' }).success).toBe(false);
    expect(
      findingSchema.safeParse({ ...finding, status: 'released', releasedBy: ID(5), releasedAt: T1 })
        .success,
    ).toBe(true);
  });

  it('accepted_risk carries a reason and expiry, and only that status does', () => {
    const acceptedRisk = { reason: 'compensating control', expiresAt: T2 };
    expect(findingSchema.safeParse({ ...finding, status: 'accepted_risk' }).success).toBe(false);
    expect(
      findingSchema.safeParse({ ...finding, status: 'accepted_risk', acceptedRisk }).success,
    ).toBe(true);
    expect(findingSchema.safeParse({ ...finding, acceptedRisk }).success).toBe(false);
  });

  it('a location names a URL template or a file', () => {
    const location = { method: null, urlTemplate: null, parameter: null, file: null, line: null };
    expect(findingSchema.safeParse({ ...finding, location }).success).toBe(false);
    expect(
      findingSchema.safeParse({
        ...finding,
        location: { ...location, file: 'src/app.ts', line: 12 },
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range scores and confidences', () => {
    expect(findingSchema.safeParse({ ...finding, confidence: 1.5 }).success).toBe(false);
    expect(
      findingSchema.safeParse({ ...finding, severity: { ...finding.severity, cvssV4Score: 11 } })
        .success,
    ).toBe(false);
    expect(
      findingSchema.safeParse({
        ...finding,
        severity: { ...finding.severity, cvssV4Vector: 'AV:N' },
      }).success,
    ).toBe(false);
  });
});
