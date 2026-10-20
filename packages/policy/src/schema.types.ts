// GENERATED from schema/blackwing.cedarschema by src/codegen (POLICY-001). Do not edit by hand:
// run `pnpm --filter @blackwing/policy gen:schema-types`. A test fails when this file drifts.

/** A Cedar `datetime` extension value in the Cedar JSON format (build with `cedarDatetime`). */
export interface CedarDatetime {
  readonly __extn: { readonly fn: 'datetime'; readonly arg: string };
}

/** A Cedar entity reference in the Cedar JSON format. */
export interface CedarEntityRef<T extends string, I extends string = string> {
  readonly __entity: { readonly type: T; readonly id: I };
}

/** Members of the Cedar enum entity type `Blackwing::IntrusivenessClass`. */
export const INTRUSIVENESS_CLASS_IDS = ['passive', 'active_safe', 'state_changing', 'destructive'] as const;
export type IntrusivenessClassId = (typeof INTRUSIVENESS_CLASS_IDS)[number];

/** Cedar common type `Blackwing::DecisionContext`. */
export interface DecisionContext {
  readonly envelope: Envelope;
  readonly intrusiveness: Intrusiveness;
  readonly nowUtc: CedarDatetime;
  readonly reversalJournalPresent: boolean;
  readonly tenantId: string;
  readonly windowOpen: boolean;
}

/** Cedar common type `Blackwing::Envelope`. */
export interface Envelope {
  readonly expiresAt: CedarDatetime;
  readonly maxIntrusiveness: Intrusiveness;
  readonly saId: string;
  readonly scopeHash: string;
  readonly validFrom: CedarDatetime;
}

/** Cedar common type `Blackwing::GateDecideContext`. */
export interface GateDecideContext {
  readonly envelope: Envelope;
  readonly gate: string;
  readonly intrusiveness: Intrusiveness;
  readonly nowUtc: CedarDatetime;
  readonly requestedBy: string;
  readonly reversalJournalPresent: boolean;
  readonly tenantId: string;
  readonly windowOpen: boolean;
}

/** Cedar common type `Blackwing::Intrusiveness`. */
export interface Intrusiveness {
  readonly level: CedarEntityRef<'Blackwing::IntrusivenessClass', IntrusivenessClassId>;
  readonly rank: number;
}

/** Cedar common type `Blackwing::ToolInvokeContext`. */
export interface ToolInvokeContext {
  readonly envelope: Envelope;
  readonly intrusiveness: Intrusiveness;
  readonly nowUtc: CedarDatetime;
  readonly reversalJournalPresent: boolean;
  readonly tenantId: string;
  readonly toolName: string;
  readonly windowOpen: boolean;
}

