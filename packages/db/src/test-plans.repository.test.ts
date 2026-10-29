import { describe, expect, it } from 'vitest';

import { MAX_PLAN_TEST_CASES } from '@blackwing/contracts';
import { TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { TestPlanRepository } from './test-plans.repository.js';

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

const TENANT = newId();

function repo(tenant: () => string | undefined = () => TENANT) {
  return new TestPlanRepository({ db: untouchedDb, tenant, audit: () => undefined });
}

/** A valid planned test case; each case overrides one field. */
function plannedCase(overrides: Record<string, unknown> = {}) {
  return {
    class: 'active_safe',
    title: 'Reflected parameter in search',
    refs: { owasp: ['A03:2021'], wstg: ['WSTG-INPV-01'], asvs: ['5.3.3'] },
    cweCandidates: ['CWE-79'],
    targets: ['https://app.example.test/search'],
    roles: ['anonymous'],
    budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 1_000_000 },
    oracle: { type: 'response.contains', params: { needle: 'probe-token' } },
    negativeControl: null,
    ...overrides,
  };
}

function validCreate(overrides: Record<string, unknown> = {}) {
  return { runId: newId(), createdBy: newId(), cases: [plannedCase()], ...overrides };
}

describe('TestPlanRepository.createVersion input checks (no SQL reached)', () => {
  it('refuses a destructive case before any transaction starts (§8.3)', async () => {
    const attempt = repo().createVersion(
      validCreate({ cases: [plannedCase({ class: 'destructive' })] }),
    );
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      detail: 'A destructive test case cannot be planned (CONTEXT_PACK §8.3).',
    });
  });

  it('refuses a destructive case even mixed in with valid ones', async () => {
    const attempt = repo().createVersion(
      validCreate({ cases: [plannedCase(), plannedCase({ class: 'destructive' })] }),
    );
    await expect(attempt).rejects.toThrow(ValidationError);
  });

  it('refuses a plan above the per-plan case cap', async () => {
    const cases = Array.from({ length: MAX_PLAN_TEST_CASES + 1 }, () => plannedCase());
    await expect(repo().createVersion(validCreate({ cases }))).rejects.toThrow(ValidationError);
  });

  it('refuses an unknown class, a bad oracle key or an unknown field, naming fields only', async () => {
    await expect(
      repo().createVersion(validCreate({ cases: [plannedCase({ class: 'rm-rf' })] })),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo().createVersion(
        validCreate({ cases: [plannedCase({ oracle: { type: 'Bad Key!', params: {} } })] }),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo().createVersion(validCreate({ cases: [plannedCase({ extra: 'x' })] })),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a non-uuid run id and an unknown top-level field', async () => {
    await expect(repo().createVersion(validCreate({ runId: 'run_1' }))).rejects.toThrow(
      ValidationError,
    );
    await expect(repo().createVersion(validCreate({ tenantId: newId() }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('fails closed without a tenant context, before any SQL', async () => {
    await expect(repo(() => undefined).createVersion(validCreate())).rejects.toThrow(
      TenantContextMissingError,
    );
    await expect(repo(() => '').createVersion(validCreate())).rejects.toThrow(
      TenantContextMissingError,
    );
  });
});

describe('TestPlanRepository read input checks', () => {
  it('rejects a malformed plan id and a malformed run id before SQL', async () => {
    await expect(repo().findById('not-a-uuid')).rejects.toThrow(ValidationError);
    await expect(repo().listForRun('not-a-uuid')).rejects.toThrow(ValidationError);
  });

  it('fails closed on reads without a tenant context', async () => {
    await expect(repo(() => undefined).findById(newId())).rejects.toThrow(
      TenantContextMissingError,
    );
    await expect(repo(() => undefined).listForRun(newId())).rejects.toThrow(
      TenantContextMissingError,
    );
  });
});
