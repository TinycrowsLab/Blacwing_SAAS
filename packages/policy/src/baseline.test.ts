import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isAuthorized,
  policyToJson,
  type CedarValueJson,
  type EntityJson,
} from '@cedar-policy/cedar-wasm/nodejs';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASELINE_ID_PREFIX,
  BASELINE_SHA256,
  BASELINE_VERSION,
  BaselineIntegrityError,
  baselineDigest,
  baselinePin,
  cedarDatetime,
  compilePolicySet,
  intrusivenessValue,
  isBaselinePolicyId,
  loadBaseline,
  loadBaselinePolicies,
  loadBlackwingSchema,
  schemaPin,
  toCedarAttrs,
  type AgentSessionAttrs,
  type DecisionContext,
  type TargetAttrs,
  type TestCaseAttrs,
  type UserAttrs,
} from './index.js';

import type { IntrusivenessClass } from '@blackwing/contracts';

const schema = loadBlackwingSchema();

// ---- Fixtures ---------------------------------------------------------------------------

const TENANT = 'ten_a';
const PINNED_SCOPE = 'sha256:scope-1';
const VALID_FROM = '2026-10-01T00:00:00.000Z';
const EXPIRES_AT = '2026-11-01T00:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';

interface Facts {
  now: string;
  validFrom: string;
  expiresAt: string;
  windowOpen: boolean;
  intrusiveness: IntrusivenessClass;
  envelopeMax: IntrusivenessClass;
  sessionCeiling: IntrusivenessClass;
  reversalJournalPresent: boolean;
  isPrivateRange: boolean;
  isMetadata: boolean;
  saIncludesRange: boolean;
  envelopeScopeHash: string;
  contextTenant: string;
  principalTenant: string;
  resourceTenant: string;
  inScope: boolean;
  testCaseClass: IntrusivenessClass;
  requestedBy: string;
  approverId: string;
  actingUser: string;
}

const DEFAULT_FACTS: Facts = {
  now: NOW,
  validFrom: VALID_FROM,
  expiresAt: EXPIRES_AT,
  windowOpen: true,
  intrusiveness: 'passive',
  envelopeMax: 'active_safe',
  sessionCeiling: 'active_safe',
  reversalJournalPresent: false,
  isPrivateRange: false,
  isMetadata: false,
  saIncludesRange: false,
  envelopeScopeHash: PINNED_SCOPE,
  contextTenant: TENANT,
  principalTenant: TENANT,
  resourceTenant: TENANT,
  inScope: true,
  testCaseClass: 'passive',
  requestedBy: 'usr_requester',
  approverId: 'usr_approver',
  actingUser: 'usr_approver',
};

type Kind =
  | 'httpRequest'
  | 'tcpConnect'
  | 'dnsResolve'
  | 'toolTarget'
  | 'toolTestCase'
  | 'gate'
  | 'scopeException';

function baseContext(f: Facts): DecisionContext {
  return {
    nowUtc: cedarDatetime(f.now),
    envelope: {
      saId: 'sa_01',
      validFrom: cedarDatetime(f.validFrom),
      expiresAt: cedarDatetime(f.expiresAt),
      maxIntrusiveness: intrusivenessValue(f.envelopeMax),
      scopeHash: f.envelopeScopeHash,
    },
    intrusiveness: intrusivenessValue(f.intrusiveness),
    reversalJournalPresent: f.reversalJournalPresent,
    windowOpen: f.windowOpen,
    tenantId: f.contextTenant,
    isPrivateRange: f.isPrivateRange,
    isMetadata: f.isMetadata,
    saIncludesRange: f.saIncludesRange,
    pinnedScopeHash: PINNED_SCOPE,
  };
}

