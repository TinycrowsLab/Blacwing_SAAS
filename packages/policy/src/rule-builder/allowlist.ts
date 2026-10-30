import { INTRUSIVENESS_ORDER } from '@blackwing/contracts';

/**
 * The closed vocabulary the rule builder may reference (POLICY-001 `schema/blackwing.cedarschema`).
 * Every name the compiler emits comes from this file, never from tenant input: an action, an entity
 * type, an attribute path or an operator that is not listed here is rejected with
 * `POLICY_BUILDER_INVALID`, so a builder rule can never inject free-form Cedar (CONTEXT_PACK §8.11).
 * `rule-builder/compile.test.ts` checks every entry against the shipped schema.
 */

/** The Cedar value kinds a builder condition may compare. */
type ValueType = 'string' | 'long' | 'bool' | 'intrusivenessLevel' | 'stringSet';

/** One allowlisted attribute. `range` bounds a `long` (inclusive) and drives the always-true warning. */
export interface AttrSpec {
  readonly type: ValueType;
  readonly range?: readonly [number, number];
}

/** An action and the entity types its `appliesTo` accepts, plus the context record it is decided on. */
export interface ActionSpec {
  readonly cedar: string;
  readonly principals: readonly PrincipalType[];
  readonly resources: readonly ResourceType[];
  readonly context: ContextKind;
}

export const PRINCIPAL_TYPES = ['AgentSession', 'User', 'ServiceAccount'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const RESOURCE_TYPES = ['Target', 'TestCase', 'Run', 'Asset'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type ContextKind = 'decision' | 'toolInvoke' | 'gateDecide' | 'scopeException';

/** Action keys as the builder JSON names them. */
export const RULE_BUILDER_ACTIONS = {
  'egress.httpRequest': {
    cedar: 'Egress::Action::"httpRequest"',
    principals: ['AgentSession'],
    resources: ['Target'],
    context: 'decision',
  },
  'egress.tcpConnect': {
    cedar: 'Egress::Action::"tcpConnect"',
    principals: ['AgentSession'],
    resources: ['Target'],
    context: 'decision',
  },
  'egress.dnsResolve': {
    cedar: 'Egress::Action::"dnsResolve"',
    principals: ['AgentSession'],
    resources: ['Target'],
    context: 'decision',
  },
  'tool.invoke': {
    cedar: 'Tool::Action::"invoke"',
    principals: ['AgentSession'],
    resources: ['Target', 'TestCase'],
    context: 'toolInvoke',
  },
  'scope.requestException': {
    cedar: 'Scope::Action::"requestException"',
    principals: ['AgentSession'],
    resources: ['Target'],
    context: 'scopeException',
  },
  'policy.edit': {
    cedar: 'Policy::Action::"edit"',
    principals: ['User', 'ServiceAccount'],
    resources: ['Asset', 'Run'],
    context: 'decision',
  },
  'gate.decide': {
    cedar: 'Gate::Action::"decide"',
    principals: ['User'],
    resources: ['Run', 'TestCase'],
    context: 'gateDecide',
  },
} as const satisfies Readonly<Record<string, ActionSpec>>;

export type ActionKey = keyof typeof RULE_BUILDER_ACTIONS;
export const ACTION_KEYS = Object.keys(RULE_BUILDER_ACTIONS) as [ActionKey, ...ActionKey[]];

const MAX_RANK = Math.max(...Object.values(INTRUSIVENESS_ORDER));
const STRING: AttrSpec = { type: 'string' };
const BOOL: AttrSpec = { type: 'bool' };
const LONG: AttrSpec = { type: 'long' };
const LEVEL: AttrSpec = { type: 'intrusivenessLevel' };
const STRING_SET: AttrSpec = { type: 'stringSet' };
const RANK: AttrSpec = { type: 'long', range: [0, MAX_RANK] };

/**
 * Attributes per entity type, keyed by the path under the entity (`intrusivenessCeiling.rank` is
 * `principal.intrusivenessCeiling.rank`). Optional attributes (`ServiceAccount.saId`) and `ip` are
 * left out: a builder condition never needs them, and `Target.ip` is never matched in Cedar.
 */
export const ENTITY_ATTRS: Readonly<
  Record<PrincipalType | ResourceType, Readonly<Record<string, AttrSpec>>>
> = {
  AgentSession: {
    tenantId: STRING,
    persona: STRING,
    runId: STRING,
    sessionId: STRING,
    egressIdentity: STRING,
    'intrusivenessCeiling.rank': RANK,
    'intrusivenessCeiling.level': LEVEL,
  },
  User: { tenantId: STRING, userId: STRING, roles: STRING_SET },
  ServiceAccount: { tenantId: STRING, scopes: STRING_SET },
  Target: {
    tenantId: STRING,
    host: STRING,
    port: LONG,
    path: STRING,
    method: STRING,
    inScope: BOOL,
  },
  TestCase: {
    tenantId: STRING,
    'class.rank': RANK,
    'class.level': LEVEL,
    runId: STRING,
    oracleType: STRING,
  },
  Run: { tenantId: STRING, runId: STRING, saId: STRING, mode: STRING, state: STRING },
  Asset: { tenantId: STRING, assetId: STRING, verified: BOOL },
};

/** The attributes every `*Context` record shares (`DecisionContext`, POLICY-001). */
const DECISION_CONTEXT: Readonly<Record<string, AttrSpec>> = {
  tenantId: STRING,
  reversalJournalPresent: BOOL,
  windowOpen: BOOL,
  isPrivateRange: BOOL,
  isMetadata: BOOL,
  saIncludesRange: BOOL,
  pinnedScopeHash: STRING,
  'envelope.saId': STRING,
  'envelope.scopeHash': STRING,
  'envelope.maxIntrusiveness.rank': RANK,
  'envelope.maxIntrusiveness.level': LEVEL,
  'intrusiveness.rank': RANK,
  'intrusiveness.level': LEVEL,
};

/** Context attributes per context record. `nowUtc` and the envelope validity window are datetimes and are not builder-comparable. */
export const CONTEXT_ATTRS: Readonly<Record<ContextKind, Readonly<Record<string, AttrSpec>>>> = {
  decision: DECISION_CONTEXT,
  toolInvoke: { ...DECISION_CONTEXT, toolName: STRING },
  gateDecide: { ...DECISION_CONTEXT, gate: STRING, requestedBy: STRING },
  scopeException: { ...DECISION_CONTEXT, requestedBy: STRING, approverId: STRING },
};

/** Attribute reference roots a condition may start with. */
export const ATTRIBUTE_ROOTS = ['principal', 'resource', 'context'] as const;
