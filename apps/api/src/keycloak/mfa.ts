import { z } from 'zod';

import { AppError, ValidationError } from '@blackwing/errors';

import type { KeycloakAdminClient } from './admin-client.js';
import type { Logger } from '@blackwing/logger';

/**
 * MFA for local (non-SSO) accounts (IAM-005, #338). OFFLINE-STUB(online-porting #903): the enrolment audit, the
 * enrolment and challenge metrics and the admin-reset client wiring need a live Keycloak; see the issue. The second factor lives in Keycloak (TOTP and WebAuthn, see
 * `infra/keycloak/realm-blackwing.json`). This module holds the rules around it: the per-organisation policy
 * (stored as organisation attributes), the requirement a login must meet, and the privileged admin reset.
 */

const MFA_FACTORS = ['totp', 'webauthn'] as const;
export type MfaFactor = (typeof MFA_FACTORS)[number];

/** Keycloak required action that forces enrolment. TOTP is the baseline every policy keeps (see the schema). */
export const ENROLMENT_REQUIRED_ACTION = 'CONFIGURE_TOTP';

/** Realm roles whose accounts always require MFA. The organisation policy cannot switch that off. */
const PRIVILEGED_ROLES: readonly string[] = ['org-admin', 'platform-operator'];

/** The acr a completed second factor asserts. IAM-009 step-up requires it (realm `acr.loa.map` strong=2). */
const STRONG_ACR = 'strong';

/** Organisation attribute keys that hold the policy. */
const MFA_POLICY_ATTRIBUTES = {
  required: 'bw.mfaRequired',
  factors: 'bw.mfaFactors',
} as const;

/** Keycloak credential types that count as a factor, mapped to the factor they provide. */
const FACTOR_CREDENTIAL_TYPES: Readonly<Record<string, MfaFactor>> = {
  otp: 'totp',
  webauthn: 'webauthn',
  'webauthn-passwordless': 'webauthn',
};
/** Recovery codes are removed with the factors on an admin reset; they are not a factor on their own. */
const RECOVERY_CREDENTIAL_TYPE = 'recovery-authn-codes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const policySchema = z
  .strictObject({
    mfaRequired: z.boolean(),
    allowedFactors: z.array(z.enum(MFA_FACTORS)).min(1).max(MFA_FACTORS.length),
  })
  .superRefine((policy, ctx) => {
    if (new Set(policy.allowedFactors).size !== policy.allowedFactors.length)
      ctx.addIssue({
        code: 'custom',
        path: ['allowedFactors'],
        message: 'must not repeat a factor',
      });
    if (!policy.allowedFactors.includes('totp'))
      ctx.addIssue({
        code: 'custom',
        path: ['allowedFactors'],
        message: 'must include totp, the fallback when WebAuthn is unsupported',
      });
  });
export type MfaPolicy = z.output<typeof policySchema>;

/** Used when an organisation has never set a policy: MFA is optional, privileged roles still require it. */
export const DEFAULT_MFA_POLICY: MfaPolicy = {
  mfaRequired: false,
  allowedFactors: ['totp', 'webauthn'],
};

export interface MfaRequirement {
  /** True when the policy or a privileged role requires a second factor. */
  readonly mfaRequired: boolean;
  /** True when a factor is required and the user has none the policy allows: they must enrol before access. */
  readonly enrolmentRequired: boolean;
  /** Keycloak required actions to set on the user while enrolment is outstanding. */
  readonly requiredActions: readonly (typeof ENROLMENT_REQUIRED_ACTION)[];
  readonly allowedFactors: readonly MfaFactor[];
}

/**
 * The MFA requirement for one account. Pure and deterministic: it decides enrolment, never the second factor
 * itself (Keycloak checks that at login).
 */
export function evaluateMfaRequirement(input: {
  readonly policy: MfaPolicy;
  readonly roles: readonly string[];
  readonly enrolledFactors: readonly MfaFactor[];
}): MfaRequirement {
  const privileged = input.roles.some((role) => PRIVILEGED_ROLES.includes(role));
  const mfaRequired = privileged || input.policy.mfaRequired;
  const usable = input.enrolledFactors.some((f) => input.policy.allowedFactors.includes(f));
  const enrolmentRequired = mfaRequired && !usable;
  return {
    mfaRequired,
    enrolmentRequired,
    requiredActions: enrolmentRequired ? [ENROLMENT_REQUIRED_ACTION] : [],
    allowedFactors: input.policy.allowedFactors,
  };
}