function entities(f: Facts): EntityJson[] {
  const session: AgentSessionAttrs = {
    tenantId: f.principalTenant,
    persona: 'web',
    runId: 'run_1',
    sessionId: 'ses_1',
    egressIdentity: 'egr_1',
    intrusivenessCeiling: intrusivenessValue(f.sessionCeiling),
  };
  const target: TargetAttrs = {
    tenantId: f.resourceTenant,
    host: 'juice.lab.local',
    ip: '203.0.113.10',
    port: 443,
    path: '/',
    method: 'GET',
    inScope: f.inScope,
  };
  const testCase: TestCaseAttrs = {
    tenantId: f.resourceTenant,
    class: intrusivenessValue(f.testCaseClass),
    runId: 'run_1',
    oracleType: 'status_diff',
  };
  const user: UserAttrs = {
    tenantId: f.principalTenant,
    userId: f.actingUser,
    roles: ['approver'],
  };
  return [
    {
      uid: { type: 'Blackwing::AgentSession', id: 'ses_1' },
      attrs: toCedarAttrs(session),
      parents: [],
    },
    { uid: { type: 'Blackwing::Target', id: 't_1' }, attrs: toCedarAttrs(target), parents: [] },
    {
      uid: { type: 'Blackwing::TestCase', id: 'tc_1' },
      attrs: toCedarAttrs(testCase),
      parents: [],
    },
    { uid: { type: 'Blackwing::User', id: f.actingUser }, attrs: toCedarAttrs(user), parents: [] },
    {
      uid: { type: 'Blackwing::Run', id: 'run_1' },
      attrs: toCedarAttrs({
        tenantId: f.resourceTenant,
        runId: 'run_1',
        saId: 'sa_01',
        mode: 'grey_box',
        state: 'running',
      }),
      parents: [],
    },
  ];
}

interface Req {
  principal: { type: string; id: string };
  action: { type: string; id: string };
  resource: { type: string; id: string };
  context: Record<string, CedarValueJson>;
  entities: EntityJson[];
}

function request(kind: Kind, overrides: Partial<Facts> = {}): Req {
  const f: Facts = { ...DEFAULT_FACTS, ...overrides };
  const ctx = baseContext(f);
  const session = { type: 'Blackwing::AgentSession', id: 'ses_1' };
  const target = { type: 'Blackwing::Target', id: 't_1' };
  const common = { entities: entities(f) };
  switch (kind) {
    case 'httpRequest':
    case 'tcpConnect':
    case 'dnsResolve':
      return {
        ...common,
        principal: session,
        action: { type: 'Egress::Action', id: kind },
        resource: target,
        context: toCedarAttrs(ctx),
      };
    case 'toolTarget':
    case 'toolTestCase':
      return {
        ...common,
        principal: session,
        action: { type: 'Tool::Action', id: 'invoke' },
        resource: kind === 'toolTarget' ? target : { type: 'Blackwing::TestCase', id: 'tc_1' },
        context: toCedarAttrs({ ...ctx, toolName: 'httpx' }),
      };
    case 'gate':
      return {
        ...common,
        principal: { type: 'Blackwing::User', id: f.actingUser },
        action: { type: 'Gate::Action', id: 'decide' },
        resource: { type: 'Blackwing::Run', id: 'run_1' },
        context: toCedarAttrs({ ...ctx, gate: 'gate2', requestedBy: f.requestedBy }),
      };
    case 'scopeException':
      return {
        ...common,
        principal: session,
        action: { type: 'Scope::Action', id: 'requestException' },
        resource: target,
        context: toCedarAttrs({ ...ctx, requestedBy: f.requestedBy, approverId: f.approverId }),
      };
  }
}

/** A tenant that permits everything: only the baseline can deny. */
const PERMIT_ALL = { 'tenant.permit-all': 'permit (principal, action, resource);' };

interface Outcome {
  decision: 'allow' | 'deny';
  reasons: string[];
  errors: number;
}

/**
 * Evaluates a request against the compiled set the way POLICY-006 must: schema request validation
 * on, and every failure (invalid request, missing attribute) mapped to deny (§8.2, §8.11).
 */
function decide(
  req: Req,
  tenant: Readonly<Record<string, string>> = PERMIT_ALL,
  validateRequest = true,
): Outcome {
  const set = compilePolicySet(tenant);
  if (!set.ok) throw new Error(set.errors.join('; '));
  const answer = isAuthorized({
    principal: req.principal,
    action: req.action,
    resource: req.resource,
    context: req.context,
    policies: { staticPolicies: { ...set.staticPolicies } },
    entities: req.entities,
    ...(validateRequest ? { schema, validateRequest: true } : {}),
  });
  if (answer.type === 'failure')
    return { decision: 'deny', reasons: [], errors: answer.errors.length };
  return {
    decision: answer.response.decision,
    reasons: answer.response.diagnostics.reason,
    errors: answer.response.diagnostics.errors.length,
  };
}

