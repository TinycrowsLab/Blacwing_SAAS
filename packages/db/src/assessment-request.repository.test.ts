import { describe, expect, it } from 'vitest';

import { TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { AssessmentRequestRepository } from './assessment-request.repository.js';

import type { Database } from './client.js';

/** A database that fails the test if anything reaches it: every case here must reject before SQL. */
const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be reached');
    },
  },
) as Database;

const audit = () => {
  throw new Error('the audit hook must not run before validation passes');
};

const TENANT = newId();

function repo(tenant: () => string | undefined = () => TENANT) {
  return new AssessmentRequestRepository({ db: untouchedDb, audit, tenant });
}

/** A valid `create` input; each case overrides one field. */
function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'grey',
    objective: 'Assess the checkout flow',
    assetIds: [newId()],
    maxIntrusiveness: 'active_safe',
    budgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 600_000 },
    trigger: 'console',
    requestedBy: newId(),
    ...overrides,
  };
}

describe('AssessmentRequestRepository tenant context', () => {
  it('fails closed with no ambient tenant, before any SQL', async () => {
    await expect(repo(() => undefined).create(validCreate())).rejects.toThrow(
      TenantContextMissingError,
    );
    await expect(repo(() => '').findById(newId())).rejects.toThrow(TenantContextMissingError);
    await expect(
      repo(() => undefined).transition(newId(), 0, 'submitted', newId()),
    ).rejects.toThrow(TenantContextMissingError);
  });
});

describe('AssessmentRequestRepository.create input validation', () => {
  it.each([
    ['max_intrusiveness destructive (SEC §8.3)', { maxIntrusiveness: 'destructive' }],
    ['an unknown intrusiveness', { maxIntrusiveness: 'everything' }],
    ['a mode outside black/grey/white', { mode: 'purple' }],
    ['a trigger outside the list', { trigger: 'webhook' }],
    ['an empty objective', { objective: '' }],
    ['a non-uuid asset id', { assetIds: ['not-a-uuid'] }],
    ['a non-uuid standing authorisation', { saId: 'sa_1' }],
    ['a non-uuid requester', { requestedBy: 'usr_1' }],
    ['a tenant id supplied by the caller', { tenantId: newId() }],
    ['a status supplied by the caller', { status: 'promoted' }],
    ['a state version supplied by the caller', { stateVersion: 9 }],
    ['budgets that are not an object', { budgets: 'lots' }],
    ['scope rules that are not the rule-set shape', { scopeRules: { rules: 'all' } }],
  ])('rejects %s before SQL', async (_name, overrides) => {
    await expect(repo().create(validCreate(overrides))).rejects.toThrow(ValidationError);
  });

  it('names the offending fields without echoing the values', async () => {
    const error = await repo()
      .create(validCreate({ maxIntrusiveness: 'destructive' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as ValidationError).detail)).toContain('maxIntrusiveness');
    expect(String((error as ValidationError).detail)).not.toContain('destructive');
  });
});

describe('AssessmentRequestRepository.updateDraft input validation', () => {
  it.each([
    ['a status change', { status: 'submitted' }],
    ['a requester change', { requestedBy: newId() }],
    ['a tenant change', { tenantId: newId() }],
    ['an intrusiveness of destructive', { maxIntrusiveness: 'destructive' }],
  ])('rejects %s before SQL (status only moves through transition)', async (_name, patch) => {
    await expect(repo().updateDraft(newId(), 0, patch, newId())).rejects.toThrow(ValidationError);
  });

  it('rejects a malformed id or version before SQL', async () => {
    await expect(repo().updateDraft('areq_1', 0, { objective: 'x' }, newId())).rejects.toThrow(
      ValidationError,
    );
    await expect(repo().updateDraft(newId(), -1, { objective: 'x' }, newId())).rejects.toThrow(
      ValidationError,
    );
    await expect(
      repo().updateDraft(newId(), 2_147_483_648, { objective: 'x' }, newId()),
    ).rejects.toThrow(ValidationError);
  });
});

describe('AssessmentRequestRepository.transition input validation', () => {
  it('rejects an unknown target status, a malformed id and a malformed actor before SQL', async () => {
    await expect(repo().transition(newId(), 0, 'running' as never, newId())).rejects.toThrow(
      ValidationError,
    );
    await expect(repo().transition('not-an-id', 0, 'submitted', newId())).rejects.toThrow(
      ValidationError,
    );
    await expect(repo().transition(newId(), 0, 'submitted', 'usr_1')).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('AssessmentRequestRepository.findById', () => {
  it('rejects a malformed id before SQL (no lookup by prefix or junk)', async () => {
    await expect(repo().findById('areq_xyz')).rejects.toThrow(ValidationError);
  });
});
