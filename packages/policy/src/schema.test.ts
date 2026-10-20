import { readFileSync } from 'node:fs';

import { isAuthorized, schemaToJson, type Entities } from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  INTRUSIVENESS_CLASSES,
  INTRUSIVENESS_ORDER,
  type IntrusivenessClass,
} from '@blackwing/contracts';

import { renderSchemaTypes, SchemaCodegenError } from './codegen/render.js';
import {
  ACTIONS,
  INTRUSIVENESS_CLASS_IDS,
  SCHEMA_ATTRIBUTES,
  SCHEMA_SHA256,
  SCHEMA_VERSION,
  cedarDatetime,
  intrusivenessValue,
  loadBlackwingSchema,
  schemaDigest,
  schemaPin,
  toCedarAttrs,
  validatePolicies,
  validateSchema,
  type ActionSignatures,
  type ActionUid,
  type AgentSessionAttrs,
  type AssetAttrs,
  type DecisionContext,
  type Envelope,
  type IntrusivenessClassId,
  type RunAttrs,
  type ServiceAccountAttrs,
  type TargetAttrs,
  type TestCaseAttrs,
  type ToolInvokeContext,
  type UserAttrs,
} from './index.js';

const schema = loadBlackwingSchema();

const BASE_CONTEXT_KEYS = [
  'envelope',
  'intrusiveness',
  'nowUtc',
  'reversalJournalPresent',
  'tenantId',
  'windowOpen',
] as const;

/** A representative baseline-style policy using every kind of attribute the schema declares. */
const SAMPLE_POLICIES = `
forbid (principal, action, resource)
when { context.intrusiveness.level == Blackwing::IntrusivenessClass::"destructive" };

forbid (principal, action in [Egress::Action::"httpRequest", Egress::Action::"tcpConnect"], resource)
when { context.intrusiveness.rank > context.envelope.maxIntrusiveness.rank };

permit (
  principal is Blackwing::AgentSession,
  action == Egress::Action::"httpRequest",
  resource is Blackwing::Target
)
when {
  resource.inScope &&
  context.windowOpen &&
  context.envelope.validFrom <= context.nowUtc &&
  context.nowUtc < context.envelope.expiresAt &&
  principal.tenantId == context.tenantId &&
  resource.tenantId == context.tenantId &&
  context.intrusiveness.rank <= principal.intrusivenessCeiling.rank &&
  (context.intrusiveness.level != Blackwing::IntrusivenessClass::"state_changing" ||
    context.reversalJournalPresent)
};

permit (principal is Blackwing::AgentSession, action == Tool::Action::"invoke", resource is Blackwing::TestCase)
when { context.toolName == "nuclei" && resource.class.rank <= context.envelope.maxIntrusiveness.rank };

forbid (principal is Blackwing::User, action == Gate::Action::"decide", resource)
when { context.requestedBy == principal.userId };

permit (principal is Blackwing::ServiceAccount, action == Policy::Action::"edit", resource is Blackwing::Asset)
when { principal has saId && principal.scopes.contains("policy:write") && resource.verified };
`;

function envelope(): Envelope {
  return {
    saId: 'sa_01',
    validFrom: cedarDatetime('2026-10-01T00:00:00Z'),
    expiresAt: cedarDatetime('2026-11-01T00:00:00Z'),
    maxIntrusiveness: intrusivenessValue('active_safe'),
    scopeHash: 'sha256:00',
  };
}

function httpContext(): DecisionContext {
  return {
    nowUtc: cedarDatetime('2026-10-20T12:00:00.000Z'),
    envelope: envelope(),
    intrusiveness: intrusivenessValue('passive'),
    reversalJournalPresent: false,
    windowOpen: true,
    tenantId: 'ten_a',
  };
}

const session: AgentSessionAttrs = {
  tenantId: 'ten_a',
  persona: 'recon',
  runId: 'run_1',
  sessionId: 'ses_1',
  egressIdentity: 'egr_1',
  intrusivenessCeiling: intrusivenessValue('active_safe'),
};
const target: TargetAttrs = {
  tenantId: 'ten_a',
  host: 'juice.lab.local',
  ip: '10.0.0.5',
  port: 443,
  path: '/',
  method: 'GET',
  inScope: true,
};