// ---- Golden decision table ----------------------------------------------------------------

interface Golden {
  name: string;
  kind: Kind;
  facts?: Partial<Facts>;
  expect: 'allow' | 'deny';
  /** Baseline policy ids that must be among the determining policies of a deny. */
  by?: string[];
}

const EGRESS: Kind[] = ['httpRequest', 'tcpConnect', 'dnsResolve'];
const STATE_CHANGING_OK: Partial<Facts> = {
  intrusiveness: 'state_changing',
  envelopeMax: 'state_changing',
  sessionCeiling: 'state_changing',
  reversalJournalPresent: true,
};

const GOLDEN: Golden[] = [
  // Sanity: a well-formed in-scope passive request is not denied by the baseline.
  ...EGRESS.map((kind): Golden => ({ name: `passive in-scope ${kind}`, kind, expect: 'allow' })),
  { name: 'passive tool invoke on a target', kind: 'toolTarget', expect: 'allow' },
  { name: 'passive tool invoke on a test case', kind: 'toolTestCase', expect: 'allow' },

  // (a) destructive — §8.3
  ...EGRESS.map((kind): Golden => ({
    name: `destructive ${kind}`,
    kind,
    facts: {
      intrusiveness: 'destructive',
      envelopeMax: 'destructive',
      sessionCeiling: 'destructive',
      reversalJournalPresent: true,
    },
    expect: 'deny',
    by: ['baseline.destructive.egress'],
  })),
  {
    name: 'destructive tool invoke (context)',
    kind: 'toolTarget',
    facts: {
      intrusiveness: 'destructive',
      envelopeMax: 'destructive',
      sessionCeiling: 'destructive',
      reversalJournalPresent: true,
    },
    expect: 'deny',
    by: ['baseline.destructive.tool'],
  },
  {
    name: 'destructive test case under a passive request',
    kind: 'toolTestCase',
    facts: {
      testCaseClass: 'destructive',
      envelopeMax: 'destructive',
      sessionCeiling: 'destructive',
      reversalJournalPresent: true,
    },
    expect: 'deny',
    by: ['baseline.destructive.tool'],
  },
  {
    name: 'destructive scope-exception request',
    kind: 'scopeException',
    facts: { intrusiveness: 'destructive' },
    expect: 'deny',
    by: ['baseline.destructive.scope-exception'],
  },

  // (b) state_changing — §8.3
  {
    name: 'state_changing egress without a reversal-journal entry',
    kind: 'httpRequest',
    facts: { ...STATE_CHANGING_OK, reversalJournalPresent: false },
    expect: 'deny',
    by: ['baseline.state-changing.egress'],
  },
  {
    name: 'state_changing egress with journal entry and SA approval',
    kind: 'httpRequest',
    facts: STATE_CHANGING_OK,
    expect: 'allow',
  },
  {
    name: 'state_changing egress with journal entry but an SA that does not approve it',
    kind: 'httpRequest',
    facts: { ...STATE_CHANGING_OK, envelopeMax: 'active_safe' },
    expect: 'deny',
    by: ['baseline.state-changing.egress', 'baseline.intrusiveness-ceiling.egress'],
  },
  {
    name: 'state_changing test case without a journal entry',
    kind: 'toolTestCase',
    facts: {
      ...STATE_CHANGING_OK,
      intrusiveness: 'passive',
      testCaseClass: 'state_changing',
      reversalJournalPresent: false,
    },
    expect: 'deny',
    by: ['baseline.state-changing.tool'],
  },
  {
    name: 'state_changing test case with journal entry and SA approval',
    kind: 'toolTestCase',
    facts: { ...STATE_CHANGING_OK, intrusiveness: 'passive', testCaseClass: 'state_changing' },
    expect: 'allow',
  },

  // Ceiling — §8.1 / §8.3
  {
    name: 'active_safe request above a passive session ceiling',
    kind: 'httpRequest',
    facts: { intrusiveness: 'active_safe', sessionCeiling: 'passive' },
    expect: 'deny',
    by: ['baseline.intrusiveness-ceiling.egress'],
  },
  {
    name: 'active_safe test case above a passive envelope ceiling',
    kind: 'toolTestCase',
    facts: { testCaseClass: 'active_safe', envelopeMax: 'passive' },
    expect: 'deny',
    by: ['baseline.intrusiveness-ceiling.tool'],
  },

  // (c) out of scope — §8.2 default deny
  ...EGRESS.map((kind): Golden => ({
    name: `out-of-scope ${kind}`,
    kind,
    facts: { inScope: false },
    expect: 'deny',
    by: ['baseline.out-of-scope.egress'],
  })),
  {
    name: 'tool invoke aimed at an out-of-scope target',
    kind: 'toolTarget',
    facts: { inScope: false },
    expect: 'deny',
    by: ['baseline.out-of-scope.tool'],
  },

  // (d) private / link-local / metadata — §8.2, CWE-918
  {
    name: 'metadata endpoint in scope but not listed explicitly by the SA',
    kind: 'httpRequest',
    facts: { isMetadata: true, inScope: true, saIncludesRange: false },
    expect: 'deny',
    by: ['baseline.private-range.egress'],
  },
  {
    name: 'private range in scope but not listed explicitly by the SA',
    kind: 'tcpConnect',
    facts: { isPrivateRange: true, inScope: true, saIncludesRange: false },
    expect: 'deny',
    by: ['baseline.private-range.egress'],
  },
  {
    name: 'private range listed by the SA but the target is out of scope',
    kind: 'httpRequest',
    facts: { isPrivateRange: true, inScope: false, saIncludesRange: true },
    expect: 'deny',
    by: ['baseline.private-range.egress', 'baseline.out-of-scope.egress'],
  },
  {
    name: 'private range in scope and listed explicitly by the SA',
    kind: 'httpRequest',
    facts: { isPrivateRange: true, saIncludesRange: true },
    expect: 'allow',
  },
  {
    name: 'metadata range in scope and listed explicitly by the SA',
    kind: 'httpRequest',
    facts: { isMetadata: true, saIncludesRange: true },
    expect: 'allow',
  },
  {
    name: 'tool invoke on a test case while the destination is a metadata address',
    kind: 'toolTestCase',
    facts: { isMetadata: true, saIncludesRange: true },
    expect: 'deny',
    by: ['baseline.private-range.tool'],
  },

  // (e) envelope validity and window — §8.1
  {
    name: 'egress after expiry',
    kind: 'httpRequest',
    facts: { now: '2026-11-02T00:00:00.000Z' },
    expect: 'deny',
    by: ['baseline.envelope-validity.egress'],
  },
  {
    name: 'egress at exactly expiresAt (inclusive deny)',
    kind: 'httpRequest',
    facts: { now: EXPIRES_AT },
    expect: 'deny',
    by: ['baseline.envelope-validity.egress'],
  },
  {
    name: 'egress one millisecond before expiresAt',
    kind: 'httpRequest',
    facts: { now: '2026-10-31T23:59:59.999Z' },
    expect: 'allow',
  },
  {
    name: 'egress at exactly validFrom',
    kind: 'httpRequest',
    facts: { now: VALID_FROM },
    expect: 'allow',
  },
  {
    name: 'egress before validFrom',
    kind: 'httpRequest',
    facts: { now: '2026-09-30T23:59:59.999Z' },
    expect: 'deny',
    by: ['baseline.envelope-validity.egress'],
  },
  {
    name: 'egress with the window closed',
    kind: 'dnsResolve',
    facts: { windowOpen: false },
    expect: 'deny',
    by: ['baseline.envelope-validity.egress'],
  },
  {
    name: 'tool invoke after expiry',
    kind: 'toolTestCase',
    facts: { now: EXPIRES_AT },
    expect: 'deny',
    by: ['baseline.envelope-validity.tool'],
  },
  {
    name: 'tool invoke with the window closed',
    kind: 'toolTarget',
    facts: { windowOpen: false },
    expect: 'deny',
    by: ['baseline.envelope-validity.tool'],
  },

  // (f) separation of duties — §8.4
  {
    name: 'gate decided by its requester',
    kind: 'gate',
    facts: { actingUser: 'usr_requester' },
    expect: 'deny',
    by: ['baseline.sod-gate-decide'],
  },
  { name: 'gate decided by a different user', kind: 'gate', expect: 'allow' },
  {
    name: 'scope exception whose approver is its requester',
    kind: 'scopeException',
    facts: { approverId: 'usr_requester' },
    expect: 'deny',
    by: ['baseline.sod-scope-exception'],
  },
  { name: 'scope exception with a separate approver', kind: 'scopeException', expect: 'allow' },

  // (g) scope-hash anti-tamper — §8.1 / §8.9
  {
    name: 'egress with a tampered envelope scope hash',
    kind: 'httpRequest',
    facts: { envelopeScopeHash: 'sha256:other' },
    expect: 'deny',
    by: ['baseline.scope-hash.egress'],
  },
  {
    name: 'tool invoke with a tampered envelope scope hash',
    kind: 'toolTestCase',
    facts: { envelopeScopeHash: 'sha256:other' },
    expect: 'deny',
    by: ['baseline.scope-hash.tool'],
  },

  // Tenant isolation — §8.6
  {
    name: 'principal from another tenant',
    kind: 'httpRequest',
    facts: { principalTenant: 'ten_b' },
    expect: 'deny',
    by: ['baseline.tenant-isolation'],
  },
  {
    name: 'resource from another tenant',
    kind: 'toolTestCase',
    facts: { resourceTenant: 'ten_b' },
    expect: 'deny',
    by: ['baseline.tenant-isolation'],
  },
  {
    name: 'gate decision across tenants',
    kind: 'gate',
    facts: { principalTenant: 'ten_b' },
    expect: 'deny',
    by: ['baseline.tenant-isolation'],
  },
];