/** Attributes of the Cedar entity type `Blackwing::AgentSession`. */
export interface AgentSessionAttrs {
  readonly egressIdentity: string;
  readonly intrusivenessCeiling: Intrusiveness;
  readonly persona: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

/** Attributes of the Cedar entity type `Blackwing::Asset`. */
export interface AssetAttrs {
  readonly assetId: string;
  readonly tenantId: string;
  readonly verified: boolean;
}

/** Attributes of the Cedar entity type `Blackwing::Run`. */
export interface RunAttrs {
  readonly mode: string;
  readonly runId: string;
  readonly saId: string;
  readonly state: string;
  readonly tenantId: string;
}

/** Attributes of the Cedar entity type `Blackwing::ServiceAccount`. */
export interface ServiceAccountAttrs {
  readonly saId?: string;
  readonly scopes: readonly string[];
  readonly tenantId: string;
}

/** Attributes of the Cedar entity type `Blackwing::Target`. */
export interface TargetAttrs {
  readonly host: string;
  readonly inScope: boolean;
  readonly ip: string;
  readonly method: string;
  readonly path: string;
  readonly port: number;
  readonly tenantId: string;
}

/** Attributes of the Cedar entity type `Blackwing::TestCase`. */
export interface TestCaseAttrs {
  readonly class: Intrusiveness;
  readonly oracleType: string;
  readonly runId: string;
  readonly tenantId: string;
}

/** Attributes of the Cedar entity type `Blackwing::User`. */
export interface UserAttrs {
  readonly roles: readonly string[];
  readonly tenantId: string;
  readonly userId: string;
}

/** Attributes of every entity type, keyed by its fully qualified Cedar name. */
export interface EntityAttrsByType {
  'Blackwing::AgentSession': AgentSessionAttrs;
  'Blackwing::Asset': AssetAttrs;
  'Blackwing::Run': RunAttrs;
  'Blackwing::ServiceAccount': ServiceAccountAttrs;
  'Blackwing::Target': TargetAttrs;
  'Blackwing::TestCase': TestCaseAttrs;
  'Blackwing::User': UserAttrs;
}

/** Fully qualified Cedar name of every (non-enum) entity type. */
export type EntityTypeName = keyof EntityAttrsByType;

/** Every action UID with the principal, resource and context types it applies to. */
export interface ActionSignatures {
  'Egress::Action::"dnsResolve"': {
    principal: 'Blackwing::AgentSession';
    resource: 'Blackwing::Target';
    context: DecisionContext;
  };
  'Egress::Action::"httpRequest"': {
    principal: 'Blackwing::AgentSession';
    resource: 'Blackwing::Target';
    context: DecisionContext;
  };
  'Egress::Action::"tcpConnect"': {
    principal: 'Blackwing::AgentSession';
    resource: 'Blackwing::Target';
    context: DecisionContext;
  };
  'Gate::Action::"decide"': {
    principal: 'Blackwing::User';
    resource: 'Blackwing::Run' | 'Blackwing::TestCase';
    context: GateDecideContext;
  };
  'Policy::Action::"edit"': {
    principal: 'Blackwing::ServiceAccount' | 'Blackwing::User';
    resource: 'Blackwing::Asset' | 'Blackwing::Run';
    context: DecisionContext;
  };
  'Scope::Action::"requestException"': {
    principal: 'Blackwing::AgentSession';
    resource: 'Blackwing::Target';
    context: DecisionContext;
  };
  'Tool::Action::"invoke"': {
    principal: 'Blackwing::AgentSession';
    resource: 'Blackwing::Target' | 'Blackwing::TestCase';
    context: ToolInvokeContext;
  };
}

/** A declared action UID, e.g. `Egress::Action::"httpRequest"`. */
export type ActionUid = keyof ActionSignatures;

/** Declared actions, in a runtime form the parity tests and the engine can iterate. */
export const ACTIONS = {
  'Egress::Action::"dnsResolve"': {
    principalTypes: ['Blackwing::AgentSession'],
    resourceTypes: ['Blackwing::Target'],
    context: 'DecisionContext',
  },
  'Egress::Action::"httpRequest"': {
    principalTypes: ['Blackwing::AgentSession'],
    resourceTypes: ['Blackwing::Target'],
    context: 'DecisionContext',
  },
  'Egress::Action::"tcpConnect"': {
    principalTypes: ['Blackwing::AgentSession'],
    resourceTypes: ['Blackwing::Target'],
    context: 'DecisionContext',
  },
  'Gate::Action::"decide"': {
    principalTypes: ['Blackwing::User'],
    resourceTypes: ['Blackwing::Run', 'Blackwing::TestCase'],
    context: 'GateDecideContext',
  },
  'Policy::Action::"edit"': {
    principalTypes: ['Blackwing::ServiceAccount', 'Blackwing::User'],
    resourceTypes: ['Blackwing::Asset', 'Blackwing::Run'],
    context: 'DecisionContext',
  },
  'Scope::Action::"requestException"': {
    principalTypes: ['Blackwing::AgentSession'],
    resourceTypes: ['Blackwing::Target'],
    context: 'DecisionContext',
  },
  'Tool::Action::"invoke"': {
    principalTypes: ['Blackwing::AgentSession'],
    resourceTypes: ['Blackwing::Target', 'Blackwing::TestCase'],
    context: 'ToolInvokeContext',
  },
} as const;

/** Attribute names of every entity type and record common type (sorted). */
export const SCHEMA_ATTRIBUTES = {
  DecisionContext: ['envelope', 'intrusiveness', 'nowUtc', 'reversalJournalPresent', 'tenantId', 'windowOpen'],
  Envelope: ['expiresAt', 'maxIntrusiveness', 'saId', 'scopeHash', 'validFrom'],
  GateDecideContext: ['envelope', 'gate', 'intrusiveness', 'nowUtc', 'requestedBy', 'reversalJournalPresent', 'tenantId', 'windowOpen'],
  Intrusiveness: ['level', 'rank'],
  ToolInvokeContext: ['envelope', 'intrusiveness', 'nowUtc', 'reversalJournalPresent', 'tenantId', 'toolName', 'windowOpen'],
  AgentSessionAttrs: ['egressIdentity', 'intrusivenessCeiling', 'persona', 'runId', 'sessionId', 'tenantId'],
  AssetAttrs: ['assetId', 'tenantId', 'verified'],
  RunAttrs: ['mode', 'runId', 'saId', 'state', 'tenantId'],
  ServiceAccountAttrs: ['saId', 'scopes', 'tenantId'],
  TargetAttrs: ['host', 'inScope', 'ip', 'method', 'path', 'port', 'tenantId'],
  TestCaseAttrs: ['class', 'oracleType', 'runId', 'tenantId'],
  UserAttrs: ['roles', 'tenantId', 'userId'],
} as const;