const ENTITIES: Entities = [
  {
    uid: { type: 'Blackwing::AgentSession', id: 'ses_1' },
    attrs: toCedarAttrs(session),
    parents: [],
  },
  { uid: { type: 'Blackwing::Target', id: 't1' }, attrs: toCedarAttrs(target), parents: [] },
];

function without(context: DecisionContext, key: keyof DecisionContext): Partial<DecisionContext> {
  return Object.fromEntries(Object.entries(context).filter(([k]) => k !== key));
}

function authorize(context: Partial<DecisionContext>, validateRequest: boolean) {
  return isAuthorized({
    principal: { type: 'Blackwing::AgentSession', id: 'ses_1' },
    action: { type: 'Egress::Action', id: 'httpRequest' },
    resource: { type: 'Blackwing::Target', id: 't1' },
    context: toCedarAttrs(context),
    policies: { staticPolicies: SAMPLE_POLICIES },
    entities: ENTITIES,
    ...(validateRequest ? { schema, validateRequest: true } : {}),
  });
}

describe('Cedar schema (POLICY-001)', () => {
  it('parses and validates with @cedar-policy/cedar-wasm', () => {
    expect(validateSchema()).toEqual({ ok: true, errors: [] });
  });

  it('rejects a malformed schema', () => {
    const result = validateSchema('namespace Broken { entity A = { x: NoSuchType }; }');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a baseline-style policy set in strict mode', () => {
    expect(validatePolicies(SAMPLE_POLICIES)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    [
      'an undeclared context attribute',
      'permit (principal, action == Egress::Action::"httpRequest", resource) when { context.notDeclared };',
    ],
    [
      'an undeclared principal attribute',
      'permit (principal is Blackwing::AgentSession, action == Egress::Action::"httpRequest", resource) when { principal.isAdmin };',
    ],
    [
      'an undeclared resource attribute',
      'permit (principal, action == Egress::Action::"httpRequest", resource is Blackwing::Target) when { resource.cidr == "10.0.0.0/8" };',
    ],
    [
      'a context attribute of another action',
      'permit (principal, action == Egress::Action::"httpRequest", resource) when { context.toolName == "x" };',
    ],
    [
      'an undeclared action',
      'permit (principal, action == Egress::Action::"rawSocket", resource);',
    ],
    ['an undeclared entity type', 'permit (principal is Blackwing::Admin, action, resource);'],
    [
      'an action applied to the wrong resource',
      'permit (principal, action == Egress::Action::"httpRequest", resource is Blackwing::Run);',
    ],
    [
      'an unknown intrusiveness class',
      'forbid (principal, action, resource) when { context.intrusiveness.level == Blackwing::IntrusivenessClass::"nuclear" };',
    ],
  ])('rejects a policy referencing %s', (_label, policy) => {
    const result = validatePolicies(policy);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('does not let policies do CIDR/scope matching: Target.ip is a String, inScope is computed in code', () => {
    const cidr =
      'permit (principal, action == Egress::Action::"tcpConnect", resource is Blackwing::Target) when { ip(resource.ip).isInRange(ip("10.0.0.0/8")) };';
    expect(validatePolicies(cidr).ok).toBe(false);
  });

  it('declares every required action with its appliesTo', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([
      'Egress::Action::"dnsResolve"',
      'Egress::Action::"httpRequest"',
      'Egress::Action::"tcpConnect"',
      'Gate::Action::"decide"',
      'Policy::Action::"edit"',
      'Scope::Action::"requestException"',
      'Tool::Action::"invoke"',
    ]);
    for (const uid of [
      'Egress::Action::"httpRequest"',
      'Egress::Action::"tcpConnect"',
      'Egress::Action::"dnsResolve"',
      'Scope::Action::"requestException"',
    ] as const) {
      expect(ACTIONS[uid]).toMatchObject({
        principalTypes: ['Blackwing::AgentSession'],
        resourceTypes: ['Blackwing::Target'],
      });
    }
    expect(ACTIONS['Tool::Action::"invoke"'].context).toBe('ToolInvokeContext');
    expect(SCHEMA_ATTRIBUTES.ToolInvokeContext).toContain('toolName');
  });

  it('gives every action context all the deterministic base facts', () => {
    for (const action of Object.values(ACTIONS)) {
      const keys: readonly string[] = SCHEMA_ATTRIBUTES[action.context];
      for (const key of BASE_CONTEXT_KEYS) expect(keys).toContain(key);
    }
    expect(SCHEMA_ATTRIBUTES.DecisionContext).toEqual(BASE_CONTEXT_KEYS);
    expect(SCHEMA_ATTRIBUTES.Envelope).toEqual([
      'expiresAt',
      'maxIntrusiveness',
      'saId',
      'scopeHash',
      'validFrom',
    ]);
  });
});

describe('generated TS types (src/schema.types.ts)', () => {
  it('are up to date with the schema (regenerate with gen:schema-types)', () => {
    const committed = readFileSync(new URL('./schema.types.ts', import.meta.url), 'utf8');
    expect(renderSchemaTypes(schema)).toBe(committed);
  });

  it('list exactly the attributes the schema declares', () => {
    const answer = schemaToJson(schema);
    if (answer.type !== 'success') throw new Error('schema must parse');
    const ns = answer.json.Blackwing;
    const attrs = (shape: unknown): string[] =>
      Object.keys((shape as { attributes: Record<string, unknown> }).attributes).sort();
    for (const [entity, def] of Object.entries(ns?.entityTypes ?? {})) {
      if ('enum' in def) continue;
      expect(SCHEMA_ATTRIBUTES[`${entity}Attrs` as keyof typeof SCHEMA_ATTRIBUTES]).toEqual(
        attrs(def.shape),
      );
    }
    for (const [common, def] of Object.entries(ns?.commonTypes ?? {})) {
      expect(SCHEMA_ATTRIBUTES[common as keyof typeof SCHEMA_ATTRIBUTES]).toEqual(attrs(def));
    }
  });

  it('match the entity/context attributes at the type level', () => {
    type Keys<T> = keyof T;
    type Listed<K extends keyof typeof SCHEMA_ATTRIBUTES> = (typeof SCHEMA_ATTRIBUTES)[K][number];
    expectTypeOf<Keys<AgentSessionAttrs>>().toEqualTypeOf<
      'tenantId' | 'persona' | 'runId' | 'sessionId' | 'egressIdentity' | 'intrusivenessCeiling'
    >();
    expectTypeOf<Keys<UserAttrs>>().toEqualTypeOf<'tenantId' | 'userId' | 'roles'>();
    expectTypeOf<Keys<ServiceAccountAttrs>>().toEqualTypeOf<'tenantId' | 'scopes' | 'saId'>();
    expectTypeOf<ServiceAccountAttrs['saId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Keys<TargetAttrs>>().toEqualTypeOf<
      'tenantId' | 'host' | 'ip' | 'port' | 'path' | 'method' | 'inScope'
    >();
    expectTypeOf<Keys<TestCaseAttrs>>().toEqualTypeOf<
      'tenantId' | 'class' | 'runId' | 'oracleType'
    >();
    expectTypeOf<Keys<RunAttrs>>().toEqualTypeOf<
      'tenantId' | 'runId' | 'saId' | 'mode' | 'state'
    >();
    expectTypeOf<Keys<AssetAttrs>>().toEqualTypeOf<'tenantId' | 'assetId' | 'verified'>();
    expectTypeOf<Keys<DecisionContext>>().toEqualTypeOf<(typeof BASE_CONTEXT_KEYS)[number]>();
    expectTypeOf<Keys<Envelope>>().toEqualTypeOf<
      'saId' | 'validFrom' | 'expiresAt' | 'maxIntrusiveness' | 'scopeHash'
    >();
    expectTypeOf<Keys<ToolInvokeContext>>().toEqualTypeOf<Keys<DecisionContext> | 'toolName'>();

    // Interfaces and runtime attribute lists come from the same generator run.
    expectTypeOf<Keys<AgentSessionAttrs>>().toEqualTypeOf<Listed<'AgentSessionAttrs'>>();
    expectTypeOf<Keys<TargetAttrs>>().toEqualTypeOf<Listed<'TargetAttrs'>>();
    expectTypeOf<Keys<DecisionContext>>().toEqualTypeOf<Listed<'DecisionContext'>>();

    expectTypeOf<TargetAttrs['port']>().toEqualTypeOf<number>();
    expectTypeOf<TargetAttrs['inScope']>().toEqualTypeOf<boolean>();
    expectTypeOf<
      ActionSignatures['Egress::Action::"httpRequest"']['context']
    >().toEqualTypeOf<DecisionContext>();
    expectTypeOf<'Egress::Action::"rawSocket"'>().not.toExtend<ActionUid>();
  });

  it('fails codegen loudly on an unparsable schema', () => {
    expect(() => renderSchemaTypes('namespace {')).toThrow(SchemaCodegenError);
  });
});

describe('intrusiveness enum parity with SCOPE-003', () => {
  it('declares exactly the SCOPE-003 classes in the SCOPE-003 order', () => {
    expect(INTRUSIVENESS_CLASS_IDS).toEqual(INTRUSIVENESS_CLASSES);
    expectTypeOf<IntrusivenessClassId>().toEqualTypeOf<IntrusivenessClass>();
  });

  it('builds values whose rank is the SCOPE-003 rank', () => {
    for (const cls of INTRUSIVENESS_CLASSES) {
      expect(intrusivenessValue(cls)).toEqual({
        level: { __entity: { type: 'Blackwing::IntrusivenessClass', id: cls } },
        rank: INTRUSIVENESS_ORDER[cls],
      });
    }
  });

  it('rejects an unknown or mis-cased class from untyped input', () => {
    expect(() => intrusivenessValue('Destructive' as IntrusivenessClass)).toThrow(
      'SCOPE_INVALID_CLASS',
    );
  });
});

describe('fail closed on a missing context attribute', () => {
  it('allows a complete, well-typed request (sanity)', () => {
    const answer = authorize({ ...httpContext() }, true);
    expect(answer.type).toBe('success');
    expect(answer).toMatchObject({ type: 'success', response: { decision: 'allow' } });
  });

  it('returns a request-validation failure (never allow) when the schema is enforced', () => {
    const answer = authorize(without(httpContext(), 'windowOpen'), true);
    expect(answer.type).toBe('failure');
  });

  it('evaluates to deny with an error when the request is not schema-checked', () => {
    const answer = authorize(without(httpContext(), 'envelope'), false);
    expect(answer).toMatchObject({
      type: 'success',
      response: {
        decision: 'deny',
        diagnostics: { errors: expect.arrayContaining([expect.anything()]) as unknown },
      },
    });
  });
});

describe('SCHEMA_VERSION', () => {
  it('is semver and matches the version line in the schema file', () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(schema).toContain(`SCHEMA_VERSION ${SCHEMA_VERSION}`);
  });

  it('is bound to the schema bytes: editing the schema requires a version bump and new digest', () => {
    expect(schemaDigest()).toBe(SCHEMA_SHA256);
    expect(schemaDigest(`${schema}\n`)).not.toBe(SCHEMA_SHA256);
  });

  it('is exposed as the pin snapshots (POLICY-007) and runs (§8.9) record', () => {
    expect(schemaPin()).toEqual({ schemaVersion: SCHEMA_VERSION, schemaSha256: SCHEMA_SHA256 });
  });
});

describe('cedarDatetime', () => {
  it.each(['2026-10-20', '2026-10-20T12:00:00+02:00', 'now', '2026-13-01T00:00:00Z'])(
    'rejects %s',
    (value) => {
      expect(() => cedarDatetime(value)).toThrow(RangeError);
    },
  );
});
