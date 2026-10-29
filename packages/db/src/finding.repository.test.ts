import { describe, expect, it } from 'vitest';

import { TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { FindingRepository } from './finding.repository.js';

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
const FINGERPRINT = 'a'.repeat(64);

function repo(tenant: () => string | undefined = () => TENANT) {
  return new FindingRepository({ db: untouchedDb, tenant });
}

/** A valid `create` input; each case overrides or removes one field. */
function validCreate(overrides: Record<string, unknown> = {}) {
  const runId = newId();
  return {
    fingerprint: FINGERPRINT,
    title: 'Broken access control on /admin',
    class: 'broken_access_control',
    cweId: 'CWE-284',
    owaspCategory: 'A01:2021',
    assetId: newId(),
    location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
    runId,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    ...overrides,
  };
}

describe('FindingRepository tenant context', () => {
  it('fails closed with no ambient tenant, before any SQL', async () => {
    const none = repo(() => undefined);
    const empty = repo(() => '');
    await expect(none.create(validCreate())).rejects.toThrow(TenantContextMissingError);
    await expect(empty.findById(newId())).rejects.toThrow(TenantContextMissingError);
    await expect(none.list()).rejects.toThrow(TenantContextMissingError);
    await expect(none.update(newId(), 0, { status: 'validating' })).rejects.toThrow(
      TenantContextMissingError,
    );
    await expect(none.addOccurrence(validOccurrence())).rejects.toThrow(TenantContextMissingError);
    await expect(none.listOccurrences(newId())).rejects.toThrow(TenantContextMissingError);
  });
});

describe('FindingRepository.create input validation', () => {
  it.each([
    ['an unknown status', { status: 'pwned' }],
    ['an unknown baseline status', { baselineStatus: 'stale' }],
    ['a fingerprint that is not SHA-256 hex', { fingerprint: 'XYZ' }],
    ['an upper-case fingerprint', { fingerprint: 'A'.repeat(64) }],
    ['an empty title', { title: '' }],
    ['a title over the label limit', { title: 'x'.repeat(201) }],
    ['a class that is empty', { class: '' }],
    ['a CWE that does not look like CWE-<n>', { cweId: 'CWE-0' }],
    ['a non-uuid asset', { assetId: 'not-a-uuid' }],
    ['a confidence above 1', { confidence: 1.5 }],
    ['an unknown field (strict)', { tenantId: newId() }],
    ['a location with neither URL template nor file', { location: { method: 'GET' } }],
    [
      'a location with a method only',
      {
        location: { method: 'GET', urlTemplate: null, parameter: null, file: null, line: null },
      },
    ],
    [
      'an oversized location',
      {
        location: {
          method: 'GET',
          urlTemplate: `/${'a'.repeat(9000)}`,
          parameter: null,
          file: null,
          line: null,
        },
      },
    ],
    [
      'an oversized severity',
      {
        severity: {
          cvssV4Vector: `CVSS:4.0/AV:N/${'x'.repeat(5000)}`,
          cvssV4Score: 5,
          cvssV31Vector: null,
        },
      },
    ],
    [
      'a severity that is not a CVSS 4.0 vector',
      { severity: { cvssV4Vector: 'AV:N', cvssV4Score: 5, cvssV31Vector: null } },
    ],
  ])('rejects %s before SQL', async (_label, overrides) => {
    const input = { ...validCreate(), ...overrides };
    await expect(repo().create(input)).rejects.toThrow(ValidationError);
  });

  it('rejects a missing run id before SQL', async () => {
    await expect(repo().create(validCreate({ runId: undefined }))).rejects.toThrow(ValidationError);
  });
});

describe('FindingRepository.update and list input validation', () => {
  it('refuses an empty patch and the fields that only triage may write', async () => {
    const r = repo();
    await expect(r.update(newId(), 0, {})).rejects.toThrow(ValidationError);
    await expect(r.update(newId(), 0, { releasedBy: newId() })).rejects.toThrow(ValidationError);
    await expect(r.update(newId(), 0, { acceptedRisk: { reason: 'x' } })).rejects.toThrow(
      ValidationError,
    );
    await expect(r.update(newId(), 0, { status: 'hacked' })).rejects.toThrow(ValidationError);
  });

  it('refuses a malformed id or a negative or non-integer expected version', async () => {
    const r = repo();
    await expect(r.update('nope', 0, { status: 'validating' })).rejects.toThrow(ValidationError);
    await expect(r.update(newId(), -1, { status: 'validating' })).rejects.toThrow(ValidationError);
    await expect(r.update(newId(), 1.5, { status: 'validating' })).rejects.toThrow(ValidationError);
  });

  it('caps the page size at 200 and refuses a bad status filter', async () => {
    const r = repo();
    await expect(r.list({ limit: 201 })).rejects.toThrow(ValidationError);
    await expect(r.list({ limit: 0 })).rejects.toThrow(ValidationError);
    await expect(r.list({ status: 'nonsense' })).rejects.toThrow(ValidationError);
  });

  it('refuses an occurrence with an invalid evidence chain head', async () => {
    await expect(
      repo().addOccurrence({ ...validOccurrence(), evidenceChainHead: 'not-a-digest' }),
    ).rejects.toThrow(ValidationError);
  });
});

function validOccurrence() {
  return {
    findingId: newId(),
    runId: newId(),
    occurrenceStatus: 'detected',
    detectedAt: new Date('2026-01-02T00:00:00.000Z'),
  };
}