/**
 * The policy stored on an organisation. Absent attributes mean the default. Present but malformed attributes
 * throw: an unreadable policy must never silently relax MFA.
 */
export function policyFromAttributes(
  attributes: Record<string, readonly string[]> | undefined,
): MfaPolicy {
  const required = attributes?.[MFA_POLICY_ATTRIBUTES.required];
  const factors = attributes?.[MFA_POLICY_ATTRIBUTES.factors];
  if (required === undefined && factors === undefined) return DEFAULT_MFA_POLICY;
  const flag = required?.length === 1 ? required[0] : undefined;
  const parsed = policySchema.safeParse({
    mfaRequired: flag === 'true',
    allowedFactors: factors?.length === 1 ? (factors[0] ?? '').split(',') : [],
  });
  if (flag !== 'true' && flag !== 'false') throw malformedPolicy();
  if (!parsed.success || factors?.length !== 1) throw malformedPolicy();
  return parsed.data;
}

const malformedPolicy = (): AppError =>
  new AppError('KEYCLOAK_REJECTED', 'The stored MFA policy is malformed', {
    detail: 'The organisation MFA attributes could not be read; set the policy again.',
  });

/** Organisation attributes for a policy (the inverse of {@link policyFromAttributes}). */
export function attributesFromPolicy(policy: MfaPolicy): Record<string, string[]> {
  return {
    [MFA_POLICY_ATTRIBUTES.required]: [String(policy.mfaRequired)],
    [MFA_POLICY_ATTRIBUTES.factors]: [policy.allowedFactors.join(',')],
  };
}

/** One audit record per mutating MFA call, including no-ops (the ledger sits behind this port, IAM-012). */
export interface MfaAuditEvent {
  readonly action: 'auth.mfa_policy_update' | 'auth.mfa_reset' | 'auth.mfa_enrolled';
  readonly outcome: 'applied' | 'unchanged';
  readonly actorUserId: string;
  readonly orgId?: string;
  readonly targetUserId?: string;
  readonly removedFactors?: readonly MfaFactor[];
}

interface MfaAuditSink {
  /** A rejection propagates: the change is already applied, and a retry appends the record. */
  record(event: MfaAuditEvent): Promise<void>;
}

export interface MfaServiceDeps {
  readonly client: KeycloakAdminClient;
  readonly audit: MfaAuditSink;
  readonly logger: Logger;
}

export interface MfaActor {
  readonly userId: string;
  /** The acr of the actor's current session. */
  readonly acr: string;
}

export interface ResetFactorsResult {
  readonly removedFactors: readonly MfaFactor[];
  readonly changed: boolean;
}

const credentialsSchema = z.array(z.looseObject({ id: z.string().min(1), type: z.string() }));
const organizationSchema = z.looseObject({
  id: z.string(),
  attributes: z.record(z.string(), z.array(z.string())).optional(),
});

const uuid = (value: string, what: string): string => {
  if (!UUID.test(value))
    throw new ValidationError('Invalid MFA request', { detail: `${what} must be a UUID` });
  return value;
};

const rejected = (what: string): AppError =>
  new AppError('KEYCLOAK_REJECTED', `Keycloak returned an unexpected response for ${what}`, {
    detail: 'The identity provider rejected the admin request.',
  });

const notFound = (what: string): AppError =>
  new AppError('KEYCLOAK_NOT_FOUND', `Keycloak has no ${what}`, {
    detail: 'The identity-provider resource was not found.',
  });

/** True when the stored attributes already hold this policy. A malformed stored policy never matches. */
function sameAsStored(
  attributes: Record<string, readonly string[]> | undefined,
  policy: MfaPolicy,
): boolean {
  try {
    const stored = policyFromAttributes(attributes);
    return (
      stored.mfaRequired === policy.mfaRequired &&
      stored.allowedFactors.join(',') === policy.allowedFactors.join(',')
    );
  } catch {
    return false;
  }
}

export class MfaService {
  private readonly deps: MfaServiceDeps;

  constructor(deps: MfaServiceDeps) {
    this.deps = deps;
  }

  /** The organisation's MFA policy. Reads never write. */
  async getPolicy(orgId: string): Promise<MfaPolicy> {
    const id = uuid(orgId, 'orgId');
    const org = await this.organization(id);
    return policyFromAttributes(org.attributes);
  }

