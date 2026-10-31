import { describe, expect, it } from 'vitest';

import { runWithTenantContext } from '@blackwing/db/tenant-context';
import { createLogger } from '@blackwing/logger';

import {
  ADMIN_A,
  ASSET_OWNER,
  ASSET_VERIFIED_A,
  GRANTED_RULE,
  memoryAssessmentStore,
  memoryAssets,
  memoryHalts,
  memoryMemberships,
  memoryPreflightAudit,
  memoryStandingAuthorisations,
  NOW,
  TENANT_A,
} from './fixtures.test-helpers.js';
import { createCedarAssessmentPolicy, type AssessmentPolicyEngine } from './policy.js';
import { AssessmentRequestService } from './service.js';

import type { CreateAssessmentRequest } from '@blackwing/contracts';

/** Runs a call inside the tenant's ambient context, as the tenant guard does for a real request. */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenantId: TENANT_A, actor: { type: 'user', id: ADMIN_A } }, fn);

const principal = { tenantId: TENANT_A, actorId: ADMIN_A };
const body: CreateAssessmentRequest = {
  mode: 'grey',
  objective: 'Authenticated checks of the checkout API.',
  assetIds: [ASSET_VERIFIED_A],
  scopeRules: { rules: [GRANTED_RULE] },
  maxIntrusiveness: 'active_safe',
  trigger: 'api',
};

const noopMetrics = {
  submitted: () => undefined,
  validationFailed: () => undefined,
  preflightCheck: () => undefined,
  preflightDryRun: () => undefined,
};

/** A service over the in-memory fixtures with the given asset-level policy. */
function serviceWith(policy: AssessmentPolicyEngine) {
  const store = memoryAssessmentStore();
  const service = new AssessmentRequestService({
    store,
    assets: memoryAssets({ [TENANT_A]: { [ASSET_VERIFIED_A]: 'verified' } }),
    standingAuthorisations: memoryStandingAuthorisations({}),
    memberships: memoryMemberships({ [TENANT_A]: { [ADMIN_A]: ['appsec_engineer'] } }),
    halts: memoryHalts(new Set()),
    policy,
    metrics: noopMetrics,
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    now: () => NOW,
    preflightAudit: memoryPreflightAudit(),
  });
  return { service, store };
}

describe('AssessmentRequestService asset-level policy (SCOPE-005 requirement 6)', () => {
  it('creates a draft when the asset policy allows the caller to act on the asset', async () => {
    const { service, store } = serviceWith(createCedarAssessmentPolicy());
    const view = await inTenant(() => service.create(principal, body));
    expect(view.body.status).toBe('draft');
    expect((await inTenant(() => store.list())).length).toBe(1);
  });

  it('refuses with 403 and writes nothing when the asset policy denies, naming no asset', async () => {
    const { service, store } = serviceWith({ authorize: () => 'deny' });
    await expect(inTenant(() => service.create(principal, body))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await inTenant(() => store.list())).length).toBe(0);
  });

  it('hands the asset owner to the policy, so an owner-scoped rule can decide on it', async () => {
    const seen: string[][] = [];
    const recording: AssessmentPolicyEngine = {
      authorize: (_who, asset) => {
        seen.push([...asset.ownerUserIds]);
        return 'allow';
      },
    };
    const { service } = serviceWith(recording);
    await inTenant(() => service.create(principal, body));
    expect(seen).toEqual([[ASSET_OWNER]]);
  });

  it('keeps a withdrawal behind the same asset check: a denied caller cannot withdraw a draft', async () => {
    const allowing = serviceWith(createCedarAssessmentPolicy());
    const view = await inTenant(() => allowing.service.create(principal, body));
    const denying = new AssessmentRequestService({
      store: allowing.store,
      assets: memoryAssets({ [TENANT_A]: { [ASSET_VERIFIED_A]: 'verified' } }),
      standingAuthorisations: memoryStandingAuthorisations({}),
      memberships: memoryMemberships({ [TENANT_A]: { [ADMIN_A]: ['appsec_engineer'] } }),
      halts: memoryHalts(new Set()),
      policy: { authorize: () => 'deny' },
      metrics: {
        submitted: () => undefined,
        validationFailed: () => undefined,
        preflightCheck: () => undefined,
        preflightDryRun: () => undefined,
      },
      logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
      now: () => NOW,
      preflightAudit: memoryPreflightAudit(),
    });
    await expect(
      inTenant(() =>
        denying.withdraw(principal, view.body.id, `"v${String(view.body.stateVersion)}"`),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
