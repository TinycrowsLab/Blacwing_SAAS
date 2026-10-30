import { z } from 'zod';

/**
 * Audit action catalogue (AUDIT-001, CONTEXT_PACK §8.8).
 *
 * Every audited action has exactly one entry here. The catalogue is ADDITIVE-ONLY: new actions are
 * appended at the end and existing entries are never renamed, removed or reordered, because stored
 * events, the hash chain and the Go egress gateway refer to them by name. `audit.test.ts` pins the
 * released list, so a removal, rename or reorder fails CI.
 */

/** How loud an audit event is. Producers may raise the catalogue default for one event, never lower it. */
export const auditSeveritySchema = z.enum(['info', 'notice', 'warning', 'critical']);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

/** Rank of each severity, for "at least as severe as" comparisons. */
export const AUDIT_SEVERITY_RANK: Readonly<Record<AuditSeverity, number>> = Object.freeze({
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
});

/** The §8.8 action classes that must always write an event. */
export const AUDIT_ACTION_CLASSES = Object.freeze([
  'login',
  'approval',
  'gate_decision',
  'tool_action',
  'finding_release',
  'export',
  'kill',
  'config_change',
] as const);
export type AuditActionClass = (typeof AUDIT_ACTION_CLASSES)[number];

/** One catalogue entry. */
export interface AuditActionEntry {
  /** `<domain>.<verb>`, lowercase snake_case segments. */
  readonly action: string;
  /** Severity used when the producer does not raise it. */
  readonly defaultSeverity: AuditSeverity;
  /** True when the action can never be sampled, filtered or switched off by configuration. */
  readonly isAlwaysAudited: boolean;
  /** The §8.8 class the action belongs to, when it belongs to one. */
  readonly actionClass?: AuditActionClass;
  /** One line for the audit viewer and the docs. */
  readonly description: string;
}

