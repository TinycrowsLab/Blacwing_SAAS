import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import { harness } from './fixtures.test-helpers.js';
import { MAX_ORGANIZATION_DOMAINS } from './organizations.service.js';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER_USER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const UNKNOWN_ORG = '00000000-0000-4000-8000-000000000000';

/** The stable `code` of what `promise` rejects with; `undefined` when it resolves. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'UNKNOWN';
  }
  return undefined;
}

describe('OrganizationsService.createOrganization', () => {
  it('creates the organisation keyed by alias, normalises domains and records an applied audit event', async () => {
    const h = harness();
    const svc = h.service();

    const result = await svc.createOrganization({
      alias: 'acme',
      name: 'Acme Corp',
      domains: ['Acme.COM', 'acme.com', ' corp.example.org '],
    });

    expect(result.created).toBe(true);
    expect(result.organization.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.organization).toEqual({
      id: result.organization.id,
      alias: 'acme',
      displayName: 'Acme Corp',
      domains: ['acme.com', 'corp.example.org'],
    });
    const stored = [...h.keycloak.orgs.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('acme');
    expect(stored[0]?.attributes).toEqual({ displayName: ['Acme Corp'] });
    expect(h.audit.events).toEqual([
      {
        action: 'organization.create',
        outcome: 'applied',
        orgId: result.organization.id,
        alias: 'acme',
      },
    ]);
  });

  it('is a no-op when the alias already exists: same id, no second organisation, unchanged audit', async () => {
    const h = harness();
    const svc = h.service();
    const first = await svc.createOrganization({ alias: 'acme', name: 'Acme' });

    const again = await svc.createOrganization({ alias: 'acme', name: 'Acme renamed' });

    expect(again.created).toBe(false);
    expect(again.organization.id).toBe(first.organization.id);
    expect(h.keycloak.orgs.size).toBe(1);
    expect(h.audit.events.at(-1)).toMatchObject({
      outcome: 'unchanged',
      orgId: first.organization.id,
    });
  });

  it('creates exactly one organisation when two creates for one alias race (the loser reads the winner back)', async () => {
    const h = harness();
    const svc = h.service();
    const [a, b] = await Promise.all([
      svc.createOrganization({ alias: 'acme', name: 'Acme' }),
      svc.createOrganization({ alias: 'acme', name: 'Acme' }),
    ]);

    expect(h.keycloak.orgs.size).toBe(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.organization.id).toBe(b.organization.id);
  });

  it('keeps a similar alias apart: an exact-match lookup never reuses acme2 for acme', async () => {
    const h = harness();
    const svc = h.service();
    const acme2 = await svc.createOrganization({ alias: 'acme2', name: 'Acme 2' });

    const acme = await svc.createOrganization({ alias: 'acme', name: 'Acme' });

    expect(acme.created).toBe(true);
    expect(acme.organization.id).not.toBe(acme2.organization.id);
    expect(h.keycloak.orgs.size).toBe(2);
  });

  it('retries a transient Keycloak failure during the lookup and still creates exactly one organisation', async () => {
    const h = harness();
    const svc = h.service();
    await svc.getByAlias('warm-up'); // warms the token so the next queued status hits the lookup
    h.keycloak.queuedStatuses.push(503);

    const result = await svc.createOrganization({ alias: 'acme', name: 'Acme' });

    expect(result.created).toBe(true);
    expect(h.keycloak.orgs.size).toBe(1);
  });

  it('reports KEYCLOAK_UNAVAILABLE (retryable) when Keycloak stays unreachable', async () => {
    const h = harness();
    h.keycloak.queuedNetworkFailures = 3;
    const error = await h
      .service()
      .createOrganization({ alias: 'acme', name: 'Acme' })
      .catch((e: unknown) => e);
    expect((error as AppError).code).toBe('KEYCLOAK_UNAVAILABLE');
    expect((error as AppError).httpStatus).toBe(503);
    expect((error as AppError).retryable).toBe(true);
    expect(h.keycloak.orgs.size).toBe(0);
  });

  it('refuses invalid input before any Keycloak call (validation, no injection)', async () => {
    const invalid: unknown[] = [
      null,
      'acme',
      { alias: 'Acme', name: 'Acme' },
      { alias: 'a_b', name: 'Acme' },
      { alias: '-acme', name: 'Acme' },
      { alias: 'acme-', name: 'Acme' },
      { alias: '../etc', name: 'Acme' },
      { alias: 'acme/../../x', name: 'Acme' },
      { alias: 'a'.repeat(64), name: 'Acme' },
      { alias: 'acme', name: '' },
      { alias: 'acme', name: '   ' },
      { alias: 'acme', name: 'x'.repeat(201) },
      { alias: 'acme', name: 'Acme', domains: ['not a domain'] },
      { alias: 'acme', name: 'Acme', domains: ['localhost'] },
      { alias: 'acme', name: 'Acme', domains: ['a'.repeat(300) + '.com'] },
      {
        alias: 'acme',
        name: 'Acme',
        domains: Array.from(
          { length: MAX_ORGANIZATION_DOMAINS + 1 },
          (_, i) => `d${i}.example.com`,
        ),
      },
      // Mass assignment: the schema is strict, so an unknown field is refused, not silently stored.
      { alias: 'acme', name: 'Acme', role: 'owner' },
    ];
    for (const input of invalid) {
      const h = harness();
      const error = await h
        .service()
        .createOrganization(input)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect(h.keycloak.calls).toHaveLength(0);
    }
  });

  it('never echoes the rejected value in the client-facing detail', async () => {
    const h = harness();
    const error = await h
      .service()
      .createOrganization({ alias: 'Secret-Value-123', name: 'Acme' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = (error as AppError).detail ?? '';
    expect(detail).toContain('alias');
    expect(detail).not.toContain('Secret-Value-123');
  });
});

describe('OrganizationsService.getByAlias', () => {
  it('returns undefined for an unknown alias and the organisation once created', async () => {
    const h = harness();
    const svc = h.service();
    expect(await svc.getByAlias('acme')).toBeUndefined();
    const created = await svc.createOrganization({
      alias: 'acme',
      name: 'Acme',
      domains: ['acme.com'],
    });
    expect(await svc.getByAlias('acme')).toEqual(created.organization);
  });

  it('refuses a malformed alias before calling Keycloak', async () => {
    const h = harness();
    expect(await codeOf(h.service().getByAlias('../acme'))).toBe('VALIDATION_FAILED');
    expect(h.keycloak.calls).toHaveLength(0);
  });
});

describe('OrganizationsService.update', () => {
  it('updates the display name and domains, keeping the verified flag of a retained domain', async () => {
    const h = harness();
    const svc = h.service();
    const { organization } = await svc.createOrganization({
      alias: 'acme',
      name: 'Acme',
      domains: ['acme.com'],
    });
    const stored = h.keycloak.orgs.get(organization.id);
    if (stored === undefined) throw new Error('fixture: organisation not stored');
    stored.domains[0] = { name: 'acme.com', verified: true };

    const updated = await svc.update(organization.id, {
      displayName: 'Acme Corporation',
      domains: ['acme.com', 'acme.io'],
    });

    expect(updated).toEqual({
      id: organization.id,
      alias: 'acme',
      displayName: 'Acme Corporation',
      domains: ['acme.com', 'acme.io'],
    });
    expect(stored.domains).toEqual([
      { name: 'acme.com', verified: true },
      { name: 'acme.io', verified: false },
    ]);
    expect(h.audit.events.at(-1)).toEqual({
      action: 'organization.update',
      outcome: 'applied',
      orgId: organization.id,
    });
  });

  it('sends no PUT when the values already match (re-applying is a no-op)', async () => {
    const h = harness();
    const svc = h.service();
    const { organization } = await svc.createOrganization({
      alias: 'acme',
      name: 'Acme',
      domains: ['acme.com'],
    });
    const putsBefore = h.keycloak.calls.filter((c) => c.method === 'PUT').length;

    await svc.update(organization.id, { displayName: 'Acme', domains: ['acme.com'] });

    expect(h.keycloak.calls.filter((c) => c.method === 'PUT')).toHaveLength(putsBefore);
    expect(h.audit.events.at(-1)?.outcome).toBe('unchanged');
  });

  it('reports KEYCLOAK_NOT_FOUND for an unknown organisation', async () => {
    const h = harness();
    expect(await codeOf(h.service().update(UNKNOWN_ORG, { displayName: 'x' }))).toBe(
      'KEYCLOAK_NOT_FOUND',
    );
  });

  it('reports KEYCLOAK_CONFLICT when a domain is already claimed by another organisation', async () => {
    const h = harness();
    const svc = h.service();
    await svc.createOrganization({ alias: 'acme', name: 'Acme', domains: ['acme.com'] });
    const beta = await svc.createOrganization({
      alias: 'beta',
      name: 'Beta',
      domains: ['beta.com'],
    });

    expect(await codeOf(svc.update(beta.organization.id, { domains: ['acme.com'] }))).toBe(
      'KEYCLOAK_CONFLICT',
    );
  });

  it('refuses an empty patch, an unknown field and a malformed id before any Keycloak call', async () => {
    const h = harness();
    const svc = h.service();
    expect(await codeOf(svc.update(UNKNOWN_ORG, {}))).toBe('VALIDATION_FAILED');
    expect(await codeOf(svc.update(UNKNOWN_ORG, { alias: 'other' }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(svc.update('x/../../organizations', { displayName: 'x' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(h.keycloak.calls).toHaveLength(0);
  });
});

describe('OrganizationsService.delete', () => {
  it('deletes the organisation; a second delete is a no-op', async () => {
    const h = harness();
    const svc = h.service();
    const { organization } = await svc.createOrganization({ alias: 'acme', name: 'Acme' });

    expect(await svc.delete(organization.id)).toEqual({ changed: true });
    expect(h.keycloak.orgs.size).toBe(0);
    expect(await svc.delete(organization.id)).toEqual({ changed: false });
    // create, then the first delete (applied), then the repeat (unchanged).
    expect(h.audit.events.map((e) => e.outcome)).toEqual(['applied', 'applied', 'unchanged']);
  });

  it('refuses a malformed id before any Keycloak call', async () => {
    const h = harness();
    expect(await codeOf(h.service().delete('not-a-uuid'))).toBe('VALIDATION_FAILED');
    expect(h.keycloak.calls).toHaveLength(0);
  });
});

describe('OrganizationsService members', () => {
  it('adds a member once; adding again is a no-op (Keycloak 409)', async () => {
    const h = harness();
    const svc = h.service();
    const { organization } = await svc.createOrganization({ alias: 'acme', name: 'Acme' });

    expect(await svc.addMember(organization.id, USER)).toEqual({ changed: true });
    expect(await svc.addMember(organization.id, USER)).toEqual({ changed: false });
    expect(h.audit.events.slice(-2)).toEqual([
      {
        action: 'organization.member_add',
        outcome: 'applied',
        orgId: organization.id,
        userId: USER,
      },
      {
        action: 'organization.member_add',
        outcome: 'unchanged',
        orgId: organization.id,
        userId: USER,
      },
    ]);
  });

  it('reports KEYCLOAK_NOT_FOUND when adding to an unknown organisation', async () => {
    const h = harness();
    expect(await codeOf(h.service().addMember(UNKNOWN_ORG, USER))).toBe('KEYCLOAK_NOT_FOUND');
  });

  it('removes a member; removing a non-member is a no-op (Keycloak 404)', async () => {
    const h = harness();
    const svc = h.service();
    const { organization } = await svc.createOrganization({ alias: 'acme', name: 'Acme' });
    await svc.addMember(organization.id, USER);

    expect(await svc.removeMember(organization.id, USER)).toEqual({ changed: true });
    expect(await svc.removeMember(organization.id, OTHER_USER)).toEqual({ changed: false });
  });

  it('refuses malformed ids (no path injection into the member URL) before any Keycloak call', async () => {
    const h = harness();
    const svc = h.service();
    expect(await codeOf(svc.addMember(UNKNOWN_ORG, 'x/../../organizations'))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(svc.removeMember(UNKNOWN_ORG, '../../admin'))).toBe('VALIDATION_FAILED');
    expect(h.keycloak.calls).toHaveLength(0);
  });
});

describe('OrganizationsService audit and partial failures', () => {
  it('a failed audit append surfaces, and the idempotent retry completes the record', async () => {
    const h = harness();
    const svc = h.service();
    h.audit.failWith = new Error('ledger unavailable');

    await expect(svc.createOrganization({ alias: 'acme', name: 'Acme' })).rejects.toThrow(
      'ledger unavailable',
    );
    expect(h.keycloak.orgs.size).toBe(1); // the organisation exists in Keycloak

    h.audit.failWith = undefined;
    const retry = await svc.createOrganization({ alias: 'acme', name: 'Acme' });
    expect(retry.created).toBe(false);
    expect(h.audit.events).toEqual([
      {
        action: 'organization.create',
        outcome: 'unchanged',
        orgId: retry.organization.id,
        alias: 'acme',
      },
    ]);
  });
});
