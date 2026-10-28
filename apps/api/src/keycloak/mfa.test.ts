import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import {
  attributesFromPolicy,
  DEFAULT_MFA_POLICY,
  ENROLMENT_REQUIRED_ACTION,
  evaluateMfaRequirement,
  type MfaAuditEvent,
  type MfaPolicy,
  MfaService,
  policyFromAttributes,
  policySchema,
} from './mfa.js';

import type { KeycloakAdminClient } from './admin-client.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const USER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ADMIN = '00000000-0000-4000-8000-0000000000aa';

type Result = Awaited<ReturnType<KeycloakAdminClient['request']>>;
interface Call {
  readonly op: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A fake Keycloak admin API: one organisation and one user's credentials, with every call recorded. */
function fakeClient(init: {
  org?: Record<string, unknown>;
  credentials?: { id: string; type: string }[];
}) {
  const calls: Call[] = [];
  const state = {
    org: init.org ?? { id: ORG, name: 'acme' },
    credentials: [...(init.credentials ?? [])],
  };
  const client: KeycloakAdminClient = {
    request(op, method, path, body): Promise<Result> {
      calls.push({ op, method, path, body });
      if (path === `organizations/${ORG}` && method === 'GET')
        return Promise.resolve({ kind: 'ok', body: state.org, location: undefined });
      if (path === `organizations/${ORG}` && method === 'PUT') {
        state.org = body as Record<string, unknown>;
        return Promise.resolve({ kind: 'ok', body: null, location: undefined });
      }
      if (path === `users/${USER}/credentials` && method === 'GET')
        return Promise.resolve({ kind: 'ok', body: state.credentials, location: undefined });
      const del = /^users\/[^/]+\/credentials\/([^/]+)$/.exec(path);
      if (del && method === 'DELETE') {
        const id = decodeURIComponent(String(del[1]));
        const before = state.credentials.length;
        state.credentials = state.credentials.filter((c) => c.id !== id);
        return Promise.resolve(
          before === state.credentials.length
            ? { kind: 'not_found' }
            : { kind: 'ok', body: null, location: undefined },
        );
      }
      return Promise.resolve({ kind: 'not_found' });
    },
  };
  return { client, calls, state };
}

function harness(init: Parameters<typeof fakeClient>[0] = {}) {
  const { client, calls, state } = fakeClient(init);
  const audit: MfaAuditEvent[] = [];
  const logger = createLogger('mfa-test', { level: 'silent', nodeEnv: 'test' });
  const service = new MfaService({
    client,
    audit: { record: (event) => Promise.resolve(void audit.push(event)) },
    logger,
  });
  return { service, calls, state, audit };
}

const REQUIRED: MfaPolicy = { mfaRequired: true, allowedFactors: ['totp', 'webauthn'] };

describe('policySchema', () => {
  it('accepts a policy that keeps TOTP as the fallback', () => {
    expect(policySchema.parse({ mfaRequired: true, allowedFactors: ['webauthn', 'totp'] })).toEqual(
      {
        mfaRequired: true,
        allowedFactors: ['webauthn', 'totp'],
      },
    );
  });

  it('rejects an empty, repeated, unknown or WebAuthn-only factor set and unknown fields', () => {
    expect(policySchema.safeParse({ mfaRequired: true, allowedFactors: [] }).success).toBe(false);
    expect(
      policySchema.safeParse({ mfaRequired: true, allowedFactors: ['totp', 'totp'] }).success,
    ).toBe(false);
    expect(policySchema.safeParse({ mfaRequired: true, allowedFactors: ['sms'] }).success).toBe(
      false,
    );
    expect(
      policySchema.safeParse({ mfaRequired: true, allowedFactors: ['webauthn'] }).success,
    ).toBe(false);
    expect(policySchema.safeParse({ mfaRequired: 'yes', allowedFactors: ['totp'] }).success).toBe(
      false,
    );
    expect(
      policySchema.safeParse({ mfaRequired: true, allowedFactors: ['totp'], extra: 1 }).success,
    ).toBe(false);
  });
});

describe('evaluateMfaRequirement', () => {
  it('does not require MFA for an ordinary account under an optional policy', () => {
    const r = evaluateMfaRequirement({
      policy: DEFAULT_MFA_POLICY,
      roles: ['developer'],
      enrolledFactors: [],
    });
    expect(r).toEqual({
      mfaRequired: false,
      enrolmentRequired: false,
      requiredActions: [],
      allowedFactors: ['totp', 'webauthn'],
    });
  });

  it('forces enrolment of a local user with no second factor under a required policy', () => {
    const r = evaluateMfaRequirement({
      policy: REQUIRED,
      roles: ['developer'],
      enrolledFactors: [],
    });
    expect(r.enrolmentRequired).toBe(true);
    expect(r.requiredActions).toEqual([ENROLMENT_REQUIRED_ACTION]);
  });

  it('is satisfied by either an enrolled TOTP or an enrolled WebAuthn key', () => {
    for (const factor of ['totp', 'webauthn'] as const) {
      const r = evaluateMfaRequirement({
        policy: REQUIRED,
        roles: ['developer'],
        enrolledFactors: [factor],
      });
      expect(r.mfaRequired).toBe(true);
      expect(r.enrolmentRequired).toBe(false);
      expect(r.requiredActions).toEqual([]);
    }
  });

  it('requires enrolment again when the only factor the user holds is no longer allowed', () => {
    const totpOnly: MfaPolicy = { mfaRequired: true, allowedFactors: ['totp'] };
    const r = evaluateMfaRequirement({
      policy: totpOnly,
      roles: [],
      enrolledFactors: ['webauthn'],
    });
    expect(r.enrolmentRequired).toBe(true);
  });

  it('keeps MFA required for org-admin and platform-operator even when the policy is optional', () => {
    for (const role of ['org-admin', 'platform-operator']) {
      const r = evaluateMfaRequirement({
        policy: DEFAULT_MFA_POLICY,
        roles: [role],
        enrolledFactors: [],
      });
      expect(r.mfaRequired).toBe(true);
      expect(r.enrolmentRequired).toBe(true);
    }
  });
});

describe('policy attributes', () => {
  it('reads the default when the organisation has never set a policy', () => {
    expect(policyFromAttributes(undefined)).toEqual(DEFAULT_MFA_POLICY);
    expect(policyFromAttributes({ displayName: ['Acme'] })).toEqual(DEFAULT_MFA_POLICY);
  });

  it('round-trips a stored policy', () => {
    const attrs = attributesFromPolicy(REQUIRED);
    expect(attrs).toEqual({ 'bw.mfaRequired': ['true'], 'bw.mfaFactors': ['totp,webauthn'] });
    expect(policyFromAttributes(attrs)).toEqual(REQUIRED);
  });

  it('throws on malformed stored attributes instead of relaxing MFA', () => {
    const malformed: Record<string, string[]>[] = [
      { 'bw.mfaRequired': ['yes'], 'bw.mfaFactors': ['totp'] },
      { 'bw.mfaRequired': ['true', 'false'], 'bw.mfaFactors': ['totp'] },
      { 'bw.mfaRequired': ['true'] },
      { 'bw.mfaFactors': ['totp'] },
      { 'bw.mfaRequired': ['true'], 'bw.mfaFactors': ['webauthn'] },
      { 'bw.mfaRequired': ['true'], 'bw.mfaFactors': ['totp', 'webauthn'] },
    ];
    for (const attrs of malformed) expect(() => policyFromAttributes(attrs)).toThrow(AppError);
  });
});

describe('MfaService.getPolicy', () => {
  it('returns the stored policy and never writes', async () => {
    const h = harness({
      org: { id: ORG, name: 'acme', attributes: attributesFromPolicy(REQUIRED) },
    });
    expect(await h.service.getPolicy(ORG)).toEqual(REQUIRED);
    expect(h.calls.map((c) => c.method)).toEqual(['GET']);
    expect(h.audit).toEqual([]);
  });

  it('rejects a malformed orgId before any Keycloak call', async () => {
    const h = harness();
    await expect(h.service.getPolicy('../users')).rejects.toBeInstanceOf(ValidationError);
    expect(h.calls).toEqual([]);
  });
});

describe('MfaService.setPolicy', () => {
  it('stores the policy as organisation attributes and records an applied audit event', async () => {
    const h = harness();
    const result = await h.service.setPolicy({ actorUserId: ADMIN, orgId: ORG, policy: REQUIRED });
    expect(result).toEqual(REQUIRED);
    const stored = h.state.org as { attributes: Record<string, string[]>; name: string };
    expect(stored.name).toBe('acme');
    expect(stored.attributes['bw.mfaRequired']).toEqual(['true']);
    expect(stored.attributes['bw.mfaFactors']).toEqual(['totp,webauthn']);
    expect(h.audit).toEqual([
      { action: 'auth.mfa_policy_update', outcome: 'applied', actorUserId: ADMIN, orgId: ORG },
    ]);
  });

  it('is a no-op when the stored policy already matches (no PUT, audited as unchanged)', async () => {
    const h = harness({
      org: { id: ORG, name: 'acme', attributes: attributesFromPolicy(REQUIRED) },
    });
    await h.service.setPolicy({ actorUserId: ADMIN, orgId: ORG, policy: REQUIRED });
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(h.audit[0]?.outcome).toBe('unchanged');
  });

  it('overwrites a malformed stored policy rather than failing closed forever', async () => {
    const h = harness({
      org: { id: ORG, name: 'acme', attributes: { 'bw.mfaRequired': ['maybe'] } },
    });
    await h.service.setPolicy({ actorUserId: ADMIN, orgId: ORG, policy: REQUIRED });
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(h.audit[0]?.outcome).toBe('applied');
  });

  it('rejects a policy without TOTP and never calls Keycloak', async () => {
    const h = harness();
    await expect(
      h.service.setPolicy({
        actorUserId: ADMIN,
        orgId: ORG,
        policy: { mfaRequired: true, allowedFactors: ['webauthn'] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(h.calls).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('rejects an unknown field in the policy body', async () => {
    const h = harness();
    await expect(
      h.service.setPolicy({
        actorUserId: ADMIN,
        orgId: ORG,
        policy: { ...REQUIRED, optional: true },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(h.calls).toEqual([]);
  });
});

describe('MfaService.resetFactors', () => {
  const creds = [
    { id: 'c1', type: 'otp' },
    { id: 'c2', type: 'webauthn' },
    { id: 'c3', type: 'password' },
    { id: 'c4', type: 'recovery-authn-codes' },
  ];
  const strong = { userId: ADMIN, acr: 'strong' };

  it('refuses without a strong session (step-up) and makes no change', async () => {
    const h = harness({ credentials: creds });
    await expect(
      h.service.resetFactors({ actor: { userId: ADMIN, acr: '1' }, targetUserId: USER }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(h.audit).toEqual([]);
  });

  it('refuses a self-service reset even with a strong session', async () => {
    const h = harness({ credentials: creds });
    await expect(
      h.service.resetFactors({ actor: strong, targetUserId: ADMIN }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('removes the factors and recovery codes but keeps the password, and audits the removed factors', async () => {
    const h = harness({ credentials: creds });
    const result = await h.service.resetFactors({ actor: strong, targetUserId: USER });
    expect(result).toEqual({ removedFactors: ['totp', 'webauthn'], changed: true });
    expect(h.state.credentials).toEqual([{ id: 'c3', type: 'password' }]);
    expect(h.audit).toEqual([
      {
        action: 'auth.mfa_reset',
        outcome: 'applied',
        actorUserId: ADMIN,
        targetUserId: USER,
        removedFactors: ['totp', 'webauthn'],
      },
    ]);
  });

  it('is idempotent: a second reset removes nothing and audits unchanged', async () => {
    const h = harness({ credentials: creds });
    await h.service.resetFactors({ actor: strong, targetUserId: USER });
    const again = await h.service.resetFactors({ actor: strong, targetUserId: USER });
    expect(again).toEqual({ removedFactors: [], changed: false });
    expect(h.audit.at(-1)?.outcome).toBe('unchanged');
  });

  it('rejects a malformed target id before any Keycloak call', async () => {
    const h = harness({ credentials: creds });
    await expect(
      h.service.resetFactors({ actor: strong, targetUserId: `${USER}/../../clients` }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(h.calls).toEqual([]);
  });
});