/** The catalogue, grouped by domain. Append only (see the module comment). */
export const AUDIT_ACTION_CATALOGUE = Object.freeze([
  // auth: identity and sessions
  {
    action: 'auth.login',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'login',
    description: 'A user or operator signed in (outcome failure for a rejected attempt).',
  },
  {
    action: 'auth.logout',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'login',
    description: 'A session ended, by the user or by expiry.',
  },
  {
    action: 'auth.sso_link',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'login',
    description: 'An external identity provider account was linked to a user.',
  },
  {
    action: 'auth.api_token_issued',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An API or CI token was issued.',
  },
  {
    action: 'auth.api_token_revoked',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An API or CI token was revoked.',
  },
  // authz: decisions and roles
  {
    action: 'authz.denied',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    description: 'An authorisation check (RBAC/ABAC/Cedar) denied an action.',
  },
  {
    action: 'authz.role_changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A user role or membership changed.',
  },
  // asset: registration and ownership verification (§8.10)
  {
    action: 'asset.created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An asset was registered.',
  },
  {
    action: 'asset.verified',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'Asset ownership verification finished (outcome failure when it did not pass).',
  },
  // sa: standing authorisations
  {
    action: 'sa.requested',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'A standing authorisation was submitted for approval.',
  },
  {
    action: 'sa.approved',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'A standing authorisation was approved and signed.',
  },
  {
    action: 'sa.rejected',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'A standing authorisation was rejected.',
  },
  {
    action: 'sa.revoked',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'A standing authorisation was revoked.',
  },
  // gates
  {
    action: 'gate1.decided',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description: 'Gate 1 (test plan) was approved, edited or rejected.',
  },
  {
    action: 'gate2.decided',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description: 'Gate 2 (in-run escalation) was decided, including deny on timeout.',
  },
  {
    action: 'gate3.released',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description: 'Gate 3 (findings review) released a run.',
  },
  // run lifecycle
  {
    action: 'run.created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'An assessment run was requested.',
  },
  {
    action: 'run.state_changed',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A run moved between §3.3 states.',
  },
  // agent actions
  {
    action: 'tool.invoked',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'tool_action',
    description: 'An agent tool call ran (outcome denied when policy refused it).',
  },
  {
    action: 'egress.blocked',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    actionClass: 'tool_action',
    description: 'The egress gateway blocked a request (scope, budget, rebinding or fail closed).',
  },
  // kill switch (§8.5)
  {
    action: 'kill.fired',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'The kill switch fired for a run, asset, tenant or globally.',
  },
  {
    action: 'kill.completed',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'Every component confirmed the halt; metadata records the measured halt time.',
  },
  // findings and exports
  {
    action: 'finding.released',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'finding_release',
    description: 'A validated finding was released to the tenant.',
  },
  {
    action: 'finding.risk_accepted',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'approval',
    description: 'A finding was marked accepted risk.',
  },
  {
    action: 'export.generated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'export',
    description: 'A report, evidence bundle or audit export was generated.',
  },
  // secrets (§8.7): the event records the reference, never the value
  {
    action: 'secret.resolved',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A credential reference was resolved for injection (the value is never recorded).',
  },
  // configuration
  {
    action: 'config.changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A tenant or platform configuration value changed.',
  },
  {
    action: 'connector.configured',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An integration connector was added, changed or removed.',
  },
  // kill trigger API (KILL-003, F33/§8.5): appended, so the released order above is untouched
  {
    action: 'kill.triggered',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'A tenant user triggered the kill switch for a run, asset or tenant.',
  },
  {
    action: 'kill.forbidden',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'A kill request was refused by the RBAC or Cedar check (outcome denied).',
  },
  // kill propagation (KILL-004): appended, so the released order above is untouched
  {
    action: 'kill.egress_blocked',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'Kill stage 1: the egress gateway was told to block the identities of a kill.',
  },
  // kill propagation (KILL-005)
  {
    action: 'kill.sandboxes_terminated',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description:
      'Kill stage 2: the sandbox controller was told to force-terminate the sandboxes of a kill.',
  },
  // per-tenant KEK lifecycle (SECRETS-001, §8.6/§8.8): appended; the event never carries key material
  {
    action: 'secret.kek_provisioned',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A tenant Transit key (KEK) was provisioned.',
  },
  {
    action: 'secret.kek_rotated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A tenant Transit key (KEK) was rotated to a new version.',
  },
  {
    action: 'secret.kek_disabled',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    description: 'A tenant Transit key (KEK) was disabled; decrypt is blocked (crypto-shred step).',
  },
  // kill propagation (KILL-006)
  {
    action: 'kill.keys_revoked',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'Kill stage 3: the virtual model keys of a kill were revoked.',
  },
  {
    action: 'kill.workflows_cancelled',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description:
      'Kill stage 4: the Temporal workflows of a kill were cancelled and pending reversal entries flagged.',
  },
  // temporal worker interceptors (WORKFLOW-007)
  {
    action: 'activity.started',
    defaultSeverity: 'info',
    isAlwaysAudited: false,
    description:
      'A Temporal activity attempt started (metadata names the activity type; high-frequency internal types may be sampled).',
  },
  {
    action: 'activity.succeeded',
    defaultSeverity: 'info',
    isAlwaysAudited: false,
    description: 'A Temporal activity attempt succeeded.',
  },
  {
    action: 'activity.failed',
    defaultSeverity: 'warning',
    isAlwaysAudited: false,
    description:
      'A Temporal activity attempt failed or was cancelled (metadata carries the error code, never a stack).',
  },
  {
    action: 'workflow.started',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A Temporal workflow execution started.',
  },
  {
    action: 'workflow.completed',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A Temporal workflow execution completed.',
  },
  {
    action: 'workflow.failed',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    description: 'A Temporal workflow execution failed.',
  },
  {
    action: 'workflow.cancelled',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A Temporal workflow execution was cancelled.',
  },
  {
    action: 'workflow.continued_as_new',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A Temporal workflow execution continued as new.',
  },
  // SOC kill link (KILL-007, F33/§8.5): appended; the raw token is never part of an event
  {
    action: 'soc_kill.link_minted',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'A login-free SOC kill link was minted for a run or asset.',
  },
  {
    action: 'soc_kill.triggered',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'The customer SOC triggered the kill switch through a signed kill link.',
  },
  {
    action: 'soc_kill.rejected',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'A SOC kill link was refused (expired, revoked, used or tenant suspended).',
  },
  // outbox relay (WORKFLOW-012)
  {
    action: 'outbox.delivery_failed',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    description:
      'The outbox relay gave up delivering a message (retries exhausted, or its tenant is inactive); the row is marked failed and an alert is raised.',
  },
  // assessment requests (SCOPE-001)
  {
    action: 'scope.request.created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'An assessment request was created as a draft.',
  },
  {
    action: 'scope.request.status_changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'An assessment request changed status; metadata records from, to and the actor.',
  },
  // operator kill control (F33, §1.2): appended, so the released order above is untouched
  {
    action: 'operator.kill_previewed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description: 'A platform operator previewed the blast radius of a global or tenant kill.',
  },
  {
    action: 'operator.kill_fired',
    defaultSeverity: 'critical',
    isAlwaysAudited: true,
    actionClass: 'kill',
    description:
      'A platform operator fired a global or tenant kill; metadata records scope, tenant, reason and status.',
  },
  // audit query API (#86): appended, so the released order above is untouched
  {
    action: 'audit.queried',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description:
      'An auditor queried the audit ledger; metadata records the filter keys and page size, never the filter values.',
  },
  // secret rotation and KEK rewrap (SECRETS-012): metadata is ids, version numbers and counts, never values
  {
    action: 'secret.rotated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description:
      'A secret value was rotated: a new version became current and the prior one enters its grace period.',
  },
  {
    action: 'secret.rewrapped',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description:
      'A tenant KEK rewrap completed: every envelope of the tenant was re-wrapped to the newest KEK version.',
  },
  // Persona overrides (REGISTRY-010): appended; records the whitelisted fields a tenant changed, never tools or ceilings.
  {
    action: 'persona.override_changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description:
      'A tenant changed the whitelisted override of a persona (effort, turns, budget, tier).',
  },
  // per-org identity provider configuration (IAM-004, #332): metadata only, never secrets or certificates
  {
    action: 'auth.sso_config_changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description:
      'An organisation identity provider (generic OIDC or SAML) was created, updated or removed. Carries the alias, the type and the operation only.',
  },
  // tenant lifecycle: self-service signup (TENANT-004)
  {
    action: 'tenant.created',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A tenant was created when a signup was verified; the actor is the new owner.',
  },
  {
    action: 'signup.verified',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A signup e-mail address was verified with its single-use token.',
  },
  // tenant settings API: appended, so the released order above is untouched
  {
    action: 'tenant.settings_updated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description:
      'A tenant admin changed tenant settings; metadata records the changed keys, with personal values redacted.',
  },
  // platform-operator authentication (#838): appended. An operator is staff, not a tenant user, so these carry no
  // tenant context in the console and their ledger writer is the platform ledger (see the operator BFF).
  {
    action: 'auth.operator_login',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'login',
    description:
      'A platform operator completed sign-in with the operator second factor (outcome failure for a rejected attempt).',
  },
  {
    action: 'auth.operator_logout',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'login',
    description: 'A platform operator session ended, by the operator or by expiry.',
  },
  {
    action: 'auth.operator_session_revoked',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'login',
    description:
      'A platform operator session was revoked server-side (refresh refused, identity changed or offboarding).',
  },
  // standing authorisation lifecycle (AUTHZ-001, §8.1, §8.8): appended; the event carries ids and states only
  {
    action: 'authz.sa.created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A standing authorisation was created in the draft state.',
  },
  {
    action: 'authz.sa.state_changed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A standing authorisation changed state (from, to and the acting principal).',
  },
  // standing-authorisation signing (AUTHZ-004, #376): appended; the event carries the key id and the
  // envelope hash, never key material or the signature itself.
  {
    action: 'authz.sa.signed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A standing authorisation envelope was signed with a Transit signing key version.',
  },
  {
    action: 'authz.signing_key.rotated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'The standing-authorisation signing key was rotated to a new Transit version.',
  },
  // gate decisions (AUTHZ-005, §8.4, §8.8): one event per recorded Gate 1/2/3 or SA decision; ids only
  {
    action: 'authz.gate.decision',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description: 'A gate decision (approved, rejected, deferred or auto-approved) was recorded.',
  },
  {
    action: 'authz.sa.updated',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A draft standing authorisation was changed (the changed field names only).',
  },
  {
    action: 'authz.sa.submitted',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A standing authorisation was submitted for approval (draft to pending_approval).',
  },
  // surface graph read (GRAPH-006 console view, #444): appended; the event names the run, never the graph content.
  {
    action: 'run.surface.viewed',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A caller read the surface graph of a run through the console endpoint.',
  },
  // assessment request draft, submit and withdraw (SCOPE-005): appended, so the released order above is untouched
  {
    action: 'scope.request.updated',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description:
      'An assessment request draft was edited; metadata records the request and the actor.',
  },
  {
    action: 'scope.request.submitted',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description:
      'An assessment request was submitted and bound to a standing authorisation; metadata records the SA and the assets.',
  },
  {
    action: 'scope.request.withdrawn',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'An assessment request was withdrawn by its requester.',
  },
  // test plans (PLAN-005, #395): appended; metadata carries ids, versions and the changed field names only
  {
    action: 'test_plan.version_created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description:
      'A new numbered test plan version was created for a run (PLAN-005, metadata carries the version).',
  },
  {
    action: 'test_case.created',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A test case was added to a draft test plan version (PLAN-005).',
  },
  {
    action: 'test_case.updated',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description: 'A test case of a draft test plan version was edited (PLAN-005).',
  },
  {
    action: 'test_case.removed',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    description: 'A test case was soft-removed from a draft test plan version (PLAN-005).',
  },
  // asset lifecycle after registration (ASSET-002, #355). Appended: the catalogue is additive-only.
  {
    action: 'asset.updated',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An asset was changed. The event names the changed fields, never their values.',
  },
  {
    action: 'asset.deleted',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An asset was soft-deleted. Its row and history are retained.',
  },
  {
    action: 'asset.owner_assigned',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'An asset owner was assigned or changed.',
  },
  // plan validation (PLAN-006, #396): appended; metadata carries ids, the violation count and the SA id only
  {
    action: 'test_plan.validated',
    defaultSeverity: 'info',
    isAlwaysAudited: true,
    description:
      'A test plan version was validated against its standing authorisation, policy and budgets (PLAN-006).',
  },
  // on-call roster (GATE2-003, F13/F31): appended; metadata carries user references only, no PII
  {
    action: 'oncall.roster.updated',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'config_change',
    description: 'A Gate 2 on-call roster was created or changed (members, ladder, schedule).',
  },
  {
    action: 'oncall.sod_skipped',
    defaultSeverity: 'warning',
    isAlwaysAudited: true,
    description:
      'An escalation level was skipped because every member was separation-of-duties ineligible.',
  },
  // Gate 2 exceptions (GATE2-001, F13): appended, so the released order above is untouched
  {
    action: 'gate2.exception.created',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description:
      'A tool call fell outside the approved envelope and a Gate 2 exception was opened (pending, default deny).',
  },
  {
    action: 'gate2.decision.recorded',
    defaultSeverity: 'notice',
    isAlwaysAudited: true,
    actionClass: 'gate_decision',
    description:
      'A Gate 2 exception reached a terminal state: approved once, denied, timed out (denied) or superseded (denied).',
  },
] as const satisfies readonly AuditActionEntry[]);

/** Every audited action name. */
export type AuditAction = (typeof AUDIT_ACTION_CATALOGUE)[number]['action'];

const [firstAction, ...otherActions] = AUDIT_ACTION_CATALOGUE.map(
  (entry): AuditAction => entry.action,
);
if (firstAction === undefined) {
  throw new Error('the audit action catalogue is empty');
}

/** Every audited action name, in catalogue order. */
export const AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([firstAction, ...otherActions]);

/** The `action` field: unknown or future actions are rejected at the schema boundary. */
export const auditActionSchema = z.enum([firstAction, ...otherActions]);

const BY_ACTION: ReadonlyMap<AuditAction, AuditActionEntry> = new Map(
  AUDIT_ACTION_CATALOGUE.map((entry): [AuditAction, AuditActionEntry] => [entry.action, entry]),
);

/** Catalogue metadata for an action. Throws for a name outside the catalogue. */
export function auditActionEntry(action: AuditAction): AuditActionEntry {
  const entry = BY_ACTION.get(action);
  if (entry === undefined) {
    throw new Error(`unknown audit action: ${action}`);
  }
  return entry;
}
