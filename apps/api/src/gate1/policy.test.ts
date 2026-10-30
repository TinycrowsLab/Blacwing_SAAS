import { describe, expect, it } from 'vitest';

import { createCedarGate1Policy, Gate1PolicyLoadError } from './policy.js';

const TENANT = '0190a5d0-1111-7111-8111-111111111111';
const OTHER_TENANT = '0190a5d0-2222-7222-8222-222222222222';
const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';

const engine = createCedarGate1Policy();

const decide = (
  over: {
    readonly id?: string;
    readonly tenantId?: string;
    readonly canApprove?: boolean;
    readonly resourceTenant?: string;
    readonly requesterId?: string | null;
  } = {},
) =>
  engine.authorize({
    principal: {
      id: over.id ?? APPROVER,
      tenantId: over.tenantId ?? TENANT,
      canApprove: over.canApprove ?? true,
    },
    resource: {
      runId: RUN,
      tenantId: over.resourceTenant ?? TENANT,
      requesterId: over.requesterId === undefined ? REQUESTER : over.requesterId,
    },
  });

describe('Gate 1 Cedar policy (#398, §8.4)', () => {
  it('allows a distinct approver in the run tenant', () => {
    expect(decide()).toBe('allow');
  });

  it('denies the requester deciding their own plan, even with the approve permission (SoD)', () => {
    expect(decide({ id: REQUESTER })).toBe('deny');
  });

  it('denies a caller without the approve permission (RBAC fact)', () => {
    expect(decide({ canApprove: false })).toBe('deny');
  });

  it('denies when the requester is unknown: nobody is proven separated, so fail closed', () => {
    expect(decide({ requesterId: null })).toBe('deny');
  });

  it('denies a principal of another tenant, and a resource of another tenant', () => {
    expect(decide({ tenantId: OTHER_TENANT })).toBe('deny');
    expect(decide({ resourceTenant: OTHER_TENANT })).toBe('deny');
  });

  it('refuses to load a policy set that does not parse (the service never starts unguarded)', () => {
    expect(() => createCedarGate1Policy('permit (principal, action, resource')).toThrow(
      Gate1PolicyLoadError,
    );
  });

  it('refuses to load a policy set with a duplicate policy id', () => {
    const policy = `@id("x") permit (principal, action, resource);\n@id("x") permit (principal, action, resource);`;
    expect(() => createCedarGate1Policy(policy)).toThrow(/duplicate policy id x/);
  });
});