describe('baseline golden decisions (POLICY-002), with a tenant permit-all present', () => {
  it.each(GOLDEN.filter((g) => g.expect === 'deny'))('$name → deny', (g) => {
    const out = decide(request(g.kind, g.facts));
    expect(out).toMatchObject({ decision: 'deny', errors: 0 });
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.reasons.every((id) => isBaselinePolicyId(id))).toBe(true);
    expect(out.reasons).toEqual(expect.arrayContaining(g.by ?? []));
  });

  it.each(GOLDEN.filter((g) => g.expect === 'allow'))('$name → not denied by the baseline', (g) => {
    expect(decide(request(g.kind, g.facts))).toEqual({
      decision: 'allow',
      reasons: ['tenant.permit-all'],
      errors: 0,
    });
  });

  it('covers every baseline policy with at least one denying golden case', () => {
    const covered = new Set(GOLDEN.flatMap((g) => g.by ?? []));
    for (const p of loadBaselinePolicies()) expect(covered).toContain(p.id);
  });
});

describe('baseline is non-overridable', () => {
  it('denies a destructive action even with a tenant permit written for exactly that action', () => {
    const tenant = {
      'tenant.allow-destructive': `permit (
        principal is Blackwing::AgentSession,
        action == Egress::Action::"httpRequest",
        resource is Blackwing::Target
      ) when { context.intrusiveness.level == Blackwing::IntrusivenessClass::"destructive" };`,
    };
    const facts = {
      intrusiveness: 'destructive',
      envelopeMax: 'destructive',
      sessionCeiling: 'destructive',
      reversalJournalPresent: true,
    } as const;
    const out = decide(request('httpRequest', facts), tenant);
    expect(out).toMatchObject({ decision: 'deny', errors: 0 });
    expect(out.reasons).toContain('baseline.destructive.egress');
    expect(out.reasons).not.toContain('tenant.allow-destructive');
  });

  it('forbid wins over a matching permit (ambiguous permit + forbid)', () => {
    const req = request('httpRequest', { inScope: false });
    // Both the tenant permit and the baseline forbid match; Cedar returns deny for the forbid only.
    const out = decide(req, {
      'tenant.p': 'permit (principal, action == Egress::Action::"httpRequest", resource);',
    });
    expect(out.decision).toBe('deny');
    expect(out.reasons).toEqual(['baseline.out-of-scope.egress']);
  });

  it('a tenant forbid can still narrow what the baseline allows', () => {
    const out = decide(request('httpRequest'), {
      ...PERMIT_ALL,
      'tenant.no-http': 'forbid (principal, action == Egress::Action::"httpRequest", resource);',
    });
    expect(out).toMatchObject({ decision: 'deny', reasons: ['tenant.no-http'] });
  });

  it('denies by default when no tenant permit exists', () => {
    expect(decide(request('httpRequest'), {}).decision).toBe('deny');
  });

  it('property: no tenant permit ever overrides a baseline-forbidden request', () => {
    const principals = [
      'principal',
      'principal is Blackwing::AgentSession',
      'principal is Blackwing::User',
    ];
    const actions = [
      'action',
      'action == Egress::Action::"httpRequest"',
      'action in [Egress::Action::"httpRequest", Egress::Action::"tcpConnect", Egress::Action::"dnsResolve"]',
      'action == Tool::Action::"invoke"',
      'action == Gate::Action::"decide"',
      'action == Scope::Action::"requestException"',
    ];
    const resources = [
      'resource',
      'resource is Blackwing::Target',
      'resource is Blackwing::TestCase',
      'resource is Blackwing::Run',
    ];
    const conditions = ['', ' when { true }', ' unless { false }'];
    const permitArb = fc
      .tuple(
        fc.constantFrom(...principals),
        fc.constantFrom(...actions),
        fc.constantFrom(...resources),
        fc.constantFrom(...conditions),
      )
      .map(([p, a, r, c]) => `permit (${p}, ${a}, ${r})${c};`);
    const forbidden: [Kind, Partial<Facts>][] = GOLDEN.filter((g) => g.expect === 'deny').map(
      (g) => [g.kind, g.facts ?? {}],
    );

    fc.assert(
      fc.property(
        fc.array(permitArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...forbidden),
        (permits, [kind, facts]) => {
          const tenant = Object.fromEntries(
            permits.map((text, i) => [`tenant.p${String(i)}`, text]),
          );
          const compiled = compilePolicySet(tenant);
          // Permits whose scope cannot match any declared action signature are rejected outright.
          if (!compiled.ok) return;
          expect(decide(request(kind, facts), tenant).decision).toBe('deny');
        },
      ),
      { numRuns: 120 },
    );
  }, 60_000);
});