  /**
   * Replaces the organisation's MFA policy. Re-applying the stored policy is a no-op (no write), and every call
   * is audited.
   */
  async setPolicy(input: {
    actorUserId: string;
    orgId: string;
    policy: unknown;
  }): Promise<MfaPolicy> {
    const id = uuid(input.orgId, 'orgId');
    const parsed = policySchema.safeParse(input.policy);
    if (!parsed.success)
      throw new ValidationError('Invalid MFA policy', {
        detail: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'policy'} ${i.message}`)
          .join('; '),
      });
    const policy = parsed.data;
    const current = await this.organization(id);
    const unchanged = sameAsStored(current.attributes, policy);
    if (!unchanged) {
      const result = await this.deps.client.request('update', 'PUT', `organizations/${id}`, {
        ...current,
        attributes: { ...current.attributes, ...attributesFromPolicy(policy) },
      });
      if (result.kind === 'not_found') throw notFound('organisation to update');
      if (result.kind === 'conflict') throw rejected('the MFA policy update');
    }
    await this.deps.audit.record({
      action: 'auth.mfa_policy_update',
      outcome: unchanged ? 'unchanged' : 'applied',
      actorUserId: input.actorUserId,
      orgId: id,
    });
    this.deps.logger.info(
      { orgId: id, mfaRequired: policy.mfaRequired, unchanged },
      'mfa policy set',
    );
    return policy;
  }

  /**
   * Admin reset of a user's second factors (lost device). It needs the actor's session at the strong acr (step-up),
   * refuses self-service resets, and removes every factor and recovery code the user holds. Audited.
   */
  async resetFactors(input: {
    actor: MfaActor;
    targetUserId: string;
  }): Promise<ResetFactorsResult> {
    const targetUserId = uuid(input.targetUserId, 'targetUserId');
    if (input.actor.acr !== STRONG_ACR)
      throw new AppError('FORBIDDEN', 'Step-up authentication is required to reset MFA', {
        detail: 'Sign in again with a second factor, then retry the reset.',
      });
    if (input.actor.userId === targetUserId)
      throw new AppError('FORBIDDEN', 'An account cannot reset its own MFA', {
        detail: 'Ask another administrator to reset it.',
      });
    const credentials = await this.credentials(targetUserId);
    const removed = new Set<MfaFactor>();
    for (const cred of credentials) {
      if (
        cred.type !== RECOVERY_CREDENTIAL_TYPE &&
        FACTOR_CREDENTIAL_TYPES[cred.type] === undefined
      )
        continue;
      const result = await this.deps.client.request(
        'delete',
        'DELETE',
        `users/${targetUserId}/credentials/${encodeURIComponent(cred.id)}`,
      );
      if (result.kind === 'not_found') continue;
      if (result.kind === 'conflict') throw rejected('the credential reset');
      const factor = FACTOR_CREDENTIAL_TYPES[cred.type];
      if (factor !== undefined) removed.add(factor);
    }
    const removedFactors = [...removed].sort();
    await this.deps.audit.record({
      action: 'auth.mfa_reset',
      outcome: removedFactors.length > 0 ? 'applied' : 'unchanged',
      actorUserId: input.actor.userId,
      targetUserId,
      removedFactors,
    });
    this.deps.logger.info({ targetUserId, removed: removedFactors }, 'mfa factors reset');
    return { removedFactors, changed: removedFactors.length > 0 };
  }

  private async organization(id: string): Promise<z.output<typeof organizationSchema>> {
    const result = await this.deps.client.request('get', 'GET', `organizations/${id}`);
    if (result.kind === 'not_found') throw notFound('organisation');
    if (result.kind !== 'ok') throw rejected('the organisation read');
    const parsed = organizationSchema.safeParse(result.body);
    if (!parsed.success) throw rejected('the organisation read');
    return parsed.data;
  }

  private async credentials(userId: string): Promise<z.output<typeof credentialsSchema>> {
    const result = await this.deps.client.request('list', 'GET', `users/${userId}/credentials`);
    if (result.kind === 'not_found') throw notFound('user');
    if (result.kind !== 'ok') throw rejected('the credential read');
    const parsed = credentialsSchema.safeParse(result.body);
    if (!parsed.success) throw rejected('the credential read');
    return parsed.data;
  }
}
