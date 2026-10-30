import { describe, expect, it, vi } from 'vitest';

import { REDACTED } from '@blackwing/errors';

import {
  ADMIN_A,
  ADMIN_B,
  AUDITOR_A,
  memoryMemberships,
  memoryProfileStore,
  profileOf,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { type TenantProfilePrincipal, TenantProfileService } from './service.js';

import type { TenantProfileMetrics } from './metrics.js';

const ADMIN: TenantProfilePrincipal = { tenantId: TENANT_A, actorId: ADMIN_A };
const memberships = memoryMemberships({
  [TENANT_A]: { [ADMIN_A]: ['org_admin'], [AUDITOR_A]: ['auditor'] },
  [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
});

function build(
  rows: Parameters<typeof memoryProfileStore>[0] = {
    [TENANT_A]: profileOf(),
    [TENANT_B]: profileOf({ name: 'Other' }),
  },
) {
  const store = memoryProfileStore(rows);
  const info = vi.fn();
  const saved = vi.fn<(result: 'ok' | 'error') => void>();
  const metrics: TenantProfileMetrics = { saved };
  const service = new TenantProfileService({ store, memberships, metrics, logger: { info } });
  return { store, service, info, saved };
}

/** Every serialised log argument, so a test can prove that no value reached the log. */
const logged = (info: { readonly mock: { readonly calls: readonly unknown[] } }): string =>
  JSON.stringify(info.mock.calls);

describe('TenantProfileService.get', () => {
  it('returns the profile with defaults applied and a strong ETag', async () => {
    const { service } = build({ [TENANT_A]: profileOf({}, {}) });
    const view = await service.get(ADMIN);
    expect(view.body).toEqual({
      name: 'Acme Security',
      slug: 'acme',
      region: 'eu-west-1',
      plan: 'team',
      status: 'active',
      defaultTimezone: 'UTC',
      supportContactEmail: null,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(view.etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it.each([
    [
      'an auditor (read-only role without settings:read)',
      { tenantId: TENANT_A, actorId: AUDITOR_A },
    ],
    ['a user with no membership in the tenant', { tenantId: TENANT_B, actorId: ADMIN_A }],
    ['a non-UUID actor (fails closed)', { tenantId: TENANT_A, actorId: 'usr_1' }],
  ])('refuses %s with FORBIDDEN_ROLE', async (_label, principal) => {
    const { service } = build();
    await expect(service.get(principal)).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
  });

  it('refuses a tenant that does not exist with NOT_FOUND', async () => {
    const { service } = build({});
    await expect(service.get(ADMIN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('TenantProfileService.update', () => {
  it('renames the organisation, returns the new ETag and writes one audit event', async () => {
    const { service, store, info } = build();
    const etag = (await service.get(ADMIN)).etag;
    const view = await service.update(ADMIN, etag, { name: 'Acme Security Ltd' });
    expect(view.body.name).toBe('Acme Security Ltd');
    expect(view.etag).not.toBe(etag);
    expect(store.audits).toEqual([
      {
        tenantId: TENANT_A,
        actorId: ADMIN_A,
        changes: { name: { from: 'Acme Security', to: 'Acme Security Ltd' } },
      },
    ]);
    expect(logged(info)).toContain('org_settings.updated');
    expect(logged(info)).not.toContain('Acme Security Ltd');
  });

  it('persists a unicode name (RTL, emoji) and trims it', async () => {
    const { service, store } = build();
    const etag = (await service.get(ADMIN)).etag;
    const view = await service.update(ADMIN, etag, { name: '  شركة الأمن 🛡️  ' });
    expect(view.body.name).toBe('شركة الأمن 🛡️');
    expect(store.rows.get(TENANT_A)?.name).toBe('شركة الأمن 🛡️');
  });

  it('changes the display zone, which is the tenant display timezone setting', async () => {
    const { service, store } = build();
    const etag = (await service.get(ADMIN)).etag;
    const view = await service.update(ADMIN, etag, { defaultTimezone: 'Asia/Tokyo' });
    expect(view.body.defaultTimezone).toBe('Asia/Tokyo');
    expect(store.rows.get(TENANT_A)?.settings).toMatchObject({ displayTimezone: 'Asia/Tokyo' });
    expect(store.audits[0]?.changes).toEqual({
      defaultTimezone: { from: 'Europe/Berlin', to: 'Asia/Tokyo' },
    });
  });

  it('redacts the support contact in the audit and keeps it out of the logs', async () => {
    const { service, store, info } = build();
    const etag = (await service.get(ADMIN)).etag;
    const view = await service.update(ADMIN, etag, { supportContactEmail: 'soc@acme.test' });
    expect(view.body.supportContactEmail).toBe('soc@acme.test');
    expect(store.audits[0]?.changes).toEqual({
      supportContactEmail: { from: null, to: REDACTED },
    });
    expect(JSON.stringify(store.audits)).not.toContain('soc@acme.test');
    expect(logged(info)).not.toContain('soc@acme.test');
  });

  it('clears the support contact with an empty string or null, and removes the stored key', async () => {
    const { service, store } = build({
      [TENANT_A]: profileOf({}, { displayTimezone: 'UTC', supportContactEmail: 'soc@acme.test' }),
    });
    const etag = (await service.get(ADMIN)).etag;
    const view = await service.update(ADMIN, etag, { supportContactEmail: '' });
    expect(view.body.supportContactEmail).toBeNull();
    expect(store.rows.get(TENANT_A)?.settings).not.toHaveProperty('supportContactEmail');
    const next = (await service.get(ADMIN)).etag;
    expect(
      (await service.update(ADMIN, next, { supportContactEmail: 'x@acme.test' })).body
        .supportContactEmail,
    ).toBe('x@acme.test');
    const cleared = (await service.get(ADMIN)).etag;
    expect(
      (await service.update(ADMIN, cleared, { supportContactEmail: null })).body
        .supportContactEmail,
    ).toBeNull();
  });

  it('accepts If-Match: * as a precondition that the profile exists', async () => {
    const { service } = build();
    const view = await service.update(ADMIN, '*', { name: 'Star' });
    expect(view.body.name).toBe('Star');
  });

  it('answers an empty or unchanged body as a no-op: no write, no audit, the same ETag', async () => {
    const { service, store } = build();
    const current = await service.get(ADMIN);
    const empty = await service.update(ADMIN, current.etag, {});
    const same = await service.update(ADMIN, current.etag, {
      name: 'Acme Security',
      defaultTimezone: 'Europe/Berlin',
    });
    expect(empty.etag).toBe(current.etag);
    expect(same.etag).toBe(current.etag);
    expect(store.audits).toEqual([]);
  });

  it('refuses a PATCH without If-Match with PRECONDITION_REQUIRED and never runs the mutation', async () => {
    const { service, store } = build();
    await expect(service.update(ADMIN, undefined, { name: 'Late' })).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    });
    expect(store.mutations.count).toBe(0);
  });

  it('refuses a stale ETag with ETAG_MISMATCH and leaves the profile untouched', async () => {
    const { service, store } = build();
    const stale = (await service.get(ADMIN)).etag;
    await service.update(ADMIN, stale, { name: 'First' });
    await expect(service.update(ADMIN, stale, { name: 'Second' })).rejects.toMatchObject({
      code: 'ETAG_MISMATCH',
    });
    expect(store.rows.get(TENANT_A)?.name).toBe('First');
    expect(store.audits).toHaveLength(1);
  });

  it('refuses an If-Match that names no current ETag, even when it lists several', async () => {
    const { service } = build();
    await expect(
      service.update(ADMIN, '"0000000000000000", "1111111111111111"', { name: 'X' }),
    ).rejects.toMatchObject({ code: 'ETAG_MISMATCH' });
  });

  it.each([
    ['an unknown key', { isAdmin: true }],
    ['the read-only slug', { slug: 'other' }],
    ['the read-only region', { region: 'us-east-1' }],
    ['the read-only plan', { plan: 'enterprise' }],
    ['a tenant id from the body', { tenantId: TENANT_B }],
    ['an empty name', { name: '   ' }],
    ['a name with a control character', { name: 'Acme\u0000' }],
    ['an over-long name', { name: 'x'.repeat(121) }],
    ['an unknown time zone', { defaultTimezone: 'Mars/Olympus' }],
    ['a malformed support e-mail', { supportContactEmail: 'not-an-email' }],
  ])('answers VALIDATION_FAILED for %s and writes nothing', async (_label, body) => {
    const { service, store, info } = build();
    const etag = (await service.get(ADMIN)).etag;
    await expect(service.update(ADMIN, etag, body)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(store.mutations.count).toBe(0);
    expect(store.audits).toEqual([]);
    expect(logged(info)).toBe('[]');
  });

  it('keeps submitted values out of the validation detail', async () => {
    const { service } = build();
    const etag = (await service.get(ADMIN)).etag;
    const error = await service
      .update(ADMIN, etag, { supportContactEmail: 'secret-person is not an address' })
      .catch((caught: unknown) => caught);
    expect(JSON.stringify(error)).not.toContain('secret-person');
  });

  it.each([
    ['an auditor (read-only)', { tenantId: TENANT_A, actorId: AUDITOR_A }],
    ['an admin of another tenant', { tenantId: TENANT_A, actorId: ADMIN_B }],
  ])('refuses %s with FORBIDDEN_ROLE and writes nothing', async (_label, principal) => {
    const { service, store, saved } = build();
    const etag = (await service.get(ADMIN)).etag;
    await expect(service.update(principal, etag, { name: 'Nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
    });
    expect(store.rows.get(TENANT_A)?.name).toBe('Acme Security');
    expect(saved).toHaveBeenCalledWith('error');
  });

  it('counts a successful save and a refused one on the save metric', async () => {
    const { service, saved } = build();
    const etag = (await service.get(ADMIN)).etag;
    await service.update(ADMIN, etag, { name: 'Counted' });
    await expect(service.update(ADMIN, etag, { name: 'Stale' })).rejects.toBeDefined();
    expect(saved.mock.calls).toEqual([['ok'], ['error']]);
  });
});