describe('fail closed on missing critical context', () => {
  function withoutKey(req: Req, key: string): Req {
    return {
      ...req,
      context: Object.fromEntries(Object.entries(req.context).filter(([k]) => k !== key)),
    };
  }

  it.each([
    'windowOpen',
    'isMetadata',
    'isPrivateRange',
    'pinnedScopeHash',
    'reversalJournalPresent',
    'nowUtc',
    'envelope',
  ])(
    'denies when `%s` is absent, even with a tenant permit-all (request validation fails)',
    (key) => {
      const out = decide(withoutKey(request('httpRequest'), key));
      expect(out.decision).toBe('deny');
      expect(out.errors).toBeGreaterThan(0);
    },
  );

  it('documents why the engine must validate requests: unchecked, an erroring forbid is skipped', () => {
    // Cedar skips a policy whose condition errors. Without schema request validation the
    // envelope-validity forbid errors on the missing `windowOpen`, so only POLICY-006's mandatory
    // request validation (plus error ⇒ deny) keeps this fail closed.
    const out = decide(withoutKey(request('httpRequest'), 'windowOpen'), PERMIT_ALL, false);
    expect(out.errors).toBeGreaterThan(0);
  });
});

describe('compilePolicySet', () => {
  it('orders baseline policies before tenant policies', () => {
    const set = compilePolicySet({ 'tenant.z': 'permit (principal, action, resource);' });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const ids = Object.keys(set.staticPolicies);
    expect(ids.slice(0, set.baselineIds.length)).toEqual([...set.baselineIds]);
    expect(ids.slice(set.baselineIds.length)).toEqual(['tenant.z']);
    expect(set.tenantIds).toEqual(['tenant.z']);
    expect(set.pin).toEqual({ ...baselinePin(), ...schemaPin() });
  });

  it.each([
    [
      'a reserved baseline id',
      { 'baseline.destructive.egress': 'permit (principal, action, resource);' },
    ],
    ['a new reserved baseline id', { 'baseline.mine': 'permit (principal, action, resource);' }],
    [
      'a reserved @id annotation',
      { 'tenant.x': '@id("baseline.destructive.egress") permit (principal, action, resource);' },
    ],
    ['an empty id', { ' ': 'permit (principal, action, resource);' }],
    [
      'two policies under one id',
      {
        'tenant.two': 'permit (principal, action, resource); permit (principal, action, resource);',
      },
    ],
    ['a template', { 'tenant.t': 'permit (principal == ?principal, action, resource);' }],
    ['unparsable text', { 'tenant.bad': 'permit (principal, action' }],
    [
      'a redefined/unknown action',
      { 'tenant.a': 'permit (principal, action == Egress::Action::"rawSocket", resource);' },
    ],
    [
      'an unknown entity type',
      { 'tenant.e': 'permit (principal is Blackwing::Root, action, resource);' },
    ],
    [
      'an undeclared attribute',
      { 'tenant.attr': 'permit (principal, action, resource) when { context.overrideBaseline };' },
    ],
  ])('rejects %s', (_label, tenant) => {
    expect(compilePolicySet(tenant)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.any(String)]) as unknown,
    });
  });

  it('compiles the baseline alone', () => {
    const set = compilePolicySet();
    expect(set.ok && set.tenantIds.length === 0).toBe(true);
  });
});

describe('baseline source integrity', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function dirWith(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), 'bw-baseline-'));
    dirs.push(d);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
    return d;
  }

  it('is pinned: BASELINE_SHA256 is the digest of the shipped files (bump BASELINE_VERSION with it)', () => {
    expect(BASELINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baselineDigest()).toBe(BASELINE_SHA256);
    expect(baselinePin()).toEqual({
      baselineVersion: BASELINE_VERSION,
      baselineSha256: BASELINE_SHA256,
    });
  });

  it('contains only forbid policies, all in the reserved namespace', () => {
    for (const p of loadBaselinePolicies()) {
      expect(p.id.startsWith(BASELINE_ID_PREFIX)).toBe(true);
      expect(policyToJson(p.text)).toMatchObject({ type: 'success', json: { effect: 'forbid' } });
    }
  });

  it('cites a §8 invariant and a feature id in every file', () => {
    for (const f of loadBaseline().files) {
      expect(f.source).toMatch(/§8(\.\d+)?/);
      expect(f.source).toMatch(/\bF\d+\b/);
    }
  });

  it('changes the digest when a file is edited, even only in a comment', () => {
    const a = dirWith({
      'x.cedar': '// one\n@id("baseline.x") forbid (principal, action, resource);',
    });
    const b = dirWith({
      'x.cedar': '// two\n@id("baseline.x") forbid (principal, action, resource);',
    });
    expect(baselineDigest(loadBaseline(a))).not.toBe(baselineDigest(loadBaseline(b)));
  });

  it.each([
    ['an empty directory', {}],
    ['a missing @id', { 'x.cedar': 'forbid (principal, action, resource);' }],
    [
      'an @id outside the file namespace',
      { 'x.cedar': '@id("baseline.y") forbid (principal, action, resource);' },
    ],
    [
      'a duplicate id',
      {
        'x.cedar':
          '@id("baseline.x") forbid (principal, action, resource);\n@id("baseline.x") forbid (principal, action, resource);',
      },
    ],
    ['unparsable text', { 'x.cedar': '@id("baseline.x") forbid (principal' }],
  ])('refuses to load a baseline with %s', (_label, files) => {
    expect(() => loadBaseline(dirWith(files))).toThrow(BaselineIntegrityError);
  });
});
